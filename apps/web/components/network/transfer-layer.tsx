"use client";

import type { VisualEventKind, VisualTransferEvent } from "@/lib/realtime-visual-events";
import type { SpatialPoint } from "./muse-node";

type TransferLayerProps = {
  points: Record<string, SpatialPoint>;
  transfers: VisualTransferEvent[];
};

const colors: Record<VisualEventKind, string> = {
  chat: "#60a5fa",
  file: "#a78bfa",
  task: "#fbbf24",
  done: "#6ee7c7",
};

function svgPoint(point: SpatialPoint) {
  return { x: point.x * 10, y: point.y * 6 };
}

function curveFor(source: SpatialPoint, target: SpatialPoint, seed: number) {
  const start = svgPoint(source);
  const end = svgPoint(target);
  if (Math.abs(start.x - end.x) < 2 && Math.abs(start.y - end.y) < 2) {
    const side = seed % 2 ? 1 : -1;
    return `M ${start.x} ${start.y} C ${start.x + 120 * side} ${start.y - 150}, ${start.x + 170 * side} ${start.y + 130}, ${end.x + 3} ${end.y + 3}`;
  }
  const lift = 72 + Math.abs(source.z - target.z) * 0.18 + (seed % 4) * 14;
  const midpointX = (start.x + end.x) / 2 + (seed % 2 ? 26 : -26);
  const midpointY = (start.y + end.y) / 2 - lift;
  return `M ${start.x} ${start.y} Q ${midpointX} ${midpointY} ${end.x} ${end.y}`;
}

export function TransferLayer({ points, transfers }: TransferLayerProps) {
  const fallback = points["muse-core"] ?? { x: 50, y: 50, z: 0 };

  return (
    <svg
      aria-hidden="true"
      className="transfer-layer"
      preserveAspectRatio="none"
      viewBox="0 0 1000 600"
    >
      <defs>
        <filter id="transfer-glow" x="-80%" y="-80%" width="260%" height="260%">
          <feGaussianBlur stdDeviation="5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      {transfers.map((transfer, index) => {
        const source = points[transfer.sourceId] ?? fallback;
        const target = points[transfer.targetId] ?? fallback;
        const path = curveFor(source, target, index);
        const pathId = `transfer-path-${index}-${transfer.id.replace(/[^a-zA-Z0-9_-]/g, "").slice(-24)}`;
        const color = colors[transfer.kind];
        const duration = `${Math.max(0.65, transfer.durationMs / 1000)}s`;
        const targetPoint = svgPoint(target);
        return (
          <g className={`transfer transfer-${transfer.kind}`} key={transfer.id}>
            <path className="transfer-arc" d={path} id={pathId} stroke={color} />
            <circle className="transfer-packet-halo" fill={color} filter="url(#transfer-glow)" r="8">
              <animateMotion dur={duration} fill="freeze" path={path} />
            </circle>
            <circle className="transfer-packet" fill={color} r={transfer.kind === "file" ? 5 : 4}>
              <animateMotion dur={duration} fill="freeze" path={path} />
            </circle>
            {transfer.kind === "done" ? (
              <circle className="transfer-bloom" cx={targetPoint.x} cy={targetPoint.y} fill="none" stroke={color}>
                <animate attributeName="r" begin={duration} dur="700ms" from="5" to="62" fill="freeze" />
                <animate attributeName="opacity" begin={duration} dur="700ms" from="0.9" to="0" fill="freeze" />
              </circle>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
