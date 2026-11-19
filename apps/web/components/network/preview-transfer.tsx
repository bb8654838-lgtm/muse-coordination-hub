"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { Agent } from "@/lib/dashboard-types";
import { makePreviewVisualEvent, type VisualEventKind, type VisualTransferEvent } from "@/lib/realtime-visual-events";
import type { SceneTransfer } from "./muse-sculpture";

type PreviewTransferProps = {
  agents: Agent[];
  onPreview: (event: VisualTransferEvent) => void;
  onCancel?: (runId: string) => void;
};

export type PreviewStep = { delayMs: number; event: SceneTransfer };

/** Only local, explicitly marked demonstration events; never a live-data assertion. */
export function buildPreviewSteps(agents: readonly Agent[], runId: string, now = Date.now()): PreviewStep[] {
  const participants = agents.filter((agent) => agent.status !== "revoked").slice(0, 10);
  const sender = participants[0]?.id ?? "muse-core";
  const receiver = participants[1]?.id ?? "muse-core";
  const senderName = participants[0]?.display_name ?? "Muse HQ";
  const receiverName = participants[1]?.display_name ?? "Muse HQ";
  const steps: Array<{ delayMs: number; kind: VisualEventKind; sourceId: string; targetId: string; text: string; state?: SceneTransfer["previewState"]; durationMs: number }> = [
    { delayMs: 0, kind: "chat", sourceId: sender, targetId: receiver, text: `${senderName} is thinking (simulated).`, state: "thinking", durationMs: 900 },
    { delayMs: 900, kind: "chat", sourceId: sender, targetId: receiver, text: `${senderName} is composing a message (simulated).`, state: "typing", durationMs: 1000 },
    { delayMs: 2000, kind: "chat", sourceId: sender, targetId: receiver, text: `Preview message from ${senderName}: I have reviewed the telemetry. Can you check the handoff before we return the result to Muse HQ?`, durationMs: 1450 },
    { delayMs: 3500, kind: "chat", sourceId: receiver, targetId: sender, text: `Preview reply from ${receiverName}: Checked. The handoff is ready; sending the demonstration packet cluster now.`, state: "reply", durationMs: 1450 },
    { delayMs: 5100, kind: "file", sourceId: sender, targetId: receiver, text: "Demonstration handoff: preview-telemetry.json. These orbiting packets are a local animation, not upload progress.", durationMs: 1900 },
    { delayMs: 7100, kind: "done", sourceId: receiver, targetId: "muse-core", text: "Preview complete. Demonstration result returned to Muse HQ; nothing was written to the workspace.", durationMs: 1400 },
  ];
  return steps.map((step, index) => ({
    delayMs: step.delayMs,
    event: {
      id: `preview:${runId}:${index}`,
      kind: step.kind,
      sourceId: step.sourceId,
      targetId: step.targetId,
      label: step.text,
      detail: step.text,
      createdAt: now + step.delayMs,
      durationMs: step.durationMs,
      previewRunId: runId,
      ...(step.state ? { previewState: step.state } : {}),
    },
  }));
}

const triggers: Array<{ kind: VisualEventKind; label: string; symbol: string }> = [
  { kind: "chat", label: "Message", symbol: "≈" },
  { kind: "task", label: "Task", symbol: "↗" },
  { kind: "file", label: "Handoff", symbol: "◇" },
  { kind: "done", label: "Done", symbol: "✦" },
];

