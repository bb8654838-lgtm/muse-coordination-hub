"use client";

import type { Agent } from "@/lib/dashboard-types";
import {
  makePreviewVisualEvent,
  type VisualEventKind,
  type VisualTransferEvent,
} from "@/lib/realtime-visual-events";

type PreviewTransferProps = {
  agents: Agent[];
  onPreview: (event: VisualTransferEvent) => void;
};

const previews: Array<{ kind: VisualEventKind; label: string; symbol: string }> = [
  { kind: "chat", label: "Reply", symbol: "≈" },
  { kind: "task", label: "Task", symbol: "↗" },
  { kind: "file", label: "Handoff", symbol: "◇" },
  { kind: "done", label: "Done", symbol: "✦" },
];

export function PreviewTransfer({ agents, onPreview }: PreviewTransferProps) {
  const first = agents.find((agent) => agent.status !== "revoked");

  function preview(kind: VisualEventKind) {
    const agentId = first?.id ?? "muse-core";
    const returning = kind === "chat" || kind === "done";
    onPreview(
      makePreviewVisualEvent(
        kind,
        returning ? agentId : "muse-core",
        returning ? "muse-core" : agentId,
      ),
    );
  }

  return (
    <div className="preview-transfer" aria-label="Preview Animation controls">
      <span className="preview-transfer-label">Preview Animation</span>
      <div className="preview-transfer-buttons">
        {previews.map(({ kind, label, symbol }) => (
          <button
            className={`preview-button preview-button-${kind}`}
            key={kind}
            onClick={() => preview(kind)}
            title={`Preview ${label.toLowerCase()} transfer locally`}
            type="button"
          >
            <span aria-hidden="true">{symbol}</span>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
