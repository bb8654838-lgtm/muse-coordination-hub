import * as THREE from "three";

import type { Agent } from "@/lib/dashboard-types";
import type { VisualTransferEvent } from "@/lib/realtime-visual-events";

export type CameraPreset = "overview" | "inspect" | "conversation";
export type PreviewState = "thinking" | "typing" | "reply" | "cancel" | "complete";
export type SceneTransfer = VisualTransferEvent & {
  previewRunId?: string;
  previewState?: PreviewState;
};

export const STAGE_FOV = 38;
export const POOL_CAPACITY = 16;

const HQ_ID = "muse-core";
const MAX_SENTINELS = 10;
const RIBBON_SEGMENTS = 24;
const PACKETS_PER_TRANSFER = 4;
const PACKET_CAPACITY = POOL_CAPACITY * PACKETS_PER_TRANSFER;
const MOBILE_BREAKPOINT = 640;

const CUE_COLORS: Record<string, number> = {
  chat: 0x38d9ff,
  reply: 0xd98cff,
  file: 0xffb54a,
  task: 0x9cf56e,
  done: 0x65ffd0,
  thinking: 0xa78bfa,
  typing: 0x67e8f9,
  presence: 0x6f8aa8,
};

export type EventClassification = {
  mode: "live" | "preview";
  cue: string;
  title: string;
};

export type ResolvedRoute = {
  sourceId: string;
  targetId: string;
  unresolved: boolean;
};

export type Point3 = { x: number; y: number; z: number };
export type BubbleInput = { id: string; x: number; y: number; width: number; height: number };
export type BubblePlacement = { id: string; x: number; y: number; hidden: boolean };

type Viewport = { width: number; height: number; mobile: boolean; pixelRatio: number };
type OverlayEntry = { id: string; element: HTMLElement };
type BubbleOverlayEntry = { id: string; agentId: string; element: HTMLElement };
type StageCallbacks = {
  onSelect: (id: string) => void;
  onViewport: (viewport: Viewport) => void;
  onFollowChange: (enabled: boolean) => void;
  onReady: () => void;
  onError: (error?: unknown) => void;
};

type Rig = {
  root: THREE.Group;
  head: THREE.Group;
  leftArm: THREE.Group;
  rightArm: THREE.Group;
  telemetry: THREE.Mesh[];
  bodyMaterial: THREE.MeshStandardMaterial;
  accentMaterial: THREE.MeshStandardMaterial;
  eyeMaterial: THREE.MeshBasicMaterial;
  glowMaterial: THREE.ShaderMaterial;
  id: string | null;
  target: THREE.Vector3;
  phase: number;
  targetScale: number;
  fitPoints: THREE.Vector3[];
  pedestalBounds: THREE.Box3;
  hardwareBounds: THREE.Box3;
  conduit: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  conduitPositions: Float32Array;
  baseColor: THREE.Color;
  presenceAlpha: number;
  activity: number;
  attentionTargetId: string | null;
  attentionUntil: number;
  attentionRunId?: string;
};

type RibbonSlot = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  positions: Float32Array;
  active: boolean;
  eventId: string;
  runId?: string;
  sourceId: string;
  targetId: string;
  cue: string;
  start: number;
  duration: number;
  sequence: number;
};

const FRESNEL_VERTEX = `
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDirection = normalize(cameraPosition - worldPosition.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

const FRESNEL_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uPulse;
  varying vec3 vNormal;
  varying vec3 vViewDirection;
  void main() {
    float rim = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDirection)), 0.0), 2.35);
    float alpha = rim * (0.28 + 0.18 * uPulse);
    gl_FragColor = vec4(uColor * (1.15 + rim), alpha);
  }
`;

const RIBBON_VERTEX = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  varying vec2 vUv;
  void main() {
    float edge = pow(max(0.0, sin(vUv.y * 3.14159265)), 0.42);
    float pulse = 0.58 + 0.42 * sin((vUv.x * 8.0 - uTime * 4.2) * 3.14159265);
    float spark = smoothstep(0.91, 1.0, sin((vUv.x * 17.0 - uTime * 7.0) * 3.14159265) * 0.5 + 0.5);
    vec3 color = uColor * (1.15 + pulse * 0.65 + spark * 0.7);
    gl_FragColor = vec4(color, edge * uAlpha * (0.55 + pulse * 0.45));
  }
