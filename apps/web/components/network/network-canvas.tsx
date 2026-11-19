"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { Agent } from "@/lib/dashboard-types";
import type { VisualTransferEvent } from "@/lib/realtime-visual-events";
import type { CameraPreset, SceneTransfer, SentinelStage } from "./muse-sculpture";
import { MuseMark } from "./muse-mark";
import { PreviewTransfer } from "./preview-transfer";

type NetworkCanvasProps = {
  agents: Agent[];
  transfers: VisualTransferEvent[];
  queuedCount: number;
  realtimeState: string;
  selectedAgentId: string | null;
  onSelectAgent: (agent: Agent) => void;
  onPreview: (event: VisualTransferEvent) => void;
};

type SceneModule = typeof import("./muse-sculpture");
type Bubble = { event: SceneTransfer; title: string; mode: "live" | "preview"; cue: string; anchorId: string; unresolved: boolean };
const HQ = "muse-core";
const MAX_REMEMBERED_EVENTS = 1024;

function previewRun(event: SceneTransfer) {
  if (!event.id.startsWith("preview:")) return undefined;
  return event.previewRunId ?? event.id.slice("preview:".length).split(":").slice(0, -1).join(":");
}

function eventSummary(event: SceneTransfer) {
  if (event.id.startsWith("preview:")) return `PREVIEW · ${event.label}`;
  if (/^(heartbeats|agents|channels):/.test(event.id)) return `LIVE presence · ${event.label}`;
  return `LIVE ${event.kind === "chat" ? "message" : event.kind === "file" ? "handoff" : event.kind} · ${event.label}`;
}

/** History remains inspectable but simulated/presence events never replace real activity. */
export function latestActivityFromHistory(events: readonly SceneTransfer[]): SceneTransfer | undefined {
  let latest: SceneTransfer | undefined;
  for (const event of events) {
    if (event.id.startsWith("preview:") || /^(presence|heartbeats|agents|channels):/.test(event.id)) continue;
    if (!Number.isFinite(event.createdAt) || event.createdAt <= 0 || event.createdAt > 8.64e15) continue;
    if (!latest || event.createdAt >= latest.createdAt) latest = event;
  }
  return latest;
}

export function shouldAnimateVisualEvent(event: Pick<SceneTransfer, "createdAt">, now: number, observedAfter = Number.NEGATIVE_INFINITY): boolean {
  return Number.isFinite(event.createdAt) && event.createdAt > observedAfter && now - event.createdAt >= -2000 && now - event.createdAt <= 15000;
}