export function PreviewTransfer({ agents, onPreview, onCancel }: PreviewTransferProps) {
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("Local only · no workspace writes");
  const runRef = useRef<string | null>(null);
  const timerRefs = useRef(new Set<ReturnType<typeof setTimeout>>());
  const participantsRef = useRef<string[]>([]);
  const callbacksRef = useRef({ onPreview, onCancel });
  const agentsRef = useRef(agents);
  callbacksRef.current = { onPreview, onCancel };
  agentsRef.current = agents;

  const clearTimers = useCallback(() => {
    for (const timer of timerRefs.current) clearTimeout(timer);
    timerRefs.current.clear();
  }, []);

  const cancel = useCallback((completed = false) => {
    const runId = runRef.current;
    clearTimers();
    runRef.current = null;
    participantsRef.current = [];
    setRunning(false);
    if (!runId) return;
    // Direct callback cancels the scene immediately, even if the parent queue is busy.
    callbacksRef.current.onCancel?.(runId);
    callbacksRef.current.onPreview({
      id: `preview:${runId}:${completed ? "complete" : "cancel"}`,
      kind: "done",
      sourceId: "muse-core",
      targetId: "muse-core",
      label: completed ? "PREVIEW sequence complete" : "PREVIEW cancelled",
      createdAt: Date.now(),
      durationMs: 1,
      previewRunId: runId,
      previewState: completed ? "complete" : "cancel",
    } as SceneTransfer);
    setNotice(completed ? "Preview complete · nothing was written" : "Preview cancelled · pending effects cleared");
  }, [clearTimers]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) cancel(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimers();
      runRef.current = null;
    };
  }, [cancel, clearTimers]);

  useEffect(() => {
    const available = new Set(agents.filter((agent) => agent.status !== "revoked").map((agent) => agent.id));
    if (participantsRef.current.some((id) => !available.has(id))) cancel();
  }, [agents, cancel]);

  function schedule(delayMs: number, action: () => void) {
    const timer = setTimeout(() => {
      timerRefs.current.delete(timer);
      action();
    }, delayMs);
    timerRefs.current.add(timer);
  }

  function beginRun(kind?: VisualEventKind) {
    cancel();
    const available = agentsRef.current.filter((agent) => agent.status !== "revoked").slice(0, 10);
    const seed = makePreviewVisualEvent(kind ?? "chat", available[0]?.id ?? "muse-core", available[1]?.id ?? "muse-core");
    const runId = seed.id.slice("preview:".length);
    runRef.current = runId;
    participantsRef.current = available.slice(0, 2).map((agent) => agent.id);
    setRunning(true);
    setNotice(kind ? `Preview ${kind} · local animation` : "Preview conversation · simulated states only");

    if (kind) {
      const returning = kind === "done";
      const event: SceneTransfer = {
        ...seed,
        id: `preview:${runId}:single`,
        sourceId: available[0]?.id ?? "muse-core",
        targetId: returning ? "muse-core" : available[1]?.id ?? "muse-core",
        label: kind === "chat" ? "Preview message: a local ribbon between these Sentinels." : kind === "file" ? "Preview handoff: demonstration packets, not byte progress." : kind === "task" ? "Preview task: a local dispatch ribbon." : "Preview completion: a local return to Muse HQ.",
        previewRunId: runId,
      };
      callbacksRef.current.onPreview(event);
      schedule(seed.durationMs + 4200, () => { if (runRef.current === runId) cancel(true); });
      return;
    }

    const steps = buildPreviewSteps(available, runId);
    for (const step of steps) {
      schedule(step.delayMs, () => {
        if (runRef.current !== runId || document.hidden) return;
        callbacksRef.current.onPreview({ ...step.event, createdAt: Date.now() });
      });
    }
    const last = steps.at(-1)!;
    schedule(last.delayMs + last.event.durationMs + 400, () => { if (runRef.current === runId) cancel(true); });
  }

  return (
    <div className="preview-transfer sentinel-preview" aria-label="Preview Animation controls">
      <div className="preview-title"><span className="preview-badge">PREVIEW</span><span className="preview-notice" role="status">{notice}</span></div>
      <div className="preview-transfer-buttons">
        <button className="simulate-chat" onClick={() => beginRun()} type="button"><span aria-hidden="true">◉</span> Simulate Live Chat</button>
        <button className="cancel-preview" disabled={!running} onClick={() => cancel()} type="button">Cancel</button>
        {triggers.map(({ kind, label, symbol }) => (
          <button className={`preview-button preview-button-${kind}`} key={kind} onClick={() => beginRun(kind)} title={`Preview ${label.toLowerCase()} locally; no workspace writes`} type="button"><span aria-hidden="true">{symbol}</span>{label}</button>
        ))}
      </div>
      <style jsx>{`
        .sentinel-preview { width: 100%; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 9px; }
        .preview-title { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
        .preview-badge { font: 700 10px/1.2 var(--font-geist-mono, monospace); letter-spacing: .12em; color: #e3c5ff; border: 1px solid #a78bfa66; border-radius: 5px; padding: 4px 7px; background: #a78bfa14; }
        .preview-notice { font-size: 11px; color: #a3acc2; overflow-wrap: anywhere; }
        .sentinel-preview .preview-transfer-buttons { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
        .sentinel-preview button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; max-width: 100%; padding: 8px 11px; border: 1px solid #29374e; border-radius: 8px; background: #111b2b; color: #d9e5fa; font: inherit; font-size: 12px; line-height: 1.3; white-space: normal; cursor: pointer; }
        .sentinel-preview button:hover { background: #1a2a42; border-color: #7298c6; }
        .sentinel-preview button:focus-visible { outline: 2px solid #60caff; outline-offset: 3px; }
        .sentinel-preview .simulate-chat { border-color: #9063d980; background: linear-gradient(115deg, #40286b, #193657); color: #f3eaff; font-weight: 600; }
        .sentinel-preview .cancel-preview { color: #ffb9cc; }
        .sentinel-preview button:disabled { opacity: .4; cursor: default; }
        .sentinel-preview .preview-button-chat { color: #79dfff; }
        .sentinel-preview .preview-button-task { color: #fbbf24; }
        .sentinel-preview .preview-button-file { color: #d7adff; }
        .sentinel-preview .preview-button-done { color: #6ee7c7; }
        @media (max-width: 640px) { .sentinel-preview button { min-height: 44px; padding: 9px 10px; } .preview-notice { flex: 1 1 160px; } }
        @media (prefers-reduced-motion: reduce) { .sentinel-preview button { transition: none; } }
      `}</style>
    </div>
  );
}