`;

function finite(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function previewRunId(event: SceneTransfer) {
  if (event.previewRunId) return event.previewRunId;
  if (!event.id.startsWith("preview:")) return undefined;
  const parts = event.id.split(":");
  return parts.length > 2 ? parts.slice(1, -1).join(":") : parts[1];
}

export function classifyVisualEvent(event: SceneTransfer): EventClassification {
  const mode: EventClassification["mode"] = event.id.startsWith("preview:") ? "preview" : "live";
  if (mode === "live" && /^(heartbeats|agents|channels):/.test(event.id)) {
    return { mode, cue: "presence", title: "PRESENCE" };
  }

  if (mode === "preview") {
    if (event.previewState === "cancel") return { mode, cue: "cancel", title: "PREVIEW CANCELLED" };
    if (event.previewState === "thinking") return { mode, cue: "thinking", title: "THINKING · PREVIEW" };
    if (event.previewState === "typing") return { mode, cue: "typing", title: "TYPING · PREVIEW" };
    if (event.previewState === "reply") return { mode, cue: "reply", title: "REPLY · PREVIEW" };
    if (event.previewState === "complete") return { mode, cue: "done", title: "COMPLETE · PREVIEW" };
  }

  if (mode === "live" && event.kind === "chat" && typeof event.replyToId === "string" && event.replyToId.trim()) {
    return { mode, cue: "reply", title: "REPLY" };
  }

  if (event.kind === "file") return { mode, cue: "file", title: mode === "preview" ? "HANDOFF · PREVIEW" : "HANDOFF" };
  if (event.kind === "task") return { mode, cue: "task", title: mode === "preview" ? "TASK · PREVIEW" : "TASK" };
  if (event.kind === "done") return { mode, cue: "done", title: mode === "preview" ? "RETURN · PREVIEW" : "RETURN" };
  return { mode, cue: "chat", title: mode === "preview" ? "MESSAGE · PREVIEW" : "MESSAGE" };
}

export function resolveRoute(event: SceneTransfer, knownIds: ReadonlySet<string>): ResolvedRoute {
  const sourceKnown = event.sourceId === HQ_ID || knownIds.has(event.sourceId);
  const targetKnown = event.targetId === HQ_ID || knownIds.has(event.targetId);
  return {
    sourceId: sourceKnown ? event.sourceId : HQ_ID,
    targetId: targetKnown ? event.targetId : HQ_ID,
    unresolved: !sourceKnown || !targetKnown,
  };
}

export type StageLayoutSettings = {
  hero: boolean;
  radius: number;
  radiusX: number;
  radiusZ: number;
  robotScale: number;
  hqScale: number;
  hqX: number;
  hqZ: number;
};

export function stageLayoutSettings(count: number, aspect = 1): StageLayoutSettings {
  const total = clamp(Math.floor(finite(count)), 0, MAX_SENTINELS);
  const hero = total <= 4;
  const radius = hero ? 2 + Math.max(0, total - 1) * (0.8 / 3) : 3.5 + (total - 5) * 0.3;
  return {
    hero, radius,
    radiusX: radius * (hero ? 1 : aspect < 1 ? 0.92 : 1.04),
    radiusZ: radius * (hero ? 1 : aspect < 1 ? 1.04 : 0.83),
    robotScale: hero ? [1.45, 1.45, 1.4, 1.32, 1.25][total] : 1 - (total - 5) * 0.03,
    hqScale: hero ? total <= 2 ? 1.22 : 1.16 : 1,
    hqX: hero && total % 2 === 1 ? -0.62 : 0,
    hqZ: hero && total ? -0.65 : 0,
  };
}

export function layoutAgentPositions(ids: readonly string[], aspect = 1): Map<string, Point3> {
  const ordered = Array.from(new Set(ids)).sort().slice(0, MAX_SENTINELS);
  const positions = new Map<string, Point3>();
  const settings = stageLayoutSettings(ordered.length, aspect);
  const span = ordered.length === 2 ? 1.24 : ordered.length === 3 ? 1.9 : aspect < 1 ? 2.2 : 2.34;
  ordered.forEach((id, index) => {
    const angle = settings.hero
      ? ordered.length === 1 ? 0.6 : -span / 2 + index * span / Math.max(1, ordered.length - 1)
      : index * Math.PI * 2 / ordered.length + Math.PI / ordered.length;
    const stagger = settings.hero ? 1 : index % 2 ? 1.018 : 0.982;
    positions.set(id, {
      x: Math.sin(angle) * settings.radiusX * stagger,
      y: 0,
      z: Math.cos(angle) * settings.radiusZ * stagger,
    });
  });
  return positions;
}

export type FrameMargins = { left: number; right: number; top: number; bottom: number };

/** Perspective-fit actual hardware points, not a padded world-space sphere. */
export function fitCameraToPoints(
  points: readonly Point3[], aspect: number, azimuth = 0, elevation = 0,
  margins: FrameMargins = { left: 0.1, right: 0.1, top: 0.1, bottom: 0.1 },
): { distance: number; target: Point3 } {
  const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z));
  if (!valid.length) return { distance: 7, target: { x: 0, y: 1.15, z: 0 } };
  azimuth = finite(azimuth); elevation = finite(elevation);
  const bounds = new THREE.Box3(), relative = new THREE.Vector3();
  valid.forEach((point) => bounds.expandByPoint(relative.set(point.x, point.y, point.z)));
  const center = bounds.getCenter(new THREE.Vector3());
  const right = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const up = new THREE.Vector3().crossVectors(direction, right);
  const tangentY = Math.tan(THREE.MathUtils.degToRad(STAGE_FOV * 0.5));
  const tangentX = tangentY * Math.max(0.1, finite(aspect, 1));
  const leftLimit = 1 - 2 * clamp(finite(margins.left), 0, 0.35);
  const rightLimit = 1 - 2 * clamp(finite(margins.right), 0, 0.35);
  const topLimit = 1 - 2 * clamp(finite(margins.top), 0, 0.35);
  const bottomLimit = 1 - 2 * clamp(finite(margins.bottom), 0, 0.46);
  let maxRight = -Infinity, minLeft = Infinity, maxTop = -Infinity, minBottom = Infinity, nearest = 0;
  for (const point of valid) {
    relative.set(point.x, point.y, point.z).sub(center);
    const x = relative.dot(right), y = relative.dot(up), depth = relative.dot(direction);
    nearest = Math.max(nearest, depth);
    maxRight = Math.max(maxRight, x + rightLimit * depth * tangentX);
    minLeft = Math.min(minLeft, x - leftLimit * depth * tangentX);
    maxTop = Math.max(maxTop, y + topLimit * depth * tangentY);
    minBottom = Math.min(minBottom, y - bottomLimit * depth * tangentY);
  }
  // Feasible optical-center intervals give the closest safe camera, even at oblique angles.
  const distance = Math.max(3.2, nearest + 0.35,
    (maxRight - minLeft) / ((rightLimit + leftLimit) * tangentX),
    (maxTop - minBottom) / ((topLimit + bottomLimit) * tangentY)) * 1.018;
  const offsetX = (maxRight - rightLimit * distance * tangentX + minLeft + leftLimit * distance * tangentX) * 0.5;
  const offsetY = (maxTop - topLimit * distance * tangentY + minBottom + bottomLimit * distance * tangentY) * 0.5;
  center.addScaledVector(right, offsetX).addScaledVector(up, offsetY);
  return { distance, target: { x: center.x, y: center.y, z: center.z } };
}

function boxCorners(bounds: THREE.Box3): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) points.push(new THREE.Vector3(x, y, z));
  return points;
}

export function computeFitDistance(bounds: THREE.Box3, aspect: number, azimuth = 0, elevation = 0): number {
  const center = bounds.getCenter(new THREE.Vector3());
  const right = new THREE.Vector3(Math.cos(azimuth), 0, -Math.sin(azimuth));
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const up = new THREE.Vector3().crossVectors(direction, right);
  const tangentY = Math.tan(THREE.MathUtils.degToRad(STAGE_FOV * 0.5)) * 0.8;
  const tangentX = tangentY * Math.max(0.1, finite(aspect, 1));
  let distance = 3.2;
  for (const point of boxCorners(bounds)) {
    point.sub(center);
    distance = Math.max(distance, point.dot(direction) + Math.max(Math.abs(point.dot(right)) / tangentX, Math.abs(point.dot(up)) / tangentY) + 0.35);
  }
  return distance * 1.018;
}


export type ScreenRect = { x: number; y: number; width: number; height: number };
export type DockLabelInput = BubbleInput & { minY: number };

function overlaps(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) {
  const gap = 7;
  return !(
    a.x + a.width + gap <= b.x ||
    b.x + b.width + gap <= a.x ||
    a.y + a.height + gap <= b.y ||
    b.y + b.height + gap <= a.y
  );
}

export function placeBubbles(
  items: readonly BubbleInput[],
  viewport: { width: number; height: number },
  limit = items.length,
  obstacles: readonly ScreenRect[] = [],
): BubblePlacement[] {
  const viewportWidth = Math.max(0, finite(viewport.width));
  const viewportHeight = Math.max(0, finite(viewport.height));
  const visibleLimit = Math.max(0, Math.min(items.length, Math.floor(finite(limit))));
  const occupied: ScreenRect[] = [...obstacles];
  const placements: BubblePlacement[] = [];

  items.forEach((item, index) => {
    const width = Math.max(0, finite(item.width));
    const height = Math.max(0, finite(item.height));
    const maxX = Math.max(0, viewportWidth - width);
    const maxY = Math.max(0, viewportHeight - height);
    const baseX = clamp(finite(item.x), 0, maxX);
    const baseY = clamp(finite(item.y), 0, maxY);
    if (index >= visibleLimit || width > viewportWidth || height > viewportHeight) {
      placements.push({ id: item.id, x: baseX, y: baseY, hidden: true });
      return;
    }

    const candidates: Array<{ x: number; y: number }> = [];
    const addCandidate = (x: number, y: number) => {
      const candidate = { x: clamp(x, 0, maxX), y: clamp(y, 0, maxY) };
      if (!candidates.some((value) => Math.abs(value.x - candidate.x) < 0.5 && Math.abs(value.y - candidate.y) < 0.5)) {
        candidates.push(candidate);
      }
    };
    addCandidate(baseX, baseY);
    for (let ring = 1; ring <= 5; ring += 1) {
      const vertical = ring * (height + 9);
      const horizontal = ring * (width + 9);
      addCandidate(baseX, baseY + vertical);
      addCandidate(baseX, baseY - vertical);
      addCandidate(baseX + horizontal, baseY);
      addCandidate(baseX - horizontal, baseY);
    }
    for (let y = 0; y <= maxY; y += Math.max(12, height + 8)) {
      for (let x = 0; x <= maxX; x += Math.max(12, width + 8)) addCandidate(x, y);
    }
    addCandidate(maxX, maxY);

    const selected = candidates.find((candidate) => {
      const rect = { ...candidate, width, height };
      return occupied.every((other) => !overlaps(rect, other));
    });
    if (!selected) {
      placements.push({ id: item.id, x: baseX, y: baseY, hidden: true });
      return;
    }
    occupied.push({ ...selected, width, height });
    placements.push({ id: item.id, ...selected, hidden: false });
  });

  return placements;
}

export function placeDockLabels(items: readonly DockLabelInput[], viewport: { width: number; height: number }, obstacles: readonly ScreenRect[] = []): BubblePlacement[] {
  const occupied: ScreenRect[] = [...obstacles];
  const placements = new Map<string, BubblePlacement>();
  const ordered = [...items].sort((a, b) => b.minY - a.minY || a.x - b.x || a.id.localeCompare(b.id));
  const agentWidth = Math.max(1, ...items.filter((item) => item.id !== HQ_ID).map((item) => item.width));
  const columns = Math.max(1, Math.floor((viewport.width - 1) / (agentWidth + 9)));
  const cellWidth = (viewport.width - 10 - (columns - 1) * 9) / columns;
  const packed = (items.length >= columns && items.length > 1) || items.reduce((sum, item) => sum + item.width, 0) + Math.max(0, items.length - 1) * 9 > viewport.width - 10;
  for (const item of ordered) {
    const width = Math.max(0, finite(item.width));
    const height = Math.max(0, finite(item.height));
    const minY = Math.max(5, finite(item.minY));
    const maxX = viewport.width - width - 5;
    const maxY = viewport.height - height - 5;
    const candidates: Array<{ x: number; y: number; cost: number }> = [];
    if (maxX >= 5 && maxY >= minY) {
      const add = (x: number, y: number) => {
        if (y < minY || y > maxY) return;
        const clampedX = clamp(x, 5, maxX);
        candidates.push({ x: clampedX, y, cost: Math.abs(clampedX - item.x) + (y - minY) * 1.1 });
      };
      const rows = new Set<number>();
      for (let row = 0; row <= 6; row += 1) rows.add(minY + row * (height + 9));
      // Different dock depths need shared row edges, not incompatible per-label grids.
      occupied.forEach((other) => rows.add(Math.max(minY, other.y + other.height + 9)));
      for (const y of rows) {
        if (packed) {
          for (let column = 0; column < columns; column += 1) add(5 + column * (cellWidth + 9) + (cellWidth - width) / 2, y);
        } else {
          for (const shift of [0, -10, 10, -(width + 9), width + 9, -(width + 9) / 2, (width + 9) / 2]) add(item.x + shift, y);
          for (let x = 5; x <= maxX; x += width + 9) add(x, y);
          occupied.forEach((other) => { add(other.x + other.width + 9, y); add(other.x - width - 9, y); });
          add(maxX, y);
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost);
    const selected = candidates.find((candidate) => occupied.every((other) => !overlaps({ ...candidate, width, height }, other)));
    if (selected) occupied.push({ ...selected, width, height });
    placements.set(item.id, { id: item.id, x: selected?.x ?? finite(item.x), y: selected?.y ?? minY, hidden: !selected });
  }
  return items.map((item) => placements.get(item.id)!);
}

function createFresnelMaterial(color: THREE.ColorRepresentation) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uPulse: { value: 0 },
    },
    vertexShader: FRESNEL_VERTEX,
    fragmentShader: FRESNEL_FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function createRibbonGeometry() {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(RIBBON_SEGMENTS * 2 * 3);
  const uvs = new Float32Array(RIBBON_SEGMENTS * 2 * 2);
  const indices: number[] = [];
  for (let index = 0; index < RIBBON_SEGMENTS; index += 1) {
    const fraction = index / (RIBBON_SEGMENTS - 1);
    uvs[index * 4] = fraction;
    uvs[index * 4 + 1] = 0;
    uvs[index * 4 + 2] = fraction;
    uvs[index * 4 + 3] = 1;
    if (index < RIBBON_SEGMENTS - 1) {
      const left = index * 2;
      indices.push(left, left + 1, left + 2, left + 1, left + 3, left + 2);
    }
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return { geometry, positions };
}

function colorForAgent(index: number) {
  const colors = [0x4bdcff, 0xa78bfa, 0x5eead4, 0xf9a8d4, 0x93c5fd, 0xfbbf24, 0xc4b5fd, 0x67e8f9, 0x86efac, 0xf0abfc];
  return colors[index % colors.length];
}

function bevelledBox(width: number, height: number, depth: number, radius = 0.07): THREE.BufferGeometry {
  const x = width / 2, y = height / 2;
  const r = Math.min(radius, x * 0.45, y * 0.45);
  const shape = new THREE.Shape();
  shape.moveTo(-x + r, -y);
  shape.lineTo(x - r, -y); shape.quadraticCurveTo(x, -y, x, -y + r);
  shape.lineTo(x, y - r); shape.quadraticCurveTo(x, y, x - r, y);
  shape.lineTo(-x + r, y); shape.quadraticCurveTo(-x, y, -x, y - r);
  shape.lineTo(-x, -y + r); shape.quadraticCurveTo(-x, -y, -x + r, -y);
  const bevel = Math.min(0.025, depth * 0.2);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: depth - bevel * 2, bevelEnabled: true, bevelSegments: 2, steps: 1, bevelSize: bevel, bevelThickness: bevel, curveSegments: 4 });
  geometry.center(); geometry.computeVertexNormals();
  return geometry;
}

type HardwarePart = { geometry: THREE.BufferGeometry; position?: [number, number, number]; rotation?: [number, number, number]; scale?: [number, number, number] };

/** Merge stationary plates once; all ten pooled rigs share these buffers. */
function mergeHardware(parts: readonly HardwarePart[]): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (const part of parts) {
    const geometry = part.geometry.clone();
    geometry.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...(part.position ?? [0, 0, 0])), new THREE.Quaternion().setFromEuler(new THREE.Euler(...(part.rotation ?? [0, 0, 0]))), new THREE.Vector3(...(part.scale ?? [1, 1, 1]))));
    if (!geometry.getAttribute("normal")) geometry.computeVertexNormals();
    const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
    const offset = positions.length / 3;
    for (let index = 0; index < position.count; index += 1) {
      positions.push(position.getX(index), position.getY(index), position.getZ(index));
      normals.push(normal.getX(index), normal.getY(index), normal.getZ(index));
      uvs.push(uv?.getX(index) ?? 0, uv?.getY(index) ?? 0);
    }
    const index = geometry.getIndex();
    for (let cursor = 0; cursor < (index?.count ?? position.count); cursor += 1) indices.push(offset + (index ? index.getX(cursor) : cursor));
    geometry.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  merged.setIndex(indices); merged.computeBoundingBox(); merged.computeBoundingSphere();
  return merged;
}

export function createContactShadowTexture(): THREE.DataTexture {
  const size = 64, data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const distance = Math.hypot((x + 0.5) / size * 2 - 1, (y + 0.5) / size * 2 - 1);
    data[(y * size + x) * 4 + 3] = Math.round(Math.pow(Math.max(0, 1 - distance), 1.8) * 170);
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter; texture.minFilter = THREE.LinearFilter; texture.needsUpdate = true;
  return texture;
}

function hardwareFitPoints(root: THREE.Group): THREE.Vector3[] {
  root.updateMatrixWorld(true);
  const inverse = root.matrixWorld.clone().invert(), points: THREE.Vector3[] = [];
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || object.userData.ignoreFit) return;
    object.geometry.computeBoundingBox();
    if (!object.geometry.boundingBox) return;
    const matrix = new THREE.Matrix4().multiplyMatrices(inverse, object.matrixWorld);
    boxCorners(object.geometry.boundingBox.clone().expandByScalar(0.035)).forEach((point) => points.push(point.applyMatrix4(matrix)));
  });
  return points;
}

const CONDUIT_FRAGMENT = `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uAlpha;
  uniform float uSurge;
  varying vec2 vUv;
  void main() {
    float edge = pow(max(0.0, 1.0 - abs(vUv.y * 2.0 - 1.0)), 1.35);
    float wave = pow(0.5 + 0.5 * sin(vUv.x * 38.0 - uTime * 9.0), 5.0);
    gl_FragColor = vec4(uColor * (0.8 + uSurge * 1.5), edge * uAlpha * (0.32 + uSurge * (0.55 + wave * 0.55)));
  }