export function NetworkCanvas({ agents, transfers, queuedCount, realtimeState, selectedAgentId, onSelectAgent, onPreview }: NetworkCanvasProps) {
  const activeAgents = useMemo(() => agents.filter((agent) => agent.status !== "revoked").slice(0, 10), [agents]);
  const [renderMode, setRenderMode] = useState<"loading" | "webgl" | "fallback">("loading");
  const [mobile, setMobile] = useState(false);
  const [preset, setPreset] = useState<CameraPreset>("overview");
  const [followTransfer, setFollowTransfer] = useState(false);
  const [motionReduced, setMotionReduced] = useState(false);
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [detail, setDetail] = useState<Bubble | null>(null);
  const [stageNotice, setStageNotice] = useState("Assembling Muse Sentinels…");
  const networkRef = useRef<HTMLDivElement>(null);
  const mountRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<SentinelStage | null>(null);
  const moduleRef = useRef<SceneModule | null>(null);
  const labelRefs = useRef(new Map<string, HTMLButtonElement>());
  const bubbleRefs = useRef(new Map<string, HTMLButtonElement>());
  const hqRef = useRef<HTMLDivElement>(null);
  const seenIds = useRef(new Set(transfers.map((event) => event.id)));
  const mountedAt = useRef(Date.now());
  const cancelledRuns = useRef(new Set<string>());
  const bubbleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const bubbleEvents = useRef(new Map<string, Bubble>());
  const propsRef = useRef({ activeAgents, transfers, selectedAgentId, onSelectAgent });
  propsRef.current = { activeAgents, transfers, selectedAgentId, onSelectAgent };
  const latest = useMemo(() => latestActivityFromHistory(transfers as readonly SceneTransfer[]), [transfers]);
  const latestTimestamp = useMemo(() => latest ? new Date(latest.createdAt).toISOString() : "", [latest]);
  const latestCue = latest ? moduleRef.current?.classifyVisualEvent(latest).cue ?? latest.kind : null;

  const selectAgent = useCallback((id: string) => {
    const agent = propsRef.current.activeAgents.find((candidate) => candidate.id === id);
    if (!agent) return;
    propsRef.current.onSelectAgent(agent);
    labelRefs.current.get(id)?.focus({ preventScroll: true });
    const related = Array.from(bubbleEvents.current.values()).reverse().find((bubble) => bubble.event.sourceId === id || bubble.event.targetId === id);
    if (related) setDetail(related);
  }, []);

  const cancelPreviewRun = useCallback((runId: string) => {
    if (!runId) return;
    cancelledRuns.current.add(runId);
    while (cancelledRuns.current.size > 64) cancelledRuns.current.delete(cancelledRuns.current.values().next().value!);
    stageRef.current?.cancelPreview(runId);
    for (const [id, bubble] of bubbleEvents.current) {
      if (previewRun(bubble.event) !== runId) continue;
      const timer = bubbleTimers.current.get(id);
      if (timer) clearTimeout(timer);
      bubbleTimers.current.delete(id);
      bubbleEvents.current.delete(id);
    }
    setBubbles((current) => current.filter((bubble) => previewRun(bubble.event) !== runId));
    setDetail((current) => current && previewRun(current.event) === runId ? null : current);
  }, []);

  const drainEvents = useCallback(() => {
    const stage = stageRef.current;
    const api = moduleRef.current;
    if (!stage || !api) return;
    const knownIds = new Set(propsRef.current.activeAgents.map((agent) => agent.id));
    stage.setConversationRoute(latestActivityFromHistory(propsRef.current.transfers as readonly SceneTransfer[]));
    const additions: Bubble[] = [];
    for (const item of propsRef.current.transfers) {
      const event = item as SceneTransfer;
      if (seenIds.current.has(event.id)) continue;
      seenIds.current.add(event.id);
      while (seenIds.current.size > MAX_REMEMBERED_EVENTS) seenIds.current.delete(seenIds.current.values().next().value!);
      const classification = api.classifyVisualEvent(event);
      const runId = previewRun(event);
      if (classification.cue === "cancel") {
        if (runId) cancelPreviewRun(runId);
        continue;
      }
      if (runId && cancelledRuns.current.has(runId)) continue;
      // Pre-mount history is rail-only, including recent history; new events alone start flights.
      if (!shouldAnimateVisualEvent(event, Date.now(), mountedAt.current)) continue;
      stage.receive(event);
      if (classification.cue === "presence") continue;
      const route = api.resolveRoute(event, knownIds);
      const anchorId = classification.cue === "typing" || classification.cue === "thinking" ? route.sourceId : route.targetId;
      const bubble: Bubble = { event, ...classification, anchorId, unresolved: route.unresolved };
      additions.push(bubble);
      bubbleEvents.current.set(event.id, bubble);
      const lifetime = classification.cue === "typing" || classification.cue === "thinking" ? Math.max(900, event.durationMs) : 6200;
      const timer = setTimeout(() => {
        bubbleTimers.current.delete(event.id);
        setBubbles((current) => current.filter((candidate) => candidate.event.id !== event.id));
      }, lifetime);
      bubbleTimers.current.set(event.id, timer);
    }
    if (additions.length) {
      setBubbles((current) => [...current, ...additions].slice(-4));
      // Keep selectable recent detail, without an unbounded event/timer history.
      while (bubbleEvents.current.size > 24) {
        const id = bubbleEvents.current.keys().next().value!;
        const timer = bubbleTimers.current.get(id);
        if (timer) clearTimeout(timer);
        bubbleTimers.current.delete(id);
        bubbleEvents.current.delete(id);
      }
    }
  }, [cancelPreviewRun]);

  useEffect(() => {
    let cancelled = false;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => {
      setMotionReduced(media.matches);
      const stage = stageRef.current;
      if (stage) stage.setReducedMotion(media.matches);
    };
    updateMotion();
    media.addEventListener("change", updateMotion);
    // Mount lifetime only: refreshing agents never creates another WebGL renderer.
    void import("./muse-sculpture").then((api) => {
      if (cancelled || !mountRef.current) return;
      moduleRef.current = api;
      try {
        const stage = new api.SentinelStage(mountRef.current, {
          onSelect: selectAgent,
          onViewport: ({ mobile: small }) => { if (!cancelled) setMobile(small); },
          onFollowChange: (enabled) => { if (!cancelled) setFollowTransfer(enabled); },
          onReady: () => { if (!cancelled) { setRenderMode("webgl"); setStageNotice(""); } },
          onError: () => { if (!cancelled) { setRenderMode("fallback"); setStageNotice("Interactive 3D is unavailable here. Your live workspace remains usable below."); } },
        });
        stageRef.current = stage;
        stage.setReducedMotion(media.matches);
        stage.syncAgents(propsRef.current.activeAgents);
        stage.setSelected(propsRef.current.selectedAgentId);
        drainEvents();
      } catch {
        setRenderMode("fallback");
        setStageNotice("WebGL is unavailable here. Select a Sentinel to inspect the live workspace.");
      }
    }).catch(() => {
      if (!cancelled) { setRenderMode("fallback"); setStageNotice("The 3D scene could not load. Workspace controls remain available."); }
    });
    return () => {
      cancelled = true;
      media.removeEventListener("change", updateMotion);
      for (const timer of bubbleTimers.current.values()) clearTimeout(timer);
      bubbleTimers.current.clear();
      stageRef.current?.dispose();
      stageRef.current = null;
      moduleRef.current = null;
    };
  }, [drainEvents, selectAgent]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage) stage.syncAgents(activeAgents);
  }, [activeAgents]);

  useEffect(() => { stageRef.current?.setSelected(selectedAgentId); }, [selectedAgentId]);
  useEffect(() => { drainEvents(); }, [transfers, drainEvents]);

  const visibleBubbles = bubbles.slice(-(mobile ? 2 : 4));
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const labels = Array.from(labelRefs.current, ([id, element]) => ({ id, element }));
    if (hqRef.current) labels.push({ id: HQ, element: hqRef.current as unknown as HTMLButtonElement });
    stage.registerOverlays({
      labels,
      bubbles: visibleBubbles.flatMap((bubble) => {
        const element = bubbleRefs.current.get(bubble.event.id);
        return element ? [{ id: bubble.event.id, agentId: bubble.anchorId, element }] : [];
      }),
    });
  }, [activeAgents, bubbles, mobile, renderMode]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    if (!(event.target instanceof Element) || !event.target.closest("[data-network-node]")) return;
    const nodes = Array.from(networkRef.current?.querySelectorAll<HTMLButtonElement>("[data-network-node]") ?? []);
    if (!nodes.length) return;
    event.preventDefault();
    const current = nodes.findIndex((node) => node === document.activeElement);
    let next = Math.max(0, current);
    if (event.key === "ArrowRight") next = (next + 1) % nodes.length;
    if (event.key === "ArrowLeft") next = (next - 1 + nodes.length) % nodes.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = nodes.length - 1;
    const id = nodes[next]?.dataset.networkNode;
    if (id) selectAgent(id);
  }

  function changePreset(next: CameraPreset) {
    stageRef.current?.setPreset(next);
    setPreset(next);
  }

  function toggleFollow() {
    const enabled = !followTransfer;
    stageRef.current?.setFollowTransfer(enabled);
    setFollowTransfer(enabled);
  }

  const hasConversation = transfers.some((event) => !/^(heartbeats|agents|channels):/.test(event.id) && (event.kind === "chat" || event.kind === "file" || event.kind === "task"));
  const stageReady = renderMode === "webgl";
  const selectedName = activeAgents.find((agent) => agent.id === selectedAgentId)?.display_name;
  const endpointName = (id: string) => activeAgents.find((agent) => agent.id === id)?.display_name ?? "Muse HQ";

  return (
    <section className="network-panel sentinel-panel min-w-0" aria-labelledby="constellation-title">
      <header className="network-header">
        <div className="sentinel-heading">
          <div className="network-eyebrow"><span className={`live-dot live-dot-${realtimeState.toLowerCase()}`} /> Realtime event mesh</div>
          <h2 id="constellation-title">Muse Sentinels</h2>
          <p>Articulated intelligence. Real messages, presence, and handoffs.</p>
        </div>
        <div className="network-telemetry" aria-label="Network telemetry">
          <span><strong>{activeAgents.length}</strong> sentinels</span>
          <span><strong>{transfers.length}</strong> recent events</span>
          <span><strong>{queuedCount}</strong> queued</span>
        </div>
      </header>

      <div className="sentinel-camera-controls" aria-label="Camera controls">
        <div className="camera-presets">
          <button aria-pressed={preset === "overview"} disabled={!stageReady} onClick={() => changePreset("overview")} type="button">Overview</button>
          <button aria-pressed={preset === "inspect"} disabled={!stageReady || !selectedAgentId} onClick={() => changePreset("inspect")} title="Focus the selected Sentinel" type="button">Inspect</button>
          <button aria-pressed={preset === "conversation"} disabled={!stageReady || !hasConversation} onClick={() => changePreset("conversation")} type="button">Conversation</button>
        </div>
        <div className="camera-secondary">
          <button aria-pressed={followTransfer} disabled={!stageReady || motionReduced} onClick={toggleFollow} type="button"><span aria-hidden="true">◎</span> Follow Transfer</button>
          <button aria-label="Zoom in" disabled={!stageReady} onClick={() => stageRef.current?.zoom("in")} type="button">+</button>
          <button aria-label="Zoom out" disabled={!stageReady} onClick={() => stageRef.current?.zoom("out")} type="button">−</button>
        </div>
      </div>

      <div className={`network-stage sentinel-stage is-${renderMode} ${mobile ? "is-narrow" : ""} ${activeAgents.length <= 4 ? "is-hero h-[380px] sm:h-[440px] lg:h-[520px]" : "h-[520px] sm:h-[580px] lg:h-[660px]"}`} onKeyDown={moveFocus} ref={networkRef} role="group" aria-label="Interactive Muse Sentinel constellation">
        <div className="sentinel-renderer" ref={mountRef} aria-hidden="true" />
        {stageNotice ? <p className="sentinel-stage-status" role="status">{stageNotice}</p> : null}
        {renderMode === "fallback" ? <div className="fallback-hq"><MuseMark active={false} label="Muse HQ" /><strong>MUSE HQ</strong></div> : null}
        <div className="sentinel-hq-label" ref={hqRef}><strong>MUSE</strong><span>coordination reactor</span></div>
        <div className="sentinel-labels">
          {activeAgents.map((agent, index) => (
            <button
              aria-label={`${agent.display_name}, ${agent.role}, ${agent.status}${selectedAgentId === agent.id ? ", selected" : ""}`}
              aria-pressed={selectedAgentId === agent.id}
              className={`sentinel-label status-${agent.status}${selectedAgentId === agent.id ? " is-selected" : ""}`}
              data-network-node={agent.id}
              key={agent.id}
              onClick={() => selectAgent(agent.id)}
              ref={(element) => { if (element) labelRefs.current.set(agent.id, element); else labelRefs.current.delete(agent.id); }}
              tabIndex={selectedAgentId && activeAgents.some((candidate) => candidate.id === selectedAgentId) ? selectedAgentId === agent.id ? 0 : -1 : index === 0 ? 0 : -1}
              title={`${agent.display_name} · ${agent.role} · ${agent.status}`}
              type="button"
            ><span className="sentinel-name"><i aria-hidden="true" />{agent.display_name}</span><span className="sentinel-role">{agent.role}</span></button>
          ))}
        </div>
        <div className="sentinel-bubbles" aria-label="Recent event bubbles">
          {visibleBubbles.map((bubble) => (
            <button
              className={`event-bubble bubble-${bubble.cue} bubble-${bubble.mode}`}
              key={bubble.event.id}
              onClick={() => setDetail(bubble)}
              ref={(element) => { if (element) bubbleRefs.current.set(bubble.event.id, element); else bubbleRefs.current.delete(bubble.event.id); }}
              title="Read full received event text"
              type="button"
            ><span className="bubble-heading"><b>{bubble.mode === "preview" ? "PREVIEW" : "LIVE"}</b><span>{bubble.title}</span></span><span className="bubble-copy">{bubble.event.detail ?? bubble.event.label}</span><span className="bubble-detail-hint">{bubble.unresolved ? "Routed to Muse HQ · " : ""}Tap for details ↗</span></button>
          ))}
        </div>
        {activeAgents.length === 0 ? <p className="network-empty">Invite a Sentinel to form the first constellation link.</p> : null}
        <div className="sentinel-stage-hint" aria-hidden="true">{motionReduced ? "Reduced motion · static overview" : mobile ? "Drag sideways · pinch to zoom" : "Drag to orbit · scroll to zoom"}<span>{selectedName ?? "Overview fits the full fleet"}</span></div>
      </div>

      <div className="sentinel-activity-rail" aria-label="Latest real workspace activity">
        {latest ? (
          <button className="activity-entry" type="button" onClick={() => {
            const classification = moduleRef.current?.classifyVisualEvent(latest) ?? { cue: latest.kind, mode: "live" as const, title: "Received activity" };
            const route = moduleRef.current?.resolveRoute(latest, new Set(activeAgents.map((agent) => agent.id)));
            setDetail({ event: latest, ...classification, anchorId: route?.targetId ?? latest.targetId, unresolved: route?.unresolved ?? false });
          }} title="Inspect the last real received event; this does not replay a flight">
            <span className="activity-dot" aria-hidden="true" />
            <span className="activity-content">
              <span className="activity-heading"><b>Latest received</b><span>{latestCue === "file" ? "HANDOFF" : latestCue === "task" ? "TASK" : latestCue === "done" ? "COMPLETION" : latestCue === "reply" ? "REPLY" : "MESSAGE"}</span><time dateTime={latestTimestamp} title={latestTimestamp}>{latestTimestamp.slice(latestTimestamp.indexOf("T") + 1, latestTimestamp.indexOf("T") + 9)} UTC</time></span>
              <span className="activity-route">{endpointName(latest.sourceId)} <span aria-hidden="true">→</span> {endpointName(latest.targetId)}</span>
              <span className="activity-copy">{latest.detail ?? latest.label}</span>
            </span>
            <span className="activity-open" aria-hidden="true">↗</span>
          </button>
        ) : <p className="activity-empty"><span aria-hidden="true">◉</span> Dock links stay illuminated. Waiting for the first real workspace activity.</p>}
      </div>

      {detail ? (
        <aside className="sentinel-detail" aria-label="Event details">
          <div className="detail-heading"><div><span className={`detail-mode detail-${detail.mode}`}>{detail.mode === "preview" ? "PREVIEW · SIMULATED" : "LIVE · REALTIME"}</span><h3>Event details</h3></div><button aria-label="Close event details" onClick={() => setDetail(null)} type="button">×</button></div>
          <p className="detail-route">{endpointName(detail.event.sourceId)} <span aria-hidden="true">→</span> {endpointName(detail.event.targetId)}{detail.unresolved ? " · unresolved endpoint routed to Muse HQ" : ""}</p>
          <p className="detail-text">{detail.event.detail ?? detail.event.label}</p>
          <p className="detail-note">{detail.mode === "preview" ? "Local demonstration only. No message, task, or file was created." : detail.event.detail !== undefined ? "Full text from the delivered Realtime event. No extra request, invented typing, or byte-progress claim." : "Only a label was supplied for this event. Missing content is not invented, and no extra request is made."}</p>
        </aside>
      ) : null}

      <div className="network-footer sentinel-footer">
        <div className="transfer-legend" aria-label="Transfer legend"><span className="legend-chat">Message ribbons</span><span className="legend-file">Handoff packets</span><span className="legend-task">Task dispatch</span><span className="legend-done">Presence / completion</span></div>
        <PreviewTransfer agents={activeAgents} onPreview={onPreview} onCancel={cancelPreviewRun} />
      </div>
      <p className="sr-only" aria-live="polite">{latest ? eventSummary(latest) : "No recent Realtime events"}</p>
      <style jsx>{`
        .sentinel-panel { min-width: 0; overflow: hidden; background: linear-gradient(160deg, #0e1824, #090d17); }
        .sentinel-panel .network-header { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 14px; padding-bottom: 14px; }
        .sentinel-heading { min-width: 0; flex: 1 1 240px; }
        .sentinel-heading h2 { margin: 5px 0; letter-spacing: -.045em; }
        .sentinel-heading p { max-width: 44ch; font-size: 12px; color: #9caac0; }
        .sentinel-panel .network-telemetry { display: flex; flex-wrap: wrap; gap: 7px; min-width: 0; }
        .sentinel-panel .network-telemetry span { min-width: 0; max-width: 100%; overflow-wrap: anywhere; border: 1px solid #27354c; border-radius: 7px; padding: 6px 8px; font-size: 10px; white-space: normal; background: #0b1320; }
        .sentinel-camera-controls, .camera-presets, .camera-secondary { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
        .sentinel-camera-controls { justify-content: space-between; gap: 10px; margin-bottom: 12px; }
        .sentinel-camera-controls button { max-width: 100%; white-space: normal; overflow-wrap: anywhere; min-height: 35px; min-width: 35px; padding: 7px 10px; border: 1px solid #2a3b54; border-radius: 7px; color: #bacbe4; background: #0d1726; font: inherit; font-size: 11px; cursor: pointer; }
        .sentinel-camera-controls button[aria-pressed="true"] { border-color: #65d5ef88; color: #b8f0ff; background: #17303e; }
        .sentinel-camera-controls button:hover:not(:disabled) { color: #f0f7ff; border-color: #69b4de; }
        .sentinel-camera-controls button:disabled { opacity: .4; cursor: default; }
        .sentinel-camera-controls button:focus-visible, .sentinel-label:focus-visible, .event-bubble:focus-visible { outline: 2px solid #79d9ff; outline-offset: 3px; }
        .sentinel-stage { position: relative; isolation: isolate; width: 100%; min-width: 0; height: 660px; overflow: hidden; border: 1px solid #23324b; border-radius: 15px; background: radial-gradient(ellipse at 50% 45%, #152345 0%, #080e1c 48%, #050912 100%); perspective: none; transform-style: flat; }
        .sentinel-renderer { position: absolute; inset: 0; touch-action: pan-y; }
        .sentinel-renderer :global(canvas) { display: block; width: 100%; height: 100%; touch-action: pan-y; }
        .sentinel-labels, .sentinel-bubbles { position: absolute; inset: 0; pointer-events: none; }
        .sentinel-label { position: absolute; z-index: 5; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 104px; max-width: 148px; min-height: 44px; padding: 6px 10px; border: 1px solid #4c647e88; border-radius: 9px; background: linear-gradient(160deg, #192637f5, #0b1220f5); color: #dde9f5; font: inherit; font-size: 11px; line-height: 1.1; pointer-events: auto; cursor: pointer; white-space: nowrap; will-change: transform; }
        .sentinel-label::before { content: ""; position: absolute; bottom: calc(100% + 2px); left: 50%; width: 1px; height: var(--label-leader-height, 7px); transform: rotate(var(--label-leader-angle, 0deg)); transform-origin: 50% 100%; background: linear-gradient(to top, #7397bf70, #7397bf18); pointer-events: none; }
        .sentinel-stage.is-hero { height: 520px; }
        .sentinel-stage.is-narrow .sentinel-label { width: 84px; min-width: 84px; max-width: 84px; min-height: 36px; padding: 5px 7px; font-size: 10px; }
        .sentinel-stage.is-narrow .sentinel-label-hq { width: 96px; min-width: 96px; max-width: 96px; }
        .sentinel-stage.is-narrow .sentinel-role { display: none; }
        .sentinel-stage.is-narrow .event-bubble { width: min(196px, calc(100% - 28px)); min-height: 44px; max-height: 76px; padding: 7px 9px; }
        .sentinel-stage.is-narrow .bubble-copy { -webkit-line-clamp: 1; font-size: 11px; }
        .sentinel-stage.is-narrow .bubble-detail-hint { font-size: 8px; }
        .sentinel-label[tabindex="0"], .sentinel-label.is-selected { z-index: 2; }
        .sentinel-name { display: flex; justify-content: center; align-items: center; gap: 5px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 600; }
        .sentinel-name i { width: 5px; height: 5px; flex: 0 0 5px; border-radius: 50%; background: #627089; box-shadow: 0 0 6px #62708966; }
        .status-online .sentinel-name i { background: #6ee7c7; box-shadow: 0 0 6px #6ee7c755; }
        .status-idle .sentinel-name i { background: #fbbf24; }
        .sentinel-role { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; color: #8fa7c2; margin-top: 2px; }
        .sentinel-label.is-selected { border-color: #8bdbff; color: #effcff; background: #142b41ee; box-shadow: 0 0 18px #4dc3ff22; }
        .sentinel-hq-label { position: absolute; left: 0; top: 0; width: 116px; text-align: center; pointer-events: none; color: #b7eaff; will-change: transform; }
        .sentinel-hq-label strong { display: block; font-size: 12px; letter-spacing: .2em; }
        .sentinel-hq-label span { display: block; font-size: 9px; color: #839dc4; margin-top: 2px; }
        .event-bubble { position: absolute; left: 0; top: 0; width: 208px; max-width: calc(100% - 24px); display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border: 1px solid #55cfff99; border-radius: 11px; background: #071526f2; color: #e8f5ff; box-shadow: 0 7px 24px #0006, 0 0 17px #5bd4ff16; text-align: left; font: inherit; cursor: pointer; pointer-events: auto; will-change: transform; }
        .bubble-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; font: 600 9px/1.3 var(--font-geist-mono, monospace); letter-spacing: .055em; color: #a9e6ff; }
        .bubble-heading b { padding: 2px 4px; border: 1px solid #71d5fa66; border-radius: 3px; font-size: 8px; }
        .bubble-copy { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
        .bubble-detail-hint { font-size: 9px; color: #95adc7; }
        .bubble-reply { border-color: #f48cddbb; box-shadow: 0 7px 24px #0006, 0 0 17px #ec69da22; }
        .bubble-reply .bubble-heading { color: #ffc0f1; }
        .bubble-file { border-color: #c594ffaa; box-shadow: 0 7px 24px #0006, 0 0 17px #af64ff22; }
        .bubble-file .bubble-heading { color: #ddbfff; }
        .bubble-task { border-color: #fbbf2488; }
        .bubble-task .bubble-heading { color: #ffe09a; }
        .bubble-done { border-color: #6ee7c799; }
        .bubble-done .bubble-heading { color: #9ff5db; }
        .bubble-preview { border-style: dashed; }
        .bubble-preview .bubble-heading b { color: #e3c3ff; border-color: #b58cfa99; }
        .sentinel-stage-status { position: absolute; z-index: 3; left: 16px; right: 16px; top: 15px; padding: 9px 12px; border-radius: 8px; background: #0b1428eb; color: #b8cae7; font-size: 12px; text-align: center; pointer-events: none; }
        .sentinel-stage-hint { position: absolute; left: 13px; right: 13px; bottom: 11px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 5px; font: 9px/1.3 var(--font-geist-mono, monospace); color: #7791b3; pointer-events: none; }
        .sentinel-stage-hint span { max-width: 52%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .is-loading .sentinel-labels, .is-loading .sentinel-hq-label { visibility: hidden; }
        .fallback-hq { position: absolute; top: 75px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 9px; color: #b7eaff; font-size: 11px; }
        .is-fallback .sentinel-hq-label, .is-fallback .sentinel-bubbles { display: none; }
        .is-fallback .sentinel-labels { inset: 230px 15px 55px; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); align-content: start; gap: 10px; }
        .is-fallback .sentinel-label { position: static; width: auto; max-width: 100%; min-height: 44px; }
        .sentinel-detail { margin-top: 12px; padding: 15px; border: 1px solid #395878; border-radius: 11px; background: #0b1726; min-width: 0; }
        .detail-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
        .detail-heading h3 { margin: 5px 0 0; font-size: 14px; color: #deedff; }
        .detail-heading button { min-width: 36px; min-height: 36px; border: 1px solid #314561; border-radius: 7px; color: #c5d7ef; background: #152239; cursor: pointer; font-size: 22px; }
        .detail-mode { font: 600 9px/1.3 var(--font-geist-mono, monospace); letter-spacing: .08em; color: #74dfb9; }
        .detail-preview { color: #c8a0ff; }
        .detail-route { font-size: 11px; color: #9db9d8; overflow-wrap: anywhere; margin: 10px 0; }
        .detail-route span { color: #6bdfff; }
        .detail-text { max-height: 240px; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.65; color: #d9e8fa; }
        .detail-note { margin-top: 10px; font-size: 10px; color: #829bb8; line-height: 1.5; }
        .sentinel-footer { display: flex; flex-direction: column; align-items: stretch; gap: 13px; min-width: 0; padding-top: 15px; }
        .sentinel-footer .transfer-legend { display: flex; flex-wrap: wrap; gap: 10px 13px; font-size: 10px; }
        @media (max-width: 640px) {
          .sentinel-panel .network-header { gap: 9px; }
          .sentinel-heading { flex-basis: 100%; }
          .sentinel-heading p { font-size: 11px; }
          .sentinel-camera-controls { gap: 6px; }
          .camera-presets, .camera-secondary { gap: 5px; }
          .sentinel-camera-controls button { min-height: 44px; min-width: 39px; padding: 8px 9px; }
          .sentinel-stage { height: 520px; border-radius: 11px; }
          .sentinel-label { width: 84px; min-width: 84px; max-width: 84px; min-height: 36px; padding: 5px 7px; font-size: 10px; }
          .sentinel-name { font-size: 10px; gap: 3px; }
          .sentinel-role { display: none; }
          .sentinel-hq-label { width: 96px; }
          .sentinel-hq-label strong { font-size: 10px; }
          .sentinel-hq-label span { font-size: 8px; }
          .event-bubble { width: 196px; padding: 9px 10px; }
          .bubble-copy { font-size: 13px; }
          .is-fallback .sentinel-labels { grid-template-columns: repeat(2, minmax(0, 1fr)); }
          .sentinel-stage-hint { font-size: 8px; }
          .sentinel-detail { padding: 12px; }
        }

        .sentinel-activity-rail { margin-top: 10px; min-width: 0; border: 1px solid #36445e; border-radius: 11px; overflow: hidden; background: linear-gradient(115deg, #1c1731, #0e1929 55%, #0b1421); }
        .activity-entry { display: flex; align-items: center; gap: 11px; width: 100%; min-width: 0; min-height: 76px; padding: 11px 13px; border: 0; background: transparent; color: #c6d8ec; text-align: left; font: inherit; cursor: pointer; }
        .activity-entry:focus-visible { outline: 2px solid #bd97ff; outline-offset: -3px; }
        .activity-dot { flex: 0 0 8px; width: 8px; height: 8px; border-radius: 50%; background: #b38aff; box-shadow: 0 0 9px #9663cc66; }
        .activity-content { flex: 1; min-width: 0; }
        .activity-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 9px; font-size: 9px; line-height: 1.4; letter-spacing: .07em; text-transform: uppercase; }
        .activity-heading b { color: #d3bbff; font-weight: 600; }
        .activity-heading > span { color: #92adc7; }
        .activity-heading time { margin-left: auto; color: #8f9eb6; font-variant-numeric: tabular-nums; letter-spacing: .02em; }
        .activity-route { display: block; margin-top: 3px; font-size: 10px; color: #adc5df; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .activity-route > span { padding: 0 4px; color: #9871cc; }
        .activity-copy { display: block; margin-top: 3px; font-size: 11px; line-height: 1.35; color: #dae3f0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .activity-open { flex: 0 0 auto; color: #be9cec; }
        .activity-empty { display: flex; align-items: center; gap: 9px; padding: 13px; margin: 0; color: #8297b2; font-size: 11px; line-height: 1.6; }
        .activity-empty > span { color: #9973cc; }
        @media (max-width: 639px) { .sentinel-stage.is-hero { height: 380px; } }
        @media (min-width: 640px) and (max-width: 1023px) { .sentinel-stage { height: 580px; } .sentinel-stage.is-hero { height: 440px; } }
        @media (prefers-reduced-motion: reduce) { .sentinel-label, .event-bubble, .sentinel-camera-controls button { transition: none; animation: none; } }
      `}</style>
    </section>
  );
}
