"use client";

import type { CSSProperties } from "react";

import type { Agent } from "@/lib/dashboard-types";
import type { VisualEventKind } from "@/lib/realtime-visual-events";
import { MuseMark } from "./muse-mark";

export type SpatialPoint = { x: number; y: number; z: number };

type MuseNodeProps = {
  agent: Agent;
  point: SpatialPoint;
  selected: boolean;
  activeKind?: VisualEventKind;
  onSelect: () => void;
};

export function MuseNode({ agent, point, selected, activeKind, onSelect }: MuseNodeProps) {
  const style = {
    "--node-x": `${point.x}%`,
    "--node-y": `${point.y}%`,
    "--node-z": `${point.z}px`,
  } as CSSProperties;

  return (
    <button
      aria-label={`${agent.display_name}, ${agent.role}, ${agent.status}`}
      aria-pressed={selected}
      className={`muse-node muse-node-${agent.status} ${selected ? "muse-node-selected" : ""} ${activeKind ? `muse-node-pulse-${activeKind}` : ""}`}
      onClick={onSelect}
      style={style}
      type="button"
    >
      <span className="muse-node-orbit" aria-hidden="true" />
      <MuseMark active={agent.status === "online" || Boolean(activeKind)} label="" />
      <span className="muse-node-copy">
        <strong>{agent.display_name}</strong>
        <span>{agent.role}</span>
      </span>
      <span className="muse-node-status" aria-hidden="true" />
    </button>
  );
}
