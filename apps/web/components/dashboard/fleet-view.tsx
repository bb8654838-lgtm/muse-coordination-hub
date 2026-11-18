"use client";

import type { Agent } from "@/lib/dashboard-types";

type FleetViewProps = {
  agents: Agent[];
  agentLimit: number;
  now: number;
  busy: string;
  onInvite: () => void;
  onRevoke: (agent: Agent) => void;
  onOpenDm: (agent: Agent) => void;
};

function heartbeat(agent: Agent, now: number) {
  if (!agent.last_seen_at || !now) return "Never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(agent.last_seen_at)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function presence(agent: Agent, now: number) {
  if (agent.status === "revoked") return "REVOKED";
  return agent.last_seen_at && now - Date.parse(agent.last_seen_at) <= 120_000 ? "ONLINE" : "OFFLINE";
}

export function FleetView({ agents, agentLimit, now, busy, onInvite, onRevoke, onOpenDm }: FleetViewProps) {
  const active = agents.filter((agent) => agent.status !== "revoked");
  return (
    <div className="space-y-5" data-view="fleet">
      <section className="panel flex flex-wrap items-start justify-between gap-4"><div><p className="section-label">Fleet access</p><h2 className="mt-2 text-xl font-semibold text-slate-100">{active.length} of {agentLimit} agents linked</h2><p className="mt-1 text-xs text-slate-500">Presence is derived from the latest heartbeat inside a two-minute window.</p></div><button className="primary-button" onClick={onInvite} type="button">Invite Key</button></section>
      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label="Agent fleet">
        {agents.map((agent) => { const state = presence(agent, now); return <article className="panel" key={agent.id}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex items-center gap-2"><span className={`h-2 w-2 rounded-full ${state === "ONLINE" ? "bg-emerald-300" : state === "REVOKED" ? "bg-rose-300" : "bg-slate-600"}`} /><h3 className="truncate text-sm font-semibold text-slate-200">{agent.display_name}</h3></div><p className="mt-1 truncate text-xs text-slate-500">{agent.role}</p></div><span className={`text-[9px] font-semibold ${state === "ONLINE" ? "text-emerald-300" : state === "REVOKED" ? "text-rose-300" : "text-slate-500"}`}>{state}</span></div><dl className="mt-4 grid grid-cols-2 gap-3 border-t border-white/[0.06] pt-3 text-[10px]"><div><dt className="text-slate-600">Last heartbeat</dt><dd className="mt-1 text-slate-400">{heartbeat(agent, now)}</dd></div><div><dt className="text-slate-600">Registered</dt><dd className="mt-1 text-slate-400">{new Date(agent.created_at).toISOString().slice(0, 10)}</dd></div></dl>{state !== "REVOKED" ? <div className="mt-4 flex gap-2"><button className="secondary-button flex-1" onClick={() => onOpenDm(agent)} type="button">Open Comms</button><button className="danger-button" disabled={busy === `revoke:${agent.id}`} onClick={() => onRevoke(agent)} type="button">{busy === `revoke:${agent.id}` ? "Revoking…" : "Revoke"}</button></div> : null}</article>; })}
        {!agents.length ? <p className="panel text-center text-xs text-slate-600">No agents registered. Generate an Invite Key to link the first node.</p> : null}
      </section>
    </div>
  );
}
