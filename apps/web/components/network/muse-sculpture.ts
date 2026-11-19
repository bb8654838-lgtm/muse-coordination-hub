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

export function layoutAgentPositions(ids: readonly string[], aspect: number): Map<string, Point3> {
  const result = new Map<string, Point3>();
  if (!ids.length) return result;
  const safeAspect = clamp(finite(aspect, 1), 0.35, 3.2);
  const radiusX = safeAspect < 0.72 ? 2.55 : safeAspect < 1.05 ? 3.55 : 5.1;
  const radiusZ = safeAspect < 0.72 ? 4.85 : 3.85;
  const count = ids.length;
  for (let index = 0; index < count; index += 1) {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    const stagger = index % 2 ? 0.18 : -0.12;
    result.set(ids[index], {
      x: Math.cos(angle) * radiusX,
      y: 0,
      z: Math.sin(angle) * radiusZ + stagger,
    });
  }
  return result;
}

export function computeFitDistance(bounds: THREE.Box3, aspect: number, _azimuth = 0, _elevation = 0): number {
  if (bounds.isEmpty()) return 12;
  const sphere = bounds.getBoundingSphere(new THREE.Sphere());
  const verticalHalfFov = THREE.MathUtils.degToRad(STAGE_FOV) / 2;
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(0.05, finite(aspect, 1)));
  const limitingHalfFov = Math.max(0.035, Math.min(verticalHalfFov, horizontalHalfFov));
  return Math.max(4, sphere.radius / Math.sin(limitingHalfFov) * 1.14 + 0.65);
}

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
): BubblePlacement[] {
  const viewportWidth = Math.max(0, finite(viewport.width));
  const viewportHeight = Math.max(0, finite(viewport.height));
  const visibleLimit = Math.max(0, Math.min(items.length, Math.floor(finite(limit))));
  const occupied: Array<{ x: number; y: number; width: number; height: number }> = [];
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
  private elevation = 0.52;
  private zoomScale = 1;
  private dragPointer: number | null = null;
  private dragX = 0;
  private dragY = 0;
  private dragDistance = 0;
  private effectSequence = 0;
  private renderedFrames = 0;
  private lastFrameTime = 0;
  private lastViewportSignature = "";

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

    this.buildEnvironment();
    for (let index = 0; index < MAX_SENTINELS; index += 1) this.rigs.push(this.buildRig(index));
    for (let index = 0; index < POOL_CAPACITY; index += 1) this.ribbons.push(this.buildRibbon());

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
      this.rigById.delete(id);
      rig.id = null;
      rig.root.visible = false;
      rig.root.userData.agentId = undefined;
    }

    incoming.forEach((agent) => {
      let rig = this.rigById.get(agent.id);
      let fresh = false;
      if (!rig) {
        rig = this.rigs.find((candidate) => candidate.id === null);
        if (!rig) return;
        fresh = true;
        rig.id = agent.id;
        rig.root.visible = true;
        rig.root.userData.agentId = agent.id;
        this.rigById.set(agent.id, rig);
      }
      const statusColor = agent.status === "online" ? 0x66f5d2 : agent.status === "idle" ? 0xf6c65b : 0x738399;
      rig.accentMaterial.color.setHex(statusColor);
      rig.accentMaterial.emissive.setHex(statusColor);
      rig.eyeMaterial.color.setHex(statusColor);
      (rig.glowMaterial.uniforms.uColor.value as THREE.Color).setHex(statusColor);
      rig.root.userData.fresh = fresh;
    });

    const positions = layoutAgentPositions(incoming.map((agent) => agent.id), this.width / Math.max(1, this.height));
    incoming.forEach((agent) => {
      const rig = this.rigById.get(agent.id);
      const point = positions.get(agent.id);
      if (!rig || !point) return;
      rig.target.set(point.x, point.y, point.z);
      if (rig.root.userData.fresh || this.reducedMotion) rig.root.position.copy(rig.target);
      rig.root.userData.fresh = false;
    });
    if (this.selectedId && !this.rigById.has(this.selectedId)) this.selectedId = null;
    this.updateCameraGoal();
    this.requestRender();
  }

  setReducedMotion(reduced: boolean) {
    if (this.reducedMotion === reduced) return;
    this.reducedMotion = reduced;
    if (reduced) {
      this.cancelFrame();
      this.renderFrame(performance.now(), true);
    } else {
      this.clock.getDelta();
      this.scheduleFrame();
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
    this.disposableGeometries.forEach((geometry) => geometry.dispose());
    this.disposableMaterials.forEach((material) => material.dispose());
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    canvas.remove();
    this.labels = [];
    this.bubbles = [];
    this.rigById.clear();
  }

  private buildEnvironment() {
    const hemisphere = new THREE.HemisphereLight(0x91cfff, 0x130d2a, 1.45);
    const key = new THREE.DirectionalLight(0xd9eaff, 2.1);
    key.position.set(5, 10, 7);
    const rim = new THREE.PointLight(0x9d66ff, 18, 24, 2);
    rim.position.set(-6, 5, -5);
    this.scene.add(hemisphere, key, rim);

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
    gridMaterial.opacity = 0.34;
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

    const coreGeometry = new THREE.OctahedronGeometry(0.58, 1);
    const coreMaterial = new THREE.MeshStandardMaterial({ color: 0xdec8ff, emissive: 0x7547c4, emissiveIntensity: 1.65, metalness: 0.55, roughness: 0.25 });
    const coreGlowMaterial = createFresnelMaterial(0xd7a9ff);
    this.disposableGeometries.add(coreGeometry);
    this.disposableMaterials.add(coreMaterial);
    this.disposableMaterials.add(coreGlowMaterial);
    const core = new THREE.Mesh(coreGeometry, coreMaterial);
    core.position.y = 1.05;
    const shell = new THREE.Mesh(coreGeometry, coreGlowMaterial);
    shell.position.copy(core.position);
    shell.scale.setScalar(1.36);
    this.hq.add(core, shell);
    for (let index = 0; index < 3; index += 1) {
      const geometry = new THREE.TorusGeometry(0.82 + index * 0.23, 0.018, 6, 48);
      const material = new THREE.MeshBasicMaterial({ color: index === 1 ? 0x44e3ff : 0xb58cff, transparent: true, opacity: 0.58, blending: THREE.AdditiveBlending, depthWrite: false });
      this.disposableGeometries.add(geometry);
      this.disposableMaterials.add(material);
      const ring = new THREE.Mesh(geometry, material);
      ring.position.y = 0.5 + index * 0.45;
      ring.rotation.x = Math.PI / 2 + index * 0.3;
      ring.rotation.y = index * 0.8;
      ring.userData.hqRing = index;
      this.hq.add(ring);
    }
    this.hq.name = "Muse HQ";
    this.scene.add(this.hq);
  }

  private buildRig(index: number): Rig {
    const color = colorForAgent(index);
    const root = new THREE.Group();
    root.visible = false;
    root.name = `Sentinel pool ${index + 1}`;
    this.scene.add(root);

    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x17293e, metalness: 0.82, roughness: 0.28 });
    const accentMaterial = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, metalness: 0.62, roughness: 0.26 });
    const eyeMaterial = new THREE.MeshBasicMaterial({ color, toneMapped: false });
    const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x08111f, metalness: 0.9, roughness: 0.32 });
    const glowMaterial = createFresnelMaterial(color);
    [bodyMaterial, accentMaterial, eyeMaterial, darkMaterial, glowMaterial].forEach((material) => this.disposableMaterials.add(material));

    const torsoGeometry = new THREE.CylinderGeometry(0.44, 0.58, 0.92, 8, 1);
    const chestGeometry = new THREE.BoxGeometry(0.68, 0.12, 0.18);
    const jointGeometry = new THREE.SphereGeometry(0.12, 8, 6);
    const limbGeometry = new THREE.CylinderGeometry(0.085, 0.11, 0.64, 7);
    const headGeometry = new THREE.IcosahedronGeometry(0.39, 1);
    const visorGeometry = new THREE.BoxGeometry(0.48, 0.105, 0.09);
    const antennaGeometry = new THREE.CylinderGeometry(0.025, 0.035, 0.35, 6);
    const ringGeometry = new THREE.TorusGeometry(0.62, 0.016, 5, 36);
    [torsoGeometry, chestGeometry, jointGeometry, limbGeometry, headGeometry, visorGeometry, antennaGeometry, ringGeometry].forEach((geometry) => this.disposableGeometries.add(geometry));

    const torso = new THREE.Mesh(torsoGeometry, bodyMaterial);
    torso.position.y = 1.0;
    root.add(torso);
    const chest = new THREE.Mesh(chestGeometry, accentMaterial);
    chest.position.set(0, 1.22, 0.48);
    root.add(chest);

    const head = new THREE.Group();
    head.position.y = 1.79;
    const helmet = new THREE.Mesh(headGeometry, bodyMaterial);
    helmet.scale.set(1, 0.82, 0.94);
    const shell = new THREE.Mesh(headGeometry, glowMaterial);
    shell.scale.set(1.14, 0.94, 1.08);
    const visor = new THREE.Mesh(visorGeometry, eyeMaterial);
    visor.position.set(0, -0.02, 0.365);
    const antenna = new THREE.Mesh(antennaGeometry, accentMaterial);
    antenna.position.set(0.2, 0.46, 0);
    antenna.rotation.z = -0.14;
    head.add(helmet, shell, visor, antenna);
    root.add(head);

    const buildArm = (side: number) => {
      const arm = new THREE.Group();
      arm.position.set(side * 0.58, 1.32, 0);
      const shoulder = new THREE.Mesh(jointGeometry, accentMaterial);
      const upper = new THREE.Mesh(limbGeometry, darkMaterial);
      upper.position.y = -0.34;
      const hand = new THREE.Mesh(jointGeometry, eyeMaterial);
      hand.position.y = -0.69;
      hand.scale.setScalar(0.8);
      arm.add(shoulder, upper, hand);
      root.add(arm);
      return arm;
    };
    const leftArm = buildArm(-1);
    const rightArm = buildArm(1);

    const telemetry: THREE.Mesh[] = [];
    for (let ringIndex = 0; ringIndex < 2; ringIndex += 1) {
      const ring = new THREE.Mesh(ringGeometry, ringIndex ? eyeMaterial : accentMaterial);
      ring.position.y = 0.33 + ringIndex * 0.16;
      ring.rotation.x = Math.PI / 2;
      ring.scale.setScalar(1 + ringIndex * 0.2);
      root.add(ring);
      telemetry.push(ring);
    }

    return {
      root,
      head,
      leftArm,
      rightArm,
      telemetry,
      bodyMaterial,
      accentMaterial,
      eyeMaterial,
      glowMaterial,
      id: null,
      target: new THREE.Vector3(),
      phase: index * 0.61,
    };
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

  private readonly resize = () => {
    if (this.disposed) return;
    const rect = this.host.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width || this.host.clientWidth || 640));
    this.height = Math.max(1, Math.round(rect.height || this.host.clientHeight || 480));
    this.mobile = this.width <= MOBILE_BREAKPOINT;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.25 : 1.5);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    const signature = `${this.width}:${this.height}:${this.mobile}:${pixelRatio}`;
    if (signature !== this.lastViewportSignature) {
      this.lastViewportSignature = signature;
      this.callbacks.onViewport({ width: this.width, height: this.height, mobile: this.mobile, pixelRatio });
    }
    const ids = Array.from(this.rigById.keys());
    const positions = layoutAgentPositions(ids, this.camera.aspect);
    ids.forEach((id) => {
      const rig = this.rigById.get(id);
      const point = positions.get(id);
      if (rig && point) {
        rig.target.set(point.x, point.y, point.z);
        if (this.reducedMotion) rig.root.position.copy(rig.target);
      }
    });
    this.updateCameraGoal();
    this.requestRender();
  };

  private updateCameraGoal() {
    let target = this.temporaryPoint.set(0, 1.05, 0);
    let distance = 12;
    if (this.preset === "inspect" && this.selectedId) {
      const rig = this.rigById.get(this.selectedId);
      if (rig) {
        target = this.temporaryPoint.copy(rig.target).add(new THREE.Vector3(0, 1.15, 0));
        distance = 5.1;
      }
    } else if (this.preset === "conversation" || this.followTransfer) {
      const active = this.latestRibbon();
      if (active) {
        const source = this.anchorFor(active.sourceId, this.temporaryPoint);
        const targetPoint = this.anchorFor(active.targetId, new THREE.Vector3());
        target = source.add(targetPoint).multiplyScalar(0.5);
        distance = this.followTransfer ? 5.9 : 7.3;
      }
    } else {
      const points = Array.from(this.rigById.values(), (rig) => rig.target.clone());
      points.push(new THREE.Vector3(0, 1, 0));
      const bounds = new THREE.Box3().setFromPoints(points).expandByScalar(1.42);
      bounds.getCenter(this.temporaryPoint);
      this.temporaryPoint.y = Math.max(0.8, this.temporaryPoint.y + 0.7);
      target = this.temporaryPoint;
      distance = computeFitDistance(bounds, this.camera.aspect, this.azimuth, this.elevation);
    }
    distance *= this.zoomScale;
    this.desiredCameraTarget.copy(target);
    const cosine = Math.cos(this.elevation);
    this.desiredCameraPosition.set(
      target.x + Math.sin(this.azimuth) * cosine * distance,
      target.y + Math.sin(this.elevation) * distance,
      target.z + Math.cos(this.azimuth) * cosine * distance,
    );
  }

  private anchorFor(id: string, output: THREE.Vector3) {
    if (id === HQ_ID) return output.set(0, 1.08, 0);
    const rig = this.rigById.get(id);
    if (!rig) return output.set(0, 1.08, 0);
    return output.copy(rig.root.position).add(new THREE.Vector3(0, 1.72, 0));
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
    if (progress > 1.18 && !this.reducedMotion) {
      this.deactivateRibbon(slot);
      return packetOffset;
    }
    const source = this.anchorFor(slot.sourceId, new THREE.Vector3());
    const target = this.anchorFor(slot.targetId, new THREE.Vector3());
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

    const packetCount = slot.cue === "file" ? 4 : slot.cue === "task" ? 2 : 1;
    const color = new THREE.Color(CUE_COLORS[slot.cue] ?? CUE_COLORS.chat);
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
    const motion = this.reducedMotion ? 1 : Math.min(1, delta * 5.8);

    this.rigs.forEach((rig, index) => {
      if (!rig.root.visible) return;
      rig.root.position.lerp(rig.target, motion);
      const phase = now * 0.001 + rig.phase;
      rig.head.rotation.y = this.reducedMotion ? 0 : Math.sin(phase * 0.72) * 0.18;
      rig.leftArm.rotation.z = this.reducedMotion ? 0.08 : 0.08 + Math.sin(phase * 1.1) * 0.1;
      rig.rightArm.rotation.z = this.reducedMotion ? -0.08 : -0.08 - Math.sin(phase * 1.1) * 0.1;
      rig.telemetry.forEach((ring, ringIndex) => {
        ring.rotation.z = this.reducedMotion ? index * 0.1 : phase * (ringIndex ? -0.36 : 0.42);
      });
      rig.glowMaterial.uniforms.uPulse.value = this.reducedMotion ? 0.4 : Math.sin(phase * 2.2) * 0.5 + 0.5;
    });

    this.hq.rotation.y = this.reducedMotion ? 0 : now * 0.00016;
    this.hq.children.forEach((child) => {
      if (child.userData.hqRing !== undefined && !this.reducedMotion) child.rotation.z += delta * (0.18 + child.userData.hqRing * 0.07);
    });

    let packetCount = 0;
    for (const slot of this.ribbons) {
      if (slot.active) packetCount = this.updateRibbon(slot, now, packetCount);
    }
    this.packetInstances.count = packetCount;
    if (packetCount) {
      this.packetInstances.instanceMatrix.needsUpdate = true;
      if (this.packetInstances.instanceColor) this.packetInstances.instanceColor.needsUpdate = true;
    }

    if (this.followTransfer) this.updateCameraGoal();
    const cameraMotion = this.reducedMotion || immediate ? 1 : Math.min(1, delta * 4.8);
    this.camera.position.lerp(this.desiredCameraPosition, cameraMotion);
    this.cameraTarget.lerp(this.desiredCameraTarget, cameraMotion);
    this.camera.lookAt(this.cameraTarget);
    this.camera.updateMatrixWorld();
    this.renderer.render(this.scene, this.camera);
    this.positionOverlays();
    this.renderedFrames += 1;
  }

  private positionOverlays() {
    if (this.disposed || !this.width || !this.height) return;
    const project = (id: string, yOffset: number) => {
      const point = this.anchorFor(id, new THREE.Vector3());
      point.y += yOffset;
      point.project(this.camera);
      return {
        x: (point.x * 0.5 + 0.5) * this.width,
        y: (-point.y * 0.5 + 0.5) * this.height,
        visible: point.z > -1 && point.z < 1,
      };
    };

    this.labels.forEach(({ id, element }) => {
      const active = id === HQ_ID || this.rigById.has(id);
      const screen = project(id, id === HQ_ID ? 0.58 : -0.1);
      if (!active || !screen.visible) {
        element.style.display = "none";
        return;
      }
      const fallbackWidth = id === HQ_ID ? 116 : this.mobile ? 78 : 106;
      const fallbackHeight = this.mobile ? 25 : 38;
      const width = element.offsetWidth || fallbackWidth;
      const height = element.offsetHeight || fallbackHeight;
      const x = clamp(screen.x, width / 2 + 5, this.width - width / 2 - 5);
      const y = clamp(screen.y + (this.mobile ? 8 : 11), 5, this.height - height - 5);
      element.style.display = "";
      element.style.left = `${x}px`;
      element.style.top = `${y}px`;
      element.style.transform = "translateX(-50%)";
    });

    const bubbleInputs: BubbleInput[] = this.bubbles.map(({ id, agentId, element }) => {
      const screen = project(agentId, 0.86);
      const width = element.offsetWidth || (this.mobile ? 196 : 208);
      const height = element.offsetHeight || 104;
      return { id, x: screen.x - width / 2, y: screen.y - height - 18, width, height };
    });
    const placements = placeBubbles(bubbleInputs, { width: this.width, height: this.height }, this.mobile ? 2 : 4);
    const byId = new Map(placements.map((placement) => [placement.id, placement]));
    this.bubbles.forEach(({ id, element }) => {
      const placement = byId.get(id);
      if (!placement || placement.hidden) {
        element.style.display = "none";
        return;
      }
      element.style.display = "";
      element.style.left = `${placement.x}px`;
      element.style.top = `${placement.y}px`;
      element.style.transform = "none";
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
