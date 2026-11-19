"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { DeveloperCredit } from "@/components/developer-credit";
import { MuseMark } from "@/components/network/muse-mark";

export type CommandView = "overview" | "fleet" | "comms" | "pipeline" | "vault";

type CommandCenterShellProps = {
  activeView: CommandView;
  onViewChange: (view: CommandView) => void;
  workspaceName: string;
  userEmail: string;
  agentCount: number;
  agentLimit: number;
  onlineCount: number;
  pendingCount: number;
  activeTaskCount: number;
  latestHeartbeat: string;
  realtimeState: "connecting" | "live" | "degraded";
  queuedTransfers: number;
  notice: string;
  onDismissNotice: () => void;
  onInvite: () => void;
  onAccount: () => void;
  views: Record<CommandView, ReactNode>;
  footerCredit?: ReactNode;
};

const NAV: Array<{ id: CommandView; label: string; glyph: string; hint: string }> = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "Spatial command mesh" },
  { id: "fleet", label: "Fleet", glyph: "⬡", hint: "Agents and access" },
  { id: "comms", label: "Comms", glyph: "≈", hint: "Typed coordination" },
  { id: "pipeline", label: "Pipeline", glyph: "↗", hint: "Task execution" },
  { id: "vault", label: "Vault", glyph: "◇", hint: "Secure handoffs" },
];

export function CommandCenterShell({
  activeView,
  onViewChange,
  workspaceName,
  userEmail,
  agentCount,
  agentLimit,
  onlineCount,
  pendingCount,
  activeTaskCount,
  latestHeartbeat,
  realtimeState,
  queuedTransfers,
  notice,
  onDismissNotice,
  onInvite,
  onAccount,
  views,
  footerCredit,
}: CommandCenterShellProps) {
  const active = NAV.find((item) => item.id === activeView) ?? NAV[0];

  return (
    <main className="command-center min-h-screen bg-dot-grid lg:grid lg:grid-cols-[228px_minmax(0,1fr)]">
      <aside className="command-rail hidden min-h-screen border-r border-white/[0.07] bg-[#060a11]/90 px-3 py-4 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
        <div className="flex items-center gap-3 px-2 py-2">
          <MuseMark active className="h-11 w-11 shrink-0" label="Muse coordination core" />
          <div className="min-w-0"><p className="truncate text-sm font-semibold tracking-wide text-slate-100">MUSE</p><p className="truncate text-[10px] uppercase tracking-[.19em] text-emerald-200/55">Constellation</p></div>
        </div>

        <div className="mt-5 rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
          <div className="flex items-center justify-between gap-3"><p className="section-label">Workspace</p><span className={`live-dot live-dot-${realtimeState}`} /></div>
          <p className="mt-2 truncate text-sm font-medium text-slate-200">{workspaceName}</p>
          <p className="mt-1 text-[11px] text-slate-500">{agentCount} / {agentLimit} fleet slots linked</p>
        </div>

        <nav aria-label="Command center categories" className="mt-6 flex-1 space-y-1">
          {NAV.map((item) => (
            <button
              aria-current={activeView === item.id ? "page" : undefined}
              className={`command-nav ${activeView === item.id ? "command-nav-active" : ""}`}
              key={item.id}
              onClick={() => onViewChange(item.id)}
              type="button"
            >
              <span aria-hidden="true" className="command-nav-glyph">{item.glyph}</span>
              <span><strong>{item.label}</strong><small>{item.hint}</small></span>
            </button>
          ))}
        </nav>

        <div className="rounded-xl border border-white/[0.07] bg-white/[0.025] p-3">
          <div className="flex items-center justify-between"><span className="text-[11px] text-slate-400">Realtime mesh</span><strong className={`text-[10px] uppercase ${realtimeState === "live" ? "text-emerald-300" : realtimeState === "degraded" ? "text-rose-300" : "text-amber-300"}`}>{realtimeState}</strong></div>
          <p className="mt-1 truncate text-[10px] text-slate-600">{userEmail}</p>
        </div>
      </aside>

      <section className="min-w-0 pb-24 lg:pb-0">
        <header className="telemetry-hud sticky top-0 z-40 border-b border-white/[0.07] bg-[#060a11]/88 px-4 py-3 backdrop-blur-xl sm:px-6">
          <div className="mx-auto flex max-w-[1720px] items-center gap-4">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <MuseMark active className="h-9 w-9 shrink-0 lg:hidden" label="Muse" />
              <div className="min-w-0"><h1 className="truncate text-sm font-semibold text-slate-100">{active.label}</h1><p className="truncate text-[11px] text-slate-500">{active.hint} · {workspaceName}</p></div>
            </div>
            <div className="hidden items-center gap-2 xl:flex" aria-label="Live telemetry HUD">
              <span className="hud-chip"><i className="bg-emerald-300" />{onlineCount} online</span>
              <span className="hud-chip"><i className="bg-amber-300" />{pendingCount} pending</span>
              <span className="hud-chip"><i className="bg-sky-300" />{activeTaskCount} active</span>
              <span className="hud-chip"><i className="bg-violet-300" />{queuedTransfers} queued</span>
              <span className="hud-chip tabular">heartbeat {latestHeartbeat}</span>
            </div>
            <Link aria-label="Manage roles and skills" className="secondary-button" href="/admin">Admin</Link>
            <button aria-label="Account settings" className="secondary-button hidden sm:block" onClick={onAccount} type="button">Account</button>
            <button className="primary-button whitespace-nowrap" onClick={onInvite} type="button">Invite agent</button>
          </div>
        </header>

        <div className="mx-auto max-w-[1720px] p-4 sm:p-6">
          {notice ? (
            <div aria-live="polite" className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.06] px-4 py-3 text-xs text-emerald-100">
              <span>{notice}</span><button className="text-emerald-300/75 hover:text-emerald-200" onClick={onDismissNotice} type="button">Dismiss</button>
            </div>
          ) : null}
          {views[activeView]}
          <footer className="mt-8 border-t border-white/[0.06] pt-5">{footerCredit ?? <DeveloperCredit />}</footer>
        </div>
      </section>

      <nav aria-label="Mobile command center categories" className="mobile-command-bar lg:hidden">
        {NAV.map((item) => (
          <button aria-current={activeView === item.id ? "page" : undefined} className={activeView === item.id ? "mobile-command-active" : ""} key={item.id} onClick={() => onViewChange(item.id)} type="button">
            <span aria-hidden="true">{item.glyph}</span><small>{item.label}</small>
          </button>
        ))}
      </nav>
    </main>
  );
}
