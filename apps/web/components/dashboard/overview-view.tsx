"use client";

import type { Agent, HandoffFile, Message, Task } from "@/lib/dashboard-types";
import type { VisualTransferEvent } from "@/lib/realtime-visual-events";
import { NetworkCanvas } from "@/components/network/network-canvas";

type OverviewViewProps = {
  agents: Agent[];
  tasks: Task[];
  files: HandoffFile[];
  messages: Message[];
  transfers: VisualTransferEvent[];
  queuedCount: number;
  realtimeState: "connecting" | "live" | "degraded";
  selectedAgentId: string | null;
  onSelectAgent: (agent: Agent) => void;
  onPreview: (event: VisualTransferEvent) => void;
};

function ActivityStream({ messages, tasks, files, agents }: Pick<OverviewViewProps, "messages" | "tasks" | "files" | "agents">) {
  const items = [
    ...messages.slice(-5).map((message) => ({ id: `message:${message.id}`, at: message.created_at, kind: message.message_type, text: message.body, actor: message.sender_type === "owner" ? "Owner" : agents.find((agent) => agent.id === message.sender_id)?.display_name ?? "Muse" })),
    ...tasks.slice(0, 5).map((task) => ({ id: `task:${task.id}`, at: task.updated_at, kind: task.status, text: task.title, actor: agents.find((agent) => agent.id === task.assigned_to)?.display_name ?? "Unassigned" })),
    ...files.slice(0, 5).map((file) => ({ id: `file:${file.id}`, at: file.created_at, kind: file.state, text: file.name, actor: agents.find((agent) => agent.id === file.uploaded_by)?.display_name ?? file.uploaded_by_type })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 8);

  return (
    <section className="panel min-w-0" aria-labelledby="activity-title">
      <div className="flex min-w-0 items-center justify-between"><div><h2 id="activity-title" className="text-sm font-semibold text-slate-100">ActivityStream</h2><p className="mt-1 text-xs text-slate-500">Latest coordination signals</p></div><span className="count-pill">{items.length}</span></div>
      <div className="mt-4 space-y-2">
        {items.map((item) => <article className="rounded-xl border border-white/[0.07] bg-black/10 p-3" key={item.id}><div className="flex min-w-0 items-center justify-between gap-3"><span className="text-[9px] font-semibold uppercase tracking-wider text-emerald-300">{item.kind}</span><time className="text-[9px] tabular text-slate-600">{new Date(item.at).toISOString().slice(11, 16)} UTC</time></div><p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-300">{item.text}</p><p className="mt-1 text-[10px] text-slate-600">{item.actor}</p></article>)}
        {!items.length ? <p className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-xs text-slate-600">No activity yet</p> : null}
      </div>
    </section>
  );
}

export function OverviewView(props: OverviewViewProps) {
  const active = props.agents.filter((agent) => agent.status !== "revoked");
  const attention = props.tasks.filter((task) => task.status === "BLOCKED" || task.status === "ESCALATED" || task.status === "PENDING");
  const metrics = [
    ["Fleet", `${active.length} linked`, `${props.agents.length - active.length} revoked`],
    ["In flight", String(props.transfers.length), `${props.queuedCount} queued`],
    ["Attention", String(attention.length), "Pending, blocked, escalated"],
    ["Vault", String(props.files.length), "Secure handoff artifacts"],
  ];
  return (
    <div className="space-y-5 min-w-0" data-view="overview">
      <section className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Overview telemetry">{metrics.map(([label, value, hint]) => <article className="metric-card min-w-0" key={label}><p className="text-xs text-slate-500">{label}</p><p className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">{value}</p><p className="mt-1 text-[11px] text-slate-600">{hint}</p></article>)}</section>
      <NetworkCanvas agents={props.agents} transfers={props.transfers} queuedCount={props.queuedCount} realtimeState={props.realtimeState} selectedAgentId={props.selectedAgentId} onSelectAgent={props.onSelectAgent} onPreview={props.onPreview} />
      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)]">
        <section className="panel min-w-0"><div className="flex min-w-0 items-start justify-between"><div><h2 className="text-sm font-semibold text-slate-100">Needs attention</h2><p className="mt-1 text-xs text-slate-500">Work waiting on an acknowledgement or decision</p></div><span className="count-pill">{attention.length}</span></div><div className="mt-4 grid gap-2 sm:grid-cols-2">{attention.slice(0, 8).map((task) => <article className="task-card min-w-0" key={task.id}><span className="text-[9px] font-semibold text-amber-300">{task.status}</span><p className="mt-1 text-xs font-medium text-slate-200">{task.title}</p>{task.blocked_reason ? <p className="mt-1 text-[10px] text-rose-300/80">{task.blocked_reason}</p> : null}</article>)}{!attention.length ? <p className="text-xs text-slate-600">All clear.</p> : null}</div></section>
        <ActivityStream messages={props.messages} tasks={props.tasks} files={props.files} agents={props.agents} />
      </div>
    </div>
  );
}