`;

export class SentinelStage {
  private readonly host: HTMLElement;
  private readonly callbacks: StageCallbacks;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(STAGE_FOV, 1, 0.1, 300);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly clock = new THREE.Clock();
  private readonly rigs: Rig[] = [];
  private readonly rigById = new Map<string, Rig>();
  private readonly ribbons: RibbonSlot[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly cameraTarget = new THREE.Vector3();
  private readonly desiredCameraPosition = new THREE.Vector3();
  private readonly desiredCameraTarget = new THREE.Vector3();
  private readonly temporaryPoint = new THREE.Vector3();
  private readonly temporaryMatrix = new THREE.Matrix4();
  private readonly packetObject = new THREE.Object3D();
  private readonly hq = new THREE.Group();
  private readonly packetInstances: THREE.InstancedMesh;
  private readonly disposableGeometries = new Set<THREE.BufferGeometry>();
  private readonly disposableMaterials = new Set<THREE.Material>();
  private readonly geometryCache = new Map<string, THREE.BufferGeometry>();
  private readonly hardwareMaterials = new Map<string, THREE.MeshPhysicalMaterial>();
  private environmentTarget: THREE.WebGLRenderTarget | null = null;
  private contactShadowTexture: THREE.DataTexture | null = null;
  private readonly overlaySizes = new Map<HTMLElement, { width: number; height: number }>();
  private readonly hqTarget = new THREE.Vector3();
  private hqTargetScale = 1.22;
  private hqFitPoints: THREE.Vector3[] = [];
  private readonly hqBounds = new THREE.Box3();
  private readonly cameraFitPool: THREE.Vector3[] = [];
  private readonly conduitSource = new THREE.Vector3();
  private readonly conduitTarget = new THREE.Vector3();
  private readonly ribbonSource = new THREE.Vector3();
  private readonly ribbonTarget = new THREE.Vector3();
  private readonly overlayPoint = new THREE.Vector3();
  private readonly hqPedestalBounds = new THREE.Box3(new THREE.Vector3(-1.12, 0, -1.12), new THREE.Vector3(1.12, 0.35, 1.12));
  private fleetReady = false;
  private layoutTransition = false;
  private snapCamera = false;
  private lastConversation: { sourceId: string; targetId: string } | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private labels: OverlayEntry[] = [];
  private bubbles: BubbleOverlayEntry[] = [];
  private frameHandle: number | null = null;
  private width = 1;
  private height = 1;
  private mobile = false;
  private disposed = false;
  private reducedMotion = false;
  private selectedId: string | null = null;
  private preset: CameraPreset = "overview";
  private followTransfer = false;
  private azimuth = 0;
  private elevation = 0.28;
  private zoomScale = 1;
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;
  private dragDistance = 0;
  private effectSequence = 0;
  private renderedFrames = 0;
  private lastFrameTime = 0;
  private lastViewportSignature = "";
  private lastOverlaySignature = "";

  constructor(host: HTMLElement, callbacks: StageCallbacks) {
    this.host = host;
    this.callbacks = callbacks;
    try {
      this.renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
        preserveDrawingBuffer: false,
      });
    } catch (error) {
      callbacks.onError(error);
      throw error;
    }

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.setClearColor(0x050812, 0);
    this.renderer.domElement.className = "sentinel-webgl-canvas";
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("aria-label", "Interactive Muse Sentinel network");
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.touchAction = "none";
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x050812);
    this.scene.fog = new THREE.FogExp2(0x07101f, 0.024);
    this.camera.position.set(0, 9, 15);
    this.camera.lookAt(0, 0.9, 0);

    try {
      this.buildEnvironment();
      for (let index = 0; index < MAX_SENTINELS; index += 1) this.rigs.push(this.buildRig(index));
      for (let index = 0; index < POOL_CAPACITY; index += 1) this.ribbons.push(this.buildRibbon());
    } catch (error) {
      this.dispose();
      throw error;
    }

    const packetGeometry = new THREE.IcosahedronGeometry(0.075, 0);
    const packetMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, toneMapped: false });
    this.disposableGeometries.add(packetGeometry);
    this.disposableMaterials.add(packetMaterial);
    this.packetInstances = new THREE.InstancedMesh(packetGeometry, packetMaterial, PACKET_CAPACITY);
    this.packetInstances.name = "Pooled telemetry packets";
    this.packetInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.packetInstances.count = 0;
    this.packetInstances.frustumCulled = false;
    this.scene.add(this.packetInstances);

    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointercancel", this.onPointerCancel);
    this.renderer.domElement.addEventListener("wheel", this.onWheel, { passive: false });
    this.renderer.domElement.addEventListener("webglcontextlost", this.onContextLost);
    document.addEventListener("visibilitychange", this.onVisibilityChange);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(host);
    } else {
      window.addEventListener("resize", this.resize);
    }
    this.resize();
    this.renderFrame(performance.now(), true);
    this.scheduleFrame();
    queueMicrotask(() => {
      if (!this.disposed) this.callbacks.onReady();
    });
  }

  syncAgents(agents: readonly Agent[]) {
    const incoming = agents.filter((agent) => agent.status !== "revoked").slice(0, MAX_SENTINELS);
    const incomingIds = new Set(incoming.map((agent) => agent.id));
    for (const [id, rig] of this.rigById) {
      if (incomingIds.has(id)) continue;
      this.rigById.delete(id); rig.id = null; rig.root.visible = false; rig.conduit.visible = false;
      rig.root.userData.agentId = undefined; rig.activity = 0; rig.attentionUntil = 0;
    }
    incoming.forEach((agent) => {
      let rig = this.rigById.get(agent.id);
      let fresh = false;
      if (!rig) {
        rig = this.rigs.find((candidate) => candidate.id === null);
        if (!rig) return;
        fresh = true; rig.id = agent.id; rig.root.visible = true; rig.conduit.visible = true;
        rig.root.userData.agentId = agent.id; this.rigById.set(agent.id, rig);
      }
      const statusColor = agent.status === "online" ? 0x66dce9 : agent.status === "idle" ? 0xf6c65b : 0x738399;
      rig.baseColor.setHex(statusColor);
      rig.presenceAlpha = agent.status === "online" ? 0.58 : agent.status === "idle" ? 0.4 : 0.22;
      rig.accentMaterial.color.copy(rig.baseColor); rig.accentMaterial.emissive.copy(rig.baseColor);
      rig.eyeMaterial.color.copy(rig.baseColor);
      (rig.glowMaterial.uniforms.uColor.value as THREE.Color).copy(rig.baseColor);
      rig.root.userData.fresh = fresh;
    });
    this.layoutFleet(Array.from(incomingIds));
    if (this.selectedId && !this.rigById.has(this.selectedId)) this.selectedId = null;
    this.updateCameraGoal(); this.requestRender();
  }

  /** Set a history-only conversation target without receiving/replaying that event. */
  setConversationRoute(event: SceneTransfer | undefined) {
    if (!event) return;
    const route = resolveRoute(event, new Set(this.rigById.keys()));
    if (this.lastConversation?.sourceId === route.sourceId && this.lastConversation.targetId === route.targetId) return;
    this.lastConversation = { sourceId: route.sourceId, targetId: route.targetId };
    if (this.preset === "conversation") { this.updateCameraGoal(); this.requestRender(); }
  }

  setReducedMotion(reduced: boolean) {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    if (reduced) {
      this.cancelFrame(); this.layoutTransition = false; this.updateCameraGoal();
      this.renderFrame(performance.now(), true);
    } else {
      this.clock.getDelta(); this.lastFrameTime = performance.now(); this.scheduleFrame();
    }
  }

  setSelected(id: string | null) {
    this.selectedId = id && this.rigById.has(id) ? id : null;
    this.rigs.forEach((rig) => {
      const selected = Boolean(rig.id && rig.id === this.selectedId);
      rig.telemetry.forEach((ring, index) => ring.scale.setScalar(selected ? 1.08 + index * 0.04 : 1));
    });
    this.updateCameraGoal();
    this.requestRender();
  }

  receive(event: SceneTransfer) {
    const classification = classifyVisualEvent(event);
    const runId = previewRunId(event);
    if (classification.cue === "cancel") {
      if (runId) this.cancelPreview(runId);
      return;
    }
    const knownIds = new Set(this.rigById.keys());
    const route = resolveRoute(event, knownIds);
    if (classification.cue === "presence") {
      const rig = this.rigById.get(route.sourceId);
      if (rig) rig.phase += 0.9;
      this.requestRender();
      return;
    }

    const slot = this.ribbons.find((candidate) => !candidate.active) ?? this.ribbons.reduce((oldest, candidate) => candidate.sequence < oldest.sequence ? candidate : oldest);
    this.lastConversation = { sourceId: route.sourceId, targetId: route.targetId };
    for (const [id, otherId] of [[route.sourceId, route.targetId], [route.targetId, route.sourceId]]) {
      const rig = this.rigById.get(id);
      if (!rig) continue;
      rig.attentionTargetId = otherId;
      rig.attentionUntil = performance.now() + Math.max(450, finite(event.durationMs, 1400));
      rig.attentionRunId = runId;
    }
    slot.active = true;
    slot.eventId = event.id;
    slot.runId = runId;
    slot.sourceId = route.sourceId;
    slot.targetId = route.targetId;
    slot.cue = classification.cue;
    slot.start = performance.now();
    slot.duration = Math.max(450, finite(event.durationMs, 1400));
    slot.sequence = ++this.effectSequence;
    slot.mesh.visible = true;
    const color = CUE_COLORS[classification.cue] ?? CUE_COLORS.chat;
    (slot.mesh.material.uniforms.uColor.value as THREE.Color).setHex(color);
    slot.mesh.material.uniforms.uAlpha.value = route.unresolved ? 0.72 : 0.92;
    if (this.followTransfer) this.updateCameraGoal();
    this.requestRender();
  }

  cancelPreview(runId: string) {
    for (const slot of this.ribbons) {
      if (slot.active && (slot.runId === runId || slot.eventId.startsWith(`preview:${runId}:`))) this.deactivateRibbon(slot);
    }
    this.rigs.forEach((rig) => {
      if (rig.attentionRunId !== runId) return;
      rig.attentionUntil = 0; rig.attentionTargetId = null; rig.attentionRunId = undefined; rig.activity = 0;
      rig.conduit.material.uniforms.uSurge.value = 0;
    });
    this.requestRender();
  }

  setPreset(preset: CameraPreset) {
    this.preset = preset;
    this.updateCameraGoal();
    this.requestRender();
  }

  setFollowTransfer(enabled: boolean) {
    if (this.followTransfer === enabled) return;
    this.followTransfer = enabled;
    this.callbacks.onFollowChange(enabled);
    if (enabled) this.updateCameraGoal();
    this.requestRender();
  }

  zoom(direction: "in" | "out") {
    this.releaseFollow();
    this.zoomScale = clamp(this.zoomScale * (direction === "in" ? 0.86 : 1.16), 0.58, 1.72);
    this.updateCameraGoal();
    this.requestRender();
  }

  registerOverlays(overlays: { labels: OverlayEntry[]; bubbles: BubbleOverlayEntry[] }) {
    this.labels = overlays.labels;
    this.bubbles = overlays.bubbles;
    this.measureOverlays();
    this.updateCameraGoal();
    this.positionOverlays();
  }

  getDiagnostics() {
    return {
      sentinels: this.rigById.size,
      activeTransfers: this.ribbons.filter((slot) => slot.active).length,
      ribbonPool: this.ribbons.length,
      packetCapacity: PACKET_CAPACITY,
      renderedFrames: this.renderedFrames,
      reducedMotion: this.reducedMotion,
      hidden: document.hidden,
      preset: this.preset,
      followTransfer: this.followTransfer,
      renderer: {
        geometries: this.renderer.info.memory.geometries,
        textures: this.renderer.info.memory.textures,
        calls: this.renderer.info.render.calls,
      },
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelFrame();
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.resize);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    this.scene.environment = null;
    this.environmentTarget?.dispose(); this.environmentTarget = null;
    this.contactShadowTexture?.dispose(); this.contactShadowTexture = null;
    this.packetInstances?.dispose();
    this.disposableGeometries.forEach((geometry) => geometry.dispose());
    this.disposableMaterials.forEach((material) => material.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.labels = [];
    this.bubbles = [];
    this.rigById.clear(); this.overlaySizes.clear(); this.geometryCache.clear(); this.hardwareMaterials.clear(); this.cameraFitPool.length = 0;
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    const existing = this.geometryCache.get(key);
    if (existing) return existing;
    const geometry = create();
    this.geometryCache.set(key, geometry); this.disposableGeometries.add(geometry);
    return geometry;
  }

  private hardwareMaterial(key: "titanium" | "ceramic"): THREE.MeshPhysicalMaterial {
    const existing = this.hardwareMaterials.get(key);
    if (existing) return existing;
    const material = new THREE.MeshPhysicalMaterial(key === "titanium"
      ? { color: 0x344356, metalness: 0.78, roughness: 0.3, clearcoat: 0.6, clearcoatRoughness: 0.18, envMapIntensity: 1.3 }
      : { color: 0x9caec1, metalness: 0.24, roughness: 0.32, clearcoat: 0.85, clearcoatRoughness: 0.2, envMapIntensity: 1.1 });
    this.hardwareMaterials.set(key, material); this.disposableMaterials.add(material);
    return material;
  }

  private contactShadow(scale: number): THREE.Mesh {
    const material = new THREE.MeshBasicMaterial({ map: this.contactShadowTexture, transparent: true, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -1 });
    this.disposableMaterials.add(material);
    const mesh = new THREE.Mesh(this.geometry("contact-shadow", () => new THREE.PlaneGeometry(2.1, 1.9)), material);
    mesh.rotation.x = -Math.PI / 2; mesh.position.y = 0.012; mesh.scale.setScalar(scale);
    mesh.userData.ignoreFit = true; mesh.name = "Baked docking contact shadow";
    return mesh;
  }

  private captureStudioEnvironment() {
    // A single procedural capture, not a downloaded HDRI or per-frame shadow/bloom pass.
    const studio = new THREE.Scene();
    const geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
    const backdrop = new THREE.SphereGeometry(22, 24, 12);
    const backdropMaterial = new THREE.MeshBasicMaterial({ color: 0x526176, side: THREE.BackSide });
    geometries.push(backdrop); materials.push(backdropMaterial);
    studio.add(new THREE.Mesh(backdrop, backdropMaterial));
    const softbox = (position: [number, number, number], width: number, height: number, color: [number, number, number]) => {
      const geometry = new THREE.PlaneGeometry(width, height);
      const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(...color), side: THREE.DoubleSide });
      geometries.push(geometry); materials.push(material);
      const panel = new THREE.Mesh(geometry, material);
      panel.position.set(...position); panel.lookAt(0, 1, 0); studio.add(panel);
    };
    softbox([-5, 5, 7], 5, 8, [4.2, 3.8, 3.4]);
    softbox([6, 2, 4], 4, 6, [1.35, 1.8, 2.7]);
    softbox([-2, 4, -7], 4, 7, [2.8, 1.7, 4.4]);
    softbox([0, 9, 0], 6, 6, [2.2, 2.4, 2.8]);
    const generator = new THREE.PMREMGenerator(this.renderer);
    try {
      this.environmentTarget = generator.fromScene(studio, 0.035, 0.1, 60);
      this.scene.environment = this.environmentTarget.texture;
    } finally {
      generator.dispose(); geometries.forEach((geometry) => geometry.dispose()); materials.forEach((material) => material.dispose());
    }
    this.contactShadowTexture = createContactShadowTexture();
  }

  private buildEnvironment() {
    const hemisphere = new THREE.HemisphereLight(0xa6c6e8, 0x171227, 0.75);
    const key = new THREE.DirectionalLight(0xffeadb, 3.1);
    key.position.set(-4, 7, 7);
    const fill = new THREE.DirectionalLight(0x97c9ff, 1.3);
    fill.position.set(6, 3, 4);
    const rim = new THREE.DirectionalLight(0xb68aff, 2.5);
    rim.position.set(-1, 5, -6);
    this.scene.add(hemisphere, key, fill, rim);
    this.captureStudioEnvironment();

    const floorGeometry = new THREE.CircleGeometry(10.8, 64);
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x091526, metalness: 0.64, roughness: 0.6, transparent: true, opacity: 0.9 });
    this.disposableGeometries.add(floorGeometry);
    this.disposableMaterials.add(floorMaterial);
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.04;
    this.scene.add(floor);

    const grid = new THREE.GridHelper(21, 28, 0x385d88, 0x18314d);
    grid.position.y = 0.005;
    const gridMaterial = grid.material as THREE.Material;
    gridMaterial.transparent = true;
    gridMaterial.opacity = 0.18;
    this.disposableMaterials.add(gridMaterial);
    this.disposableGeometries.add(grid.geometry);
    this.scene.add(grid);

    const starPositions = new Float32Array(210 * 3);
    for (let index = 0; index < 210; index += 1) {
      const angle = index * 2.399963229728653;
      const radius = 7 + (index % 23) * 0.53;
      starPositions[index * 3] = Math.cos(angle) * radius;
      starPositions[index * 3 + 1] = 2.4 + ((index * 17) % 37) * 0.29;
      starPositions[index * 3 + 2] = Math.sin(angle) * radius;
    }
    const starsGeometry = new THREE.BufferGeometry();
    starsGeometry.setAttribute("position", new THREE.BufferAttribute(starPositions, 3));
    const starsMaterial = new THREE.PointsMaterial({ color: 0x86bfff, size: 0.035, transparent: true, opacity: 0.5, depthWrite: false });
    this.disposableGeometries.add(starsGeometry);
    this.disposableMaterials.add(starsMaterial);
    this.scene.add(new THREE.Points(starsGeometry, starsMaterial));

    const pedestal = this.geometry("hq-pedestal", () => new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(1.03, 0), new THREE.Vector2(1.12, 0.07), new THREE.Vector2(1.12, 0.24), new THREE.Vector2(0.99, 0.35), new THREE.Vector2(0, 0.35)], 40));
    const coreGeometry = this.geometry("hq-sculpted-reactor", () => new THREE.LatheGeometry([new THREE.Vector2(0.18, 0), new THREE.Vector2(0.38, 0.13), new THREE.Vector2(0.57, 0.42), new THREE.Vector2(0.62, 0.74), new THREE.Vector2(0.48, 1.05), new THREE.Vector2(0.25, 1.3), new THREE.Vector2(0.07, 1.42)], 24));
    const coreMaterial = new THREE.MeshPhysicalMaterial({ color: 0x956bd1, emissive: 0x653ca0, emissiveIntensity: 0.42, metalness: 0.62, roughness: 0.21, clearcoat: 0.9, clearcoatRoughness: 0.16, envMapIntensity: 1.3 });
    const glow = createFresnelMaterial(0xbf8cff);
    this.disposableMaterials.add(coreMaterial); this.disposableMaterials.add(glow);
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.position.y = 0.55; core.userData.reactorCore = true;
    const crown = new THREE.Mesh(this.geometry("hq-crown", () => new THREE.OctahedronGeometry(0.43, 0)), coreMaterial);
    crown.position.y = 2.09; crown.scale.set(0.85, 1.18, 0.85); crown.userData.reactorCore = true;
    const shell = new THREE.Mesh(coreGeometry, glow);
    shell.position.copy(core.position); shell.scale.set(1.055, 1.02, 1.055);
    this.hq.add(this.contactShadow(1.7), new THREE.Mesh(pedestal, this.hardwareMaterial("titanium")), core, crown, shell);
    const dockGlowMaterial = new THREE.MeshBasicMaterial({ color: 0xba8bff, toneMapped: false });
    this.disposableMaterials.add(dockGlowMaterial);
    const dockGlow = new THREE.Mesh(this.geometry("hq-dock-light", () => new THREE.TorusGeometry(1.075, 0.028, 8, 48)), dockGlowMaterial);
    dockGlow.rotation.x = Math.PI / 2; dockGlow.position.y = 0.26; this.hq.add(dockGlow);
    for (let index = 0; index < 3; index += 1) {
      const geometry = this.geometry(`hq-gyro-${index}`, () => new THREE.TorusGeometry(0.79 + index * 0.17, 0.035, 8, 48));
      const ring = new THREE.Mesh(geometry, coreMaterial);
      ring.position.y = 0.83 + index * 0.4; ring.rotation.x = Math.PI / 2 + index * 0.34; ring.rotation.y = index * 0.8;
      ring.userData.hqRing = index; this.hq.add(ring);
    }
    const reactorLight = new THREE.PointLight(0xb38aff, 4, 7, 2);
    reactorLight.position.y = 1.8; this.hq.add(reactorLight);
    this.hq.name = "Muse Reactor Dock HQ";
    this.hqFitPoints = hardwareFitPoints(this.hq);
    this.hqBounds.setFromPoints(this.hqFitPoints);
    this.scene.add(this.hq);
  }

  private buildRig(index: number): Rig {
    const root = new THREE.Group();
    root.name = `Sentinel dock ${index + 1}`; root.visible = false;
    const bodyMaterial = this.hardwareMaterial("titanium"), ceramic = this.hardwareMaterial("ceramic");
    const color = colorForAgent(index);
    const accentMaterial = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.8, metalness: 0.48, roughness: 0.28, envMapIntensity: 1 });
    const eyeMaterial = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const glowMaterial = createFresnelMaterial(color);
    [accentMaterial, eyeMaterial, glowMaterial].forEach((material) => this.disposableMaterials.add(material));
    const box = (key: string, width: number, height: number, depth: number, radius = 0.07) => this.geometry(key, () => bevelledBox(width, height, depth, radius));
    const torso = box("titanium-torso", 0.83, 0.87, 0.5), boot = box("titanium-boot", 0.27, 0.2, 0.43, 0.04);
    const leg = box("titanium-leg", 0.23, 0.48, 0.25, 0.04), hip = box("titanium-hip", 0.56, 0.16, 0.35, 0.04);
    const neck = this.geometry("neck-collar", () => new THREE.CylinderGeometry(0.15, 0.18, 0.16, 16));
    const pedestal = this.geometry("sentinel-dock", () => new THREE.LatheGeometry([new THREE.Vector2(0, 0), new THREE.Vector2(0.66, 0), new THREE.Vector2(0.73, 0.04), new THREE.Vector2(0.73, 0.17), new THREE.Vector2(0.67, 0.25), new THREE.Vector2(0, 0.25)], 32));
    const frame = this.geometry("sentinel-frame-merged", () => mergeHardware([
      { geometry: pedestal }, { geometry: torso, position: [0, 1.29, 0] }, { geometry: hip, position: [0, 0.86, 0] }, { geometry: neck, position: [0, 1.8, 0] },
      ...[-1, 1].flatMap((side): HardwarePart[] => [{ geometry: leg, position: [side * 0.19, 0.62, 0] }, { geometry: boot, position: [side * 0.19, 0.35, 0.04] }]),
    ]));
    root.add(new THREE.Mesh(frame, bodyMaterial));
    const chest = box("ceramic-chest", 0.6, 0.53, 0.075, 0.055), thigh = box("ceramic-thigh", 0.15, 0.25, 0.055, 0.025);
    root.add(new THREE.Mesh(this.geometry("sentinel-ceramic-merged", () => mergeHardware([{ geometry: chest, position: [0, 1.32, 0.285] }, ...[-1, 1].map((side): HardwarePart => ({ geometry: thigh, position: [side * 0.19, 0.67, 0.15] }))])), ceramic));
    const chestLight = box("chest-reactor-port", 0.105, 0.31, 0.045, 0.02);
    const dockLight = this.geometry("sentinel-dock-band", () => new THREE.TorusGeometry(0.713, 0.024, 8, 40));
    root.add(new THREE.Mesh(this.geometry("sentinel-status-merged", () => mergeHardware([{ geometry: chestLight, position: [0, 1.32, 0.344] }, { geometry: dockLight, position: [0, 0.174, 0], rotation: [Math.PI / 2, 0, 0] }])), accentMaterial));
    const head = new THREE.Group(); head.position.y = 2.04;
    const helmet = box("helmet-ceramic-bevel", 0.73, 0.57, 0.56, 0.105);
    const antenna = this.geometry("antenna-stem", () => new THREE.CylinderGeometry(0.023, 0.031, 0.19, 8));
    head.add(new THREE.Mesh(this.geometry("helmet-hardware-merged", () => mergeHardware([{ geometry: helmet }, { geometry: antenna, position: [0.26, 0.34, -0.08] }])), bodyMaterial));
    const visorFrame = this.geometry("curved-visor-frame", () => new THREE.CylinderGeometry(0.406, 0.406, 0.23, 24, 1, true, -1.02, 2.04));
    const visor = this.geometry("curved-visor-glass", () => new THREE.CylinderGeometry(0.41, 0.41, 0.128, 24, 1, true, -0.95, 1.9));
    const visorFrameMesh = new THREE.Mesh(visorFrame, bodyMaterial); visorFrameMesh.position.z = 0.105;
    const visorMesh = new THREE.Mesh(visor, eyeMaterial); visorMesh.position.z = 0.115;
    const shell = new THREE.Mesh(helmet, glowMaterial); shell.scale.setScalar(1.045); shell.userData.ignoreFit = true;
    head.add(visorFrameMesh, visorMesh, shell); root.add(head);
    const armPlate = box("arm-titanium", 0.21, 0.7, 0.25, 0.045);
    const shoulder = this.geometry("arm-shoulder", () => new THREE.SphereGeometry(0.17, 12, 8));
    const armShell = this.geometry("arm-shell-merged", () => mergeHardware([{ geometry: armPlate, position: [0, -0.3, 0] }, { geometry: shoulder }]));
    const armCeramic = box("arm-ceramic", 0.16, 0.36, 0.055, 0.035);
    const arm = (side: number) => {
      const group = new THREE.Group(); group.position.set(side * 0.56, 1.6, 0);
      const plate = new THREE.Mesh(armCeramic, ceramic); plate.position.set(0, -0.31, 0.15);
      group.add(new THREE.Mesh(armShell, bodyMaterial), plate); root.add(group); return group;
    };
    const leftArm = arm(-1), rightArm = arm(1);
    const telemetry = new THREE.Mesh(this.geometry("dock-selection-ring", () => new THREE.TorusGeometry(0.8, 0.014, 6, 40)), eyeMaterial);
    telemetry.rotation.x = Math.PI / 2; telemetry.position.y = 0.055;
    root.add(telemetry, this.contactShadow(1));
    // Repeated fasteners use instancing rather than four extra meshes.
    const bolts = new THREE.InstancedMesh(this.geometry("dock-fastener", () => new THREE.SphereGeometry(0.052, 8, 6)), ceramic, 4);
    const bolt = new THREE.Object3D();
    for (let number = 0; number < 4; number += 1) {
      const angle = number * Math.PI / 2 + Math.PI / 4;
      bolt.position.set(Math.sin(angle) * 0.59, 0.254, Math.cos(angle) * 0.59); bolt.scale.set(1, 0.42, 1); bolt.updateMatrix(); bolts.setMatrixAt(number, bolt.matrix);
    }
    root.add(bolts);
    const { geometry: conduitGeometry, positions: conduitPositions } = createRibbonGeometry();
    const conduitMaterial = new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uAlpha: { value: 0.24 }, uSurge: { value: 0 } }, vertexShader: RIBBON_VERTEX, fragmentShader: CONDUIT_FRAGMENT, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.disposableGeometries.add(conduitGeometry); this.disposableMaterials.add(conduitMaterial);
    const conduit = new THREE.Mesh(conduitGeometry, conduitMaterial);
    conduit.name = "Persistent HQ presence conduit"; conduit.visible = false; conduit.frustumCulled = false;
    this.scene.add(root, conduit);
    const fitPoints = hardwareFitPoints(root);
    return { root, head, leftArm, rightArm, telemetry: [telemetry], bodyMaterial, accentMaterial, eyeMaterial, glowMaterial, id: null, target: new THREE.Vector3(), phase: index * 0.83, targetScale: 1, fitPoints, hardwareBounds: new THREE.Box3().setFromPoints(fitPoints), pedestalBounds: new THREE.Box3(new THREE.Vector3(-0.8, 0, -0.8), new THREE.Vector3(0.8, 0.27, 0.8)), conduit, conduitPositions, baseColor: new THREE.Color(color), presenceAlpha: 0.24, activity: 0, attentionTargetId: null, attentionUntil: 0 };
  }

  private buildRibbon(): RibbonSlot {
    const { geometry, positions } = createRibbonGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uColor: { value: new THREE.Color(CUE_COLORS.chat) },
        uTime: { value: 0 },
        uAlpha: { value: 0.9 },
      },
      vertexShader: RIBBON_VERTEX,
      fragmentShader: RIBBON_FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.disposableGeometries.add(geometry);
    this.disposableMaterials.add(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return { mesh, positions, active: false, eventId: "", sourceId: HQ_ID, targetId: HQ_ID, cue: "chat", start: 0, duration: 1, sequence: 0 };
  }

  private layoutFleet(ids: readonly string[]) {
    const settings = stageLayoutSettings(ids.length, this.camera.aspect);
    const positions = layoutAgentPositions(ids, this.camera.aspect);
    const firstFleet = !this.fleetReady;
    this.hqTarget.set(settings.hqX, 0, settings.hqZ); this.hqTargetScale = settings.hqScale;
    ids.forEach((id) => {
      const rig = this.rigById.get(id), point = positions.get(id);
      if (!rig || !point) return;
      rig.target.set(point.x, point.y, point.z); rig.targetScale = settings.robotScale;
      if (firstFleet || rig.root.userData.fresh || this.reducedMotion) {
        rig.root.position.copy(rig.target); rig.root.scale.setScalar(rig.targetScale);
      }
      rig.root.userData.fresh = false;
    });
    if (firstFleet || this.reducedMotion) {
      this.hq.position.copy(this.hqTarget); this.hq.scale.setScalar(this.hqTargetScale);
      this.snapCamera = true;
    }
    this.fleetReady ||= ids.length > 0;
    this.layoutTransition = !this.reducedMotion && !firstFleet;
  }

  private readonly resize = () => {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width || this.host.clientWidth || 640));
    this.height = Math.max(1, Math.round(rect.height || this.host.clientHeight || 480));
    this.mobile = this.width <= MOBILE_BREAKPOINT;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.25 : 1.5);
    this.renderer.setPixelRatio(pixelRatio); this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix();
    const signature = `${this.width}:${this.height}:${this.mobile}:${pixelRatio}`;
    if (signature !== this.lastViewportSignature) {
      this.lastViewportSignature = signature;
      this.callbacks.onViewport({ width: this.width, height: this.height, mobile: this.mobile, pixelRatio });
    }
    this.layoutFleet(Array.from(this.rigById.keys())); this.measureOverlays(); this.updateCameraGoal(); this.requestRender();
  };

  private collectCameraPoints(ids: readonly string[], includeHQ: boolean): THREE.Vector3[] {
    const points: THREE.Vector3[] = [];
    const scale = new THREE.Vector3();
    const append = (local: readonly THREE.Vector3[], object: THREE.Group, target: THREE.Vector3, targetScale: number) => {
      const matrix = new THREE.Matrix4().compose(target, object.quaternion, scale.setScalar(targetScale));
      object.updateWorldMatrix(true, false);
      for (const localPoint of local) {
        const index = points.length;
        const point = this.cameraFitPool[index] ?? (this.cameraFitPool[index] = new THREE.Vector3());
        points.push(point.copy(localPoint).applyMatrix4(matrix));
        if (this.layoutTransition) {
          const currentIndex = points.length;
          const current = this.cameraFitPool[currentIndex] ?? (this.cameraFitPool[currentIndex] = new THREE.Vector3());
          points.push(current.copy(localPoint).applyMatrix4(object.matrixWorld));
        }
      }
    };
    ids.forEach((id) => { const rig = this.rigById.get(id); if (rig) append(rig.fitPoints, rig.root, rig.target, rig.targetScale); });
    if (includeHQ) append(this.hqFitPoints, this.hq, this.hqTarget, this.hqTargetScale);
    return points;
  }

  private updateCameraGoal() {
    let ids = Array.from(this.rigById.keys());
    let includeHQ = true;
    if (this.preset === "inspect" && this.selectedId && this.rigById.has(this.selectedId)) {
      ids = [this.selectedId]; includeHQ = false;
    } else if (this.preset === "conversation" || this.followTransfer) {
      const route = this.latestRibbon() ?? this.lastConversation;
      if (route) {
        ids = Array.from(new Set([route.sourceId, route.targetId])).filter((id) => this.rigById.has(id));
        includeHQ = route.sourceId === HQ_ID || route.targetId === HQ_ID || !ids.length;
      }
    }
    const activeLabels = this.labels.filter(({ id }) => id === HQ_ID || ids.includes(id));
    const labelHeight = Math.max(this.mobile ? 36 : 44, ...activeLabels.map(({ element }) => this.overlaySizes.get(element)?.height ?? 0));
    const labelCount = ids.length + (includeHQ ? 1 : 0);
    const labelWidth = activeLabels.length === labelCount
      ? activeLabels.reduce((sum, { element }) => sum + (this.overlaySizes.get(element)?.width ?? (this.mobile ? 84 : 116)), 0)
      : ids.length * (this.mobile ? 84 : 116) + (includeHQ ? this.mobile ? 96 : 116 : 0);
    const agentLabelWidth = Math.max(this.mobile ? 84 : 116, ...activeLabels.filter(({ id }) => id !== HQ_ID).map(({ element }) => this.overlaySizes.get(element)?.width ?? 0));
    const labelColumns = Math.max(1, Math.floor((this.width - 1) / (agentLabelWidth + 9)));
    const labelRows = Math.max(this.mobile && labelCount >= 3 ? 2 : 1, Math.ceil(labelCount / labelColumns), Math.ceil((labelWidth + Math.max(0, labelCount - 1) * 9) / Math.max(1, this.width - 10)));
    const labelMargin = labelHeight + 46 + (labelRows - 1) * (labelHeight + 9);
    const fleet = this.rigById.size > 4 && this.preset === "overview";
    const bubbleHeight = Math.max(0, ...this.bubbles.map(({ element }) => this.overlaySizes.get(element)?.height ?? (this.mobile ? 76 : 104)));
    const margins: FrameMargins = {
      left: fleet ? 0.075 : 0.1, right: fleet ? 0.075 : 0.1, top: this.bubbles.length ? Math.min(0.35, (bubbleHeight + 36) / Math.max(1, this.height)) : 0.08,
      bottom: Math.min(0.44, Math.max(labelMargin / Math.max(1, this.height), fleet ? 0.25 : 0.14)),
    };
    const fit = fitCameraToPoints(this.collectCameraPoints(ids, includeHQ), this.camera.aspect, this.azimuth, this.elevation, margins);
    const distance = fit.distance * this.zoomScale;
    this.desiredCameraTarget.set(fit.target.x, fit.target.y, fit.target.z);
    const cosine = Math.cos(this.elevation);
    this.desiredCameraPosition.set(fit.target.x + Math.sin(this.azimuth) * cosine * distance, fit.target.y + Math.sin(this.elevation) * distance, fit.target.z + Math.cos(this.azimuth) * cosine * distance);
  }

  private messageAnchorFor(id: string, output: THREE.Vector3) {
    const object = id === HQ_ID ? this.hq : this.rigById.get(id)?.root;
    if (!object) return output.copy(this.hq.position).add(new THREE.Vector3(0, 3.1, 0));
    object.updateWorldMatrix(true, false);
    return output.set(0, id === HQ_ID ? 2.72 : 2.67, 0).applyMatrix4(object.matrixWorld);
  }

  private pedestalLabelAnchorFor(id: string, output: THREE.Vector3) {
    const object = id === HQ_ID ? this.hq : this.rigById.get(id)?.root;
    if (!object) return output.set(0, -0.035, 0);
    object.updateWorldMatrix(true, false);
    return output.set(0, -0.035, 0).applyMatrix4(object.matrixWorld);
  }

  private anchorFor(id: string, output: THREE.Vector3) {
    const object = id === HQ_ID ? this.hq : this.rigById.get(id)?.root;
    if (!object) return output.copy(this.hq.position).add(new THREE.Vector3(0, 1.6, 0));
    object.updateWorldMatrix(true, false);
    return output.set(0, id === HQ_ID ? 1.6 : 1.42, id === HQ_ID ? 0.08 : 0.34).applyMatrix4(object.matrixWorld);
  }

  private updateConduit(rig: Rig, now: number) {
    rig.conduit.visible = rig.root.visible;
    this.hq.updateWorldMatrix(true, false); rig.root.updateWorldMatrix(true, false);
    const source = this.conduitSource.set(0, 0.29, 0.96).applyMatrix4(this.hq.matrixWorld);
    const target = this.conduitTarget.set(0, 0.2, 0.48).applyMatrix4(rig.root.matrixWorld);
    const midY = Math.max(source.y, target.y) + 0.22;
    const width = 0.028 + rig.activity * 0.035;
    const dx = target.x - source.x, dz = target.z - source.z;
    const length = Math.max(0.001, Math.hypot(dx, dz));
    const signature = `${source.x.toFixed(4)}:${source.z.toFixed(4)}:${target.x.toFixed(4)}:${target.z.toFixed(4)}:${width.toFixed(4)}:${source.y.toFixed(4)}:${target.y.toFixed(4)}`;
    if (rig.conduit.userData.endpointSignature !== signature) {
      rig.conduit.userData.endpointSignature = signature;
      for (let index = 0; index < RIBBON_SEGMENTS; index += 1) {
      const t = index / (RIBBON_SEGMENTS - 1), inverse = 1 - t;
      const x = source.x + dx * t, z = source.z + dz * t;
      const y = inverse * inverse * source.y + 2 * inverse * t * midY + t * t * target.y;
      const offset = index * 6, sideX = -dz / length * width, sideZ = dx / length * width;
      rig.conduitPositions[offset] = x + sideX; rig.conduitPositions[offset + 1] = y; rig.conduitPositions[offset + 2] = z + sideZ;
      rig.conduitPositions[offset + 3] = x - sideX; rig.conduitPositions[offset + 4] = y; rig.conduitPositions[offset + 5] = z - sideZ;
      }
      (rig.conduit.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    }
    const uniforms = rig.conduit.material.uniforms;
    uniforms.uTime.value = this.reducedMotion ? 0 : now * 0.001;
    uniforms.uAlpha.value = rig.presenceAlpha; uniforms.uSurge.value = rig.activity;
    (uniforms.uColor.value as THREE.Color).copy(rig.eyeMaterial.color);
  }

  private latestRibbon() {
    let latest: RibbonSlot | undefined;
    for (const slot of this.ribbons) {
      if (slot.active && (!latest || slot.sequence > latest.sequence)) latest = slot;
    }
    return latest;
  }

  private updateRibbon(slot: RibbonSlot, now: number, packetOffset: number) {
    const elapsed = Math.max(0, now - slot.start);
    const progress = elapsed / slot.duration;
    if (progress > 1.18) {
      this.deactivateRibbon(slot);
      return packetOffset;
    }
    const source = this.anchorFor(slot.sourceId, this.ribbonSource);
    const target = this.anchorFor(slot.targetId, this.ribbonTarget);
    const midX = (source.x + target.x) * 0.5;
    const midY = Math.max(source.y, target.y) + 1.0 + source.distanceTo(target) * 0.12;
    const midZ = (source.z + target.z) * 0.5;
    const width = slot.cue === "file" ? 0.13 : slot.cue === "reply" ? 0.105 : slot.cue === "task" ? 0.09 : 0.075;

    for (let index = 0; index < RIBBON_SEGMENTS; index += 1) {
      const t = index / (RIBBON_SEGMENTS - 1);
      const inverse = 1 - t;
      const x = inverse * inverse * source.x + 2 * inverse * t * midX + t * t * target.x;
      const y = inverse * inverse * source.y + 2 * inverse * t * midY + t * t * target.y;
      const z = inverse * inverse * source.z + 2 * inverse * t * midZ + t * t * target.z;
      const dx = 2 * inverse * (midX - source.x) + 2 * t * (target.x - midX);
      const dz = 2 * inverse * (midZ - source.z) + 2 * t * (target.z - midZ);
      const length = Math.max(0.001, Math.hypot(dx, dz));
      const sideX = -dz / length * width;
      const sideZ = dx / length * width;
      const offset = index * 6;
      slot.positions[offset] = x + sideX;
      slot.positions[offset + 1] = y;
      slot.positions[offset + 2] = z + sideZ;
      slot.positions[offset + 3] = x - sideX;
      slot.positions[offset + 4] = y;
      slot.positions[offset + 5] = z - sideZ;
    }
    const position = slot.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    position.needsUpdate = true;
    slot.mesh.material.uniforms.uTime.value = now * 0.001;
    slot.mesh.material.uniforms.uAlpha.value = progress > 0.94 ? Math.max(0, (1.18 - progress) / 0.24) : slot.mesh.material.uniforms.uAlpha.value;

    const packetCount = slot.cue === "file" ? 4 : slot.cue === "chat" || slot.cue === "reply" ? 3 : 2;
    const color = slot.mesh.material.uniforms.uColor.value as THREE.Color;
    for (let packet = 0; packet < packetCount && packetOffset < PACKET_CAPACITY; packet += 1) {
      const t = (progress * 0.92 + packet / packetCount) % 1;
      const inverse = 1 - t;
      this.packetObject.position.set(
        inverse * inverse * source.x + 2 * inverse * t * midX + t * t * target.x,
        inverse * inverse * source.y + 2 * inverse * t * midY + t * t * target.y,
        inverse * inverse * source.z + 2 * inverse * t * midZ + t * t * target.z,
      );
      const pulse = 0.72 + Math.sin(now * 0.008 + packet * 2.1) * 0.22;
      this.packetObject.scale.setScalar(slot.cue === "file" ? 1.35 * pulse : pulse);
      this.packetObject.updateMatrix();
      this.packetInstances.setMatrixAt(packetOffset, this.packetObject.matrix);
      this.packetInstances.setColorAt(packetOffset, color);
      packetOffset += 1;
    }
    return packetOffset;
  }

  private deactivateRibbon(slot: RibbonSlot) {
    slot.active = false;
    slot.mesh.visible = false;
    slot.runId = undefined;
  }

  private renderFrame(now: number, immediate = false) {
    if (this.disposed) return;
    const delta = immediate ? 0 : Math.min(0.05, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    const motion = this.reducedMotion || immediate ? 1 : Math.min(1, delta * 5.8);
    let moving = false;
    this.hq.position.lerp(this.hqTarget, motion);
    this.hq.scale.setScalar(THREE.MathUtils.lerp(this.hq.scale.x, this.hqTargetScale, motion));
    moving ||= this.hq.position.distanceToSquared(this.hqTarget) > 0.00001 || Math.abs(this.hq.scale.x - this.hqTargetScale) > 0.001;
    this.rigs.forEach((rig) => {
      if (!rig.root.visible) return;
      rig.root.position.lerp(rig.target, motion);
      rig.root.scale.setScalar(THREE.MathUtils.lerp(rig.root.scale.x, rig.targetScale, motion));
      moving ||= rig.root.position.distanceToSquared(rig.target) > 0.00001 || Math.abs(rig.root.scale.x - rig.targetScale) > 0.001;
    });
    if (this.layoutTransition && !moving) { this.layoutTransition = false; this.updateCameraGoal(); }
    const activity = new Map<string, RibbonSlot>();
    let packetCount = 0;
    for (const slot of this.ribbons) {
      if (!slot.active) continue;
      packetCount = this.updateRibbon(slot, now, packetCount);
      if (!slot.active) continue;
      for (const id of [slot.sourceId, slot.targetId]) {
        const previous = activity.get(id);
        if (!previous || slot.sequence > previous.sequence) activity.set(id, slot);
      }
    }
    this.rigs.forEach((rig, index) => {
      if (!rig.root.visible) return;
      const phase = now * 0.001 + rig.phase;
      const slot = rig.id ? activity.get(rig.id) : undefined;
      const attentive = rig.attentionUntil > now && rig.attentionTargetId !== null;
      rig.activity = THREE.MathUtils.lerp(rig.activity, slot ? 1 : attentive ? 0.55 : 0, motion);
      if (rig.activity < 0.001) rig.activity = 0;
      const color = slot ? CUE_COLORS[slot.cue] ?? CUE_COLORS.chat : null;
      if (color !== null) rig.eyeMaterial.color.setHex(color); else rig.eyeMaterial.color.copy(rig.baseColor);
      rig.accentMaterial.emissive.copy(rig.eyeMaterial.color);
      rig.accentMaterial.emissiveIntensity = 0.65 + rig.activity * 1.35;
      const otherId = slot ? slot.sourceId === rig.id ? slot.targetId : slot.sourceId : attentive ? rig.attentionTargetId : null;
      let gaze = this.reducedMotion ? 0 : Math.sin(phase * 0.45) * 0.045;
      let pitch = 0;
      if (otherId) {
        const other = this.anchorFor(otherId, this.temporaryPoint);
        const dx = other.x - rig.root.position.x, dz = other.z - rig.root.position.z;
        gaze = clamp(Math.atan2(dx, dz) - rig.root.rotation.y, -0.68, 0.68);
        pitch = clamp(-Math.atan2(other.y - (rig.root.position.y + 2.04 * rig.root.scale.x), Math.max(0.1, Math.hypot(dx, dz))), -0.2, 0.22);
      }
      rig.head.rotation.y = THREE.MathUtils.lerp(rig.head.rotation.y, gaze, motion);
      rig.head.rotation.x = THREE.MathUtils.lerp(rig.head.rotation.x, pitch, motion);
      rig.leftArm.rotation.z = this.reducedMotion ? 0.08 : 0.08 + Math.sin(phase * 1.1) * (0.035 + rig.activity * 0.065);
      rig.rightArm.rotation.z = this.reducedMotion ? -0.08 : -0.08 - Math.sin(phase * 1.1) * (0.035 + rig.activity * 0.065);
      rig.telemetry.forEach((ring, ringIndex) => { ring.rotation.z = this.reducedMotion ? index * 0.1 : phase * (ringIndex ? -0.36 : 0.42); });
      rig.glowMaterial.uniforms.uPulse.value = this.reducedMotion ? 0.3 : 0.12 + rig.activity * 0.55 + Math.sin(phase * 1.2) * 0.07;
      this.updateConduit(rig, now);
    });
    this.hq.children.forEach((child) => {
      if (this.reducedMotion) return;
      if (child.userData.hqRing !== undefined) child.rotation.z += delta * (0.12 + child.userData.hqRing * 0.05);
      if (child.userData.reactorCore) child.rotation.y += delta * 0.14;
    });
    this.packetInstances.count = packetCount;
    if (packetCount) {
      this.packetInstances.instanceMatrix.needsUpdate = true;
      if (this.packetInstances.instanceColor) this.packetInstances.instanceColor.needsUpdate = true;
    }
    if (this.followTransfer) this.updateCameraGoal();
    const cameraMotion = this.reducedMotion || immediate || this.snapCamera ? 1 : Math.min(1, delta * 5.8);
    this.snapCamera = false;
    this.camera.position.lerp(this.desiredCameraPosition, cameraMotion);
    this.cameraTarget.lerp(this.desiredCameraTarget, cameraMotion);
    this.camera.lookAt(this.cameraTarget); this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera); this.positionOverlays(); this.renderedFrames += 1;
  }

  private measureOverlays() {
    if (this.disposed) return;
    this.overlaySizes.clear(); this.lastOverlaySignature = "";
    this.labels.forEach(({ id, element }) => {
      const display = element.style.display;
      element.style.display = "";
      this.overlaySizes.set(element, { width: element.offsetWidth || (id === HQ_ID ? 96 : this.mobile ? 84 : 116), height: element.offsetHeight || (this.mobile ? 36 : 44) });
      element.style.display = display;
    });
    this.bubbles.forEach(({ element }) => {
      const display = element.style.display;
      element.style.display = "";
      this.overlaySizes.set(element, { width: element.offsetWidth || (this.mobile ? 196 : 208), height: element.offsetHeight || (this.mobile ? 76 : 104) });
      element.style.display = display;
    });
  }

  private projectRect(bounds: THREE.Box3, object: THREE.Group): ScreenRect | null {
    object.updateWorldMatrix(true, false);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let index = 0; index < 8; index += 1) {
      const point = this.overlayPoint.set(index & 1 ? bounds.max.x : bounds.min.x, index & 2 ? bounds.max.y : bounds.min.y, index & 4 ? bounds.max.z : bounds.min.z);
      point.applyMatrix4(object.matrixWorld).project(this.camera);
      if (point.z <= -1 || point.z >= 1) continue;
      const x = (point.x * 0.5 + 0.5) * this.width, y = (-point.y * 0.5 + 0.5) * this.height;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return Number.isFinite(minX) ? { x: minX, y: minY, width: maxX - minX, height: maxY - minY } : null;
  }

  private positionOverlays() {
    if (this.disposed || !this.width || !this.height) return;
    const signature = `${this.width}:${this.height}:${this.camera.matrixWorld.elements.map((value) => value.toFixed(3)).join(",")}:` + Array.from(this.rigById.values(), (rig) => `${rig.root.position.x.toFixed(3)},${rig.root.position.z.toFixed(3)},${rig.root.scale.x.toFixed(3)}`).join(";") + `:${this.hq.position.x.toFixed(3)},${this.hq.position.z.toFixed(3)},${this.hq.scale.x.toFixed(3)}`;
    if (signature === this.lastOverlaySignature) return;
    this.lastOverlaySignature = signature;
    const viewport = { width: this.width, height: Math.max(1, this.height - 26) };
    const project = (point: THREE.Vector3) => {
      point.project(this.camera);
      return { x: (point.x * 0.5 + 0.5) * this.width, y: (-point.y * 0.5 + 0.5) * this.height, visible: point.z > -1 && point.z < 1 && Math.abs(point.x) < 1.08 && Math.abs(point.y) < 1.08 };
    };
    const hardware: ScreenRect[] = [];
    const hqRect = this.projectRect(this.hqBounds, this.hq);
    if (hqRect) hardware.push(hqRect);
    this.rigById.forEach((rig) => { const rect = this.projectRect(rig.hardwareBounds, rig.root); if (rect) hardware.push(rect); });
    const labelInputs: DockLabelInput[] = [];
    const dockScreens = new Map<string, { x: number; bottom: number }>();
    this.labels.forEach(({ id, element }) => {
      const rig = this.rigById.get(id);
      const object = id === HQ_ID ? this.hq : rig?.root;
      if (!object) { element.style.display = "none"; return; }
      const screen = project(this.pedestalLabelAnchorFor(id, new THREE.Vector3()));
      const bounds = id === HQ_ID ? this.hqPedestalBounds : rig!.pedestalBounds;
      const dock = this.projectRect(bounds, object);
      if (!screen.visible || !dock) { element.style.display = "none"; return; }
      const size = this.overlaySizes.get(element) ?? { width: id === HQ_ID ? 96 : this.mobile ? 84 : 116, height: this.mobile ? 36 : 44 };
      const bottom = Math.max(dock.y + dock.height, screen.y);
      dockScreens.set(id, { x: screen.x, bottom });
      labelInputs.push({ id, x: screen.x - size.width / 2, y: bottom + 10, minY: bottom + 10, ...size });
    });
    const labelPlacements = placeDockLabels(labelInputs, viewport, hardware);
    const labelsById = new Map(labelPlacements.map((placement) => [placement.id, placement]));
    const labelRects: ScreenRect[] = [];
    const position = (element: HTMLElement, x: number, y: number, centered: boolean) => {
      const transform = `translate3d(${Math.round(x * 10) / 10}px, ${Math.round(y * 10) / 10}px, 0)${centered ? " translateX(-50%)" : ""}`;
      if (element.style.display !== "") element.style.display = "";
      if (element.style.left !== "0px") element.style.left = "0px";
      if (element.style.top !== "0px") element.style.top = "0px";
      if (element.style.transform !== transform) element.style.transform = transform;
    };
    this.labels.forEach(({ id, element }) => {
      const placement = labelsById.get(id), input = labelInputs.find((item) => item.id === id), dock = dockScreens.get(id);
      if (!placement || placement.hidden || !input || !dock) { element.style.display = "none"; return; }
      position(element, placement.x + input.width / 2, placement.y, true);
      const leaderX = dock.x - placement.x - input.width / 2;
      const leaderY = Math.max(5, placement.y - dock.bottom - 3);
      element.style.setProperty("--label-leader-angle", `${Math.atan2(leaderX, leaderY) * 180 / Math.PI}deg`);
      element.style.setProperty("--label-leader-height", `${Math.hypot(leaderX, leaderY)}px`);
      labelRects.push({ x: placement.x, y: placement.y, width: input.width, height: input.height });
    });
    const bubbleInputs: BubbleInput[] = [];
    this.bubbles.forEach(({ id, agentId, element }) => {
      const screen = project(this.messageAnchorFor(agentId, new THREE.Vector3()));
      if (!screen.visible) { element.style.display = "none"; return; }
      const size = this.overlaySizes.get(element) ?? { width: this.mobile ? 196 : 208, height: this.mobile ? 76 : 104 };
      bubbleInputs.push({ id, x: screen.x - size.width / 2, y: screen.y - size.height - 12, ...size });
    });
    const placements = placeBubbles(bubbleInputs, viewport, this.mobile ? 2 : 4, [...hardware, ...labelRects]);
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    this.bubbles.forEach(({ id, element }) => {
      const placement = byId.get(id);
      if (!placement || placement.hidden) { element.style.display = "none"; return; }
      position(element, placement.x, placement.y, false);
    });
  }

  private scheduleFrame() {
    if (this.disposed || this.reducedMotion || document.hidden || this.frameHandle !== null) return;
    this.frameHandle = requestAnimationFrame(this.onFrame);
  }

  private requestRender() {
    if (this.disposed || document.hidden) return;
    if (this.reducedMotion) this.renderFrame(performance.now(), true);
    else this.scheduleFrame();
  }

  private cancelFrame() {
    if (this.frameHandle === null) return;
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private readonly onFrame = (now: number) => {
    this.frameHandle = null;
    if (this.disposed || this.reducedMotion || document.hidden) return;
    this.renderFrame(now);
    this.scheduleFrame();
  };

  private readonly onVisibilityChange = () => {
    if (document.hidden) this.cancelFrame();
    else if (!this.reducedMotion) {
      this.lastFrameTime = performance.now();
      this.scheduleFrame();
    } else {
      this.requestRender();
    }
  };

  private releaseFollow() {
    if (!this.followTransfer) return;
    this.followTransfer = false;
    this.callbacks.onFollowChange(false);
  }

  private readonly onPointerDown = (event: PointerEvent) => {
    this.releaseFollow();
    this.dragPointer = event.pointerId;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.dragDistance = 0;
    this.renderer.domElement.setPointerCapture?.(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent) => {
    if (this.dragPointer !== event.pointerId) return;
    const deltaX = event.clientX - this.dragX;
    const deltaY = event.clientY - this.dragY;
    this.dragX = event.clientX;
    this.dragY = event.clientY;
    this.dragDistance += Math.abs(deltaX) + Math.abs(deltaY);
    this.azimuth -= deltaX * 0.006;
    this.elevation = clamp(this.elevation + deltaY * 0.004, 0.12, 1.08);
    this.updateCameraGoal();
    this.requestRender();
  };

  private readonly onPointerUp = (event: PointerEvent) => {
    if (this.dragPointer !== event.pointerId) return;
    this.renderer.domElement.releasePointerCapture?.(event.pointerId);
    this.dragPointer = null;
    if (this.dragDistance > 8) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const roots = Array.from(this.rigById.values(), (rig) => rig.root);
    const hit = this.raycaster.intersectObjects(roots, true)[0];
    let object: THREE.Object3D | null = hit?.object ?? null;
    while (object && !object.userData.agentId) object = object.parent;
    const id = object?.userData.agentId;
    if (typeof id === "string") this.callbacks.onSelect(id);
  };

  private readonly onPointerCancel = (event: PointerEvent) => {
    if (this.dragPointer === event.pointerId) this.dragPointer = null;
  };

  private readonly onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.releaseFollow();
    this.zoomScale = clamp(this.zoomScale * (event.deltaY > 0 ? 1.08 : 0.92), 0.58, 1.72);
    this.updateCameraGoal();
    this.requestRender();
  };

  private readonly onContextLost = (event: Event) => {
    event.preventDefault();
    this.cancelFrame();
    this.callbacks.onError(new Error("WebGL context lost"));
  };
}
