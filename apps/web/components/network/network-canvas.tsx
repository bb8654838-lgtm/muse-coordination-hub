"use client";

import { useMemo, useRef, type KeyboardEvent } from "react";

import type { Agent } from "@/lib/dashboard-types";
import type { VisualTransferEvent } from "@/lib/realtime-visual-events";
import { MuseMark } from "./muse-mark";
import { MuseNode, type SpatialPoint } from "./muse-node";
import { PreviewTransfer } from "./preview-transfer";
import { TransferLayer } from "./transfer-layer";

type NetworkCanvasProps = {
  agents: Agent[];
  transfers: VisualTransferEvent[];
  queuedCount: number;
  realtimeState: string;
  selectedAgentId: string | null;
  onSelectAgent: (agent: Agent) => void;
  onPreview: (event: VisualTransferEvent) => void;
};

const CORE: SpatialPoint = { x: 50, y: 50, z: 60 };

function spatialPoints(agents: Agent[]) {
  const points: Record<string, SpatialPoint> = { "muse-core": CORE, owner: CORE };
  const count = Math.max(agents.length, 1);
  agents.forEach((agent, index) => {
    const angle = -Math.PI / 2 + (index / count) * Math.PI * 2;
    points[agent.id] = {
      x: 50 + Math.cos(angle) * 37,
      y: 50 + Math.sin(angle) * 34,
      z: Math.round(Math.sin(angle + Math.PI / 3) * 130),
    };
  });
  return points;
}

export function NetworkCanvas({
  agents,
  transfers,
  queuedCount,
  realtimeState,
  selectedAgentId,
  onSelectAgent,
  onPreview,
}: NetworkCanvasProps) {
  const activeAgents = agents.filter((agent) => agent.status !== "revoked");
  const points = useMemo(() => spatialPoints(activeAgents), [activeAgents]);
  const networkRef = useRef<HTMLDivElement>(null);
  const latest = transfers.at(-1);

  const activeByAgent = useMemo(() => {
    const result = new Map<string, VisualTransferEvent["kind"]>();
    for (const transfer of transfers) {
      if (points[transfer.sourceId] && transfer.sourceId !== "muse-core") result.set(transfer.sourceId, transfer.kind);
      if (points[transfer.targetId] && transfer.targetId !== "muse-core") result.set(transfer.targetId, transfer.kind);
    }
    return result;
  }, [points, transfers]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const nodes = Array.from(networkRef.current?.querySelectorAll<HTMLButtonElement>("[data-network-node]") ?? []);
    if (!nodes.length) return;
    event.preventDefault();
    const current = nodes.findIndex((node) => node === document.activeElement);
    let next = current < 0 ? 0 : current;
    if (event.key === "ArrowRight") next = (next + 1) % nodes.length;
    if (event.key === "ArrowLeft") next = (next - 1 + nodes.length) % nodes.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = nodes.length - 1;
    nodes[next]?.focus();
    const nextAgent = activeAgents[next];
    if (nextAgent) onSelectAgent(nextAgent);
  }

  return (
    <section className="network-panel" aria-labelledby="constellation-title">
      <header className="network-header">
        <div>
          <div className="network-eyebrow"><span className={`live-dot live-dot-${realtimeState.toLowerCase()}`} /> Live spatial mesh</div>
          <h2 id="constellation-title">Muse Constellation</h2>
          <p>Realtime intent, artifact, and completion flow across your fleet.</p>
        </div>
        <div className="network-telemetry" aria-label="Network telemetry">
          <span><strong>{activeAgents.length}</strong> nodes</span>
          <span><strong>{transfers.length}</strong> in flight</span>
          <span><strong>{queuedCount}</strong> queued</span>
        </div>
      </header>

      <div className="network-stage" onKeyDown={moveFocus} ref={networkRef}>
        <div className="network-grid" aria-hidden="true" />
        <div className="network-orbit network-orbit-one" aria-hidden="true" />
        <div className="network-orbit network-orbit-two" aria-hidden="true" />
        <TransferLayer points={points} transfers={transfers} />
        <div className={`muse-core ${latest ? `muse-core-${latest.kind}` : ""}`} aria-label="Muse coordination core">
          <span className="muse-core-halo" aria-hidden="true" />
          <MuseMark active label="Muse coordination core" />
          <span className="muse-core-copy"><strong>MUSE</strong><span>coordination core</span></span>
        </div>
        {activeAgents.map((agent, index) => (
          <MuseNode
            activeKind={activeByAgent.get(agent.id)}
            agent={agent}
            key={agent.id}
            onSelect={() => onSelectAgent(agent)}
            point={points[agent.id]}
            selected={selectedAgentId === agent.id}
          />
        ))}
        {activeAgents.length === 0 ? (
          <p className="network-empty">Invite an agent to form the first constellation link.</p>
        ) : null}
      </div>

      <div className="network-footer">
        <div className="transfer-legend" aria-label="Transfer legend">
          <span className="legend-chat">Reply</span><span className="legend-task">Task</span><span className="legend-file">Handoff</span><span className="legend-done">Done</span>
        </div>
        <PreviewTransfer agents={activeAgents} onPreview={onPreview} />
      </div>
      <p className="sr-only" aria-live="polite">
        {latest ? `${latest.kind} transfer: ${latest.label}` : "No transfers in flight"}
      </p>
    </section>
  );
}
