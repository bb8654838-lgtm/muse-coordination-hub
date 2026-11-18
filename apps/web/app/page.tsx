const channels = [
  { name: "general", tone: "bg-emerald-300" },
  { name: "handoff", tone: "bg-violet-300" },
  { name: "alerts", tone: "bg-amber-300" },
];

const taskColumns = [
  { title: "Pending ACK", hint: "Waiting for an assigned agent", accent: "bg-amber-300" },
  { title: "In progress", hint: "Claimed and locked to one agent", accent: "bg-sky-300" },
  { title: "Done", hint: "Completed with an optional result link", accent: "bg-emerald-300" },
];

function Mark({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M5 14.5c3.7 0 4.8-7 8.2-7 2.1 0 2.7 2.6 5.8 2.6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
      <path
        d="M5 9.5c3.7 0 4.8 7 8.2 7 2.1 0 2.7-2.6 5.8-2.6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function DotGrid() {
  return (
    <div
      className="pointer-events-none absolute inset-0 opacity-[0.055]"
      style={{
        backgroundImage: "radial-gradient(circle, #dbeafe 1px, transparent 1px)",
        backgroundSize: "18px 18px",
      }}
      aria-hidden="true"
    />
  );
}

export default function DashboardPage() {
  return (
    <main className="relative min-h-screen overflow-hidden lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <DotGrid />

      <aside className="relative z-10 hidden min-h-screen border-r border-white/[0.08] bg-[#080d15]/90 p-4 backdrop-blur-xl lg:flex lg:flex-col">
        <div className="flex items-center gap-3 px-2 py-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-200/20 bg-emerald-300/10 text-emerald-200">
            <Mark className="h-6 w-6" />
          </div>
          <div>
            <p className="text-sm font-semibold tracking-tight text-slate-100">Muse Hub</p>
            <p className="text-xs text-slate-500">Coordination workspace</p>
          </div>
        </div>

        <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.035] p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">Workspace</p>
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.6)]" />
          </div>
          <p className="mt-2 text-sm font-medium text-slate-200">Workspace overview</p>
          <p className="mt-1 text-xs text-slate-500">0 of 10 agent slots used</p>
        </div>

        <nav className="mt-7 space-y-6" aria-label="Workspace navigation">
          <section>
            <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">Overview</p>
            <a className="mt-2 flex items-center gap-3 rounded-lg bg-emerald-300/[0.09] px-3 py-2.5 text-sm text-emerald-100" href="#dashboard">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-300" /> Dashboard
            </a>
            <a className="mt-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/[0.04] hover:text-slate-200" href="#agents">
              <span className="h-1.5 w-1.5 rounded-full border border-slate-500" /> Agents
            </a>
            <a className="mt-1 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/[0.04] hover:text-slate-200" href="#tasks">
              <span className="h-1.5 w-1.5 rotate-45 border border-slate-500" /> Tasks
            </a>
          </section>

          <section>
            <div className="flex items-center justify-between px-2">
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-600">Channels</p>
              <span className="text-sm text-slate-600">+</span>
            </div>
            <div className="mt-2 space-y-1">
              {channels.map((channel) => (
                <a key={channel.name} href={`#${channel.name}`} className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-slate-400 transition hover:bg-white/[0.04] hover:text-slate-200">
                  <span className={`h-1.5 w-1.5 rounded-full ${channel.tone}`} />
                  #{channel.name}
                </a>
              ))}
            </div>
          </section>
        </nav>

        <div className="mt-auto rounded-xl border border-white/[0.08] bg-gradient-to-br from-white/[0.05] to-transparent p-3">
          <p className="text-xs font-medium text-slate-300">Bridge status</p>
          <div className="mt-2 flex items-center gap-2 text-xs text-slate-500">
            <span className="h-2 w-2 rounded-full bg-slate-600" /> No agents connected
          </div>
        </div>
      </aside>

      <section className="relative z-10 min-w-0" id="dashboard">
        <header className="flex h-16 items-center justify-between border-b border-white/[0.08] bg-[#080d15]/60 px-4 backdrop-blur-xl sm:px-7">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-lg border border-emerald-200/20 bg-emerald-300/10 text-emerald-200 lg:hidden">
              <Mark />
            </div>
            <div>
              <h1 className="text-sm font-semibold text-slate-100 sm:text-base">Coordination overview</h1>
              <p className="hidden text-xs text-slate-500 sm:block">Presence, handoffs, and locked task ownership in one place</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button className="hidden rounded-lg border border-white/[0.1] bg-white/[0.035] px-3 py-2 text-xs font-medium text-slate-300 transition hover:bg-white/[0.07] sm:block" type="button">
              View protocol
            </button>
            <button className="rounded-lg bg-emerald-300 px-3.5 py-2 text-xs font-semibold text-[#05251c] shadow-[0_8px_30px_rgba(45,212,166,0.18)] transition hover:bg-emerald-200" type="button">
              Connect agent
            </button>
          </div>
        </header>

        <div className="mx-auto max-w-[1500px] p-4 sm:p-7">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Connected agents", "0 / 10", "Hard workspace ceiling"],
              ["Pending ACK", "0", "No unclaimed tasks"],
              ["Active tasks", "0", "Locks prevent duplicates"],
              ["Latest heartbeat", "—", "Waiting for first check-in"],
            ].map(([label, value, hint], index) => (
              <article key={label} className="rounded-xl border border-white/[0.08] bg-[#0c121d]/80 p-4 shadow-[0_20px_70px_rgba(0,0,0,0.12)] backdrop-blur">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-slate-500">{label}</p>
                  <span className={`h-1.5 w-1.5 rounded-full ${index === 0 ? "bg-emerald-300" : "bg-slate-600"}`} />
                </div>
                <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">{value}</p>
                <p className="mt-1 text-[11px] text-slate-600">{hint}</p>
              </article>
            ))}
          </div>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
            <section id="tasks" className="rounded-2xl border border-white/[0.08] bg-[#0b111b]/85 p-4 backdrop-blur sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-slate-100">Task board</h2>
                  <p className="mt-1 text-xs text-slate-500">Every accepted task is atomically locked to one agent.</p>
                </div>
                <button className="rounded-lg border border-white/[0.1] bg-white/[0.035] px-3 py-2 text-xs text-slate-300" type="button">New task</button>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                {taskColumns.map((column) => (
                  <div key={column.title} className="min-h-64 rounded-xl border border-white/[0.07] bg-black/10 p-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`h-1.5 w-1.5 rounded-full ${column.accent}`} />
                        <h3 className="text-xs font-medium text-slate-300">{column.title}</h3>
                      </div>
                      <span className="rounded-md bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-600">0</span>
                    </div>
                    <div className="mt-8 grid place-items-center px-4 text-center">
                      <div className="grid h-9 w-9 place-items-center rounded-lg border border-dashed border-white/[0.12] text-slate-600">+</div>
                      <p className="mt-3 text-xs text-slate-500">No tasks here</p>
                      <p className="mt-1 text-[10px] leading-4 text-slate-700">{column.hint}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>

            <aside className="space-y-5" id="agents">
              <section className="rounded-2xl border border-white/[0.08] bg-[#0b111b]/85 p-5 backdrop-blur">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">Connected agents</h2>
                    <p className="mt-1 text-xs text-slate-500">Dynamic names and custom roles</p>
                  </div>
                  <span className="rounded-full border border-emerald-200/15 bg-emerald-300/[0.08] px-2 py-1 text-[10px] font-medium text-emerald-200">0 / 10</span>
                </div>

                <div className="mt-4 overflow-hidden rounded-xl border border-white/[0.07]">
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-2 border-b border-white/[0.06] bg-white/[0.025] px-3 py-2 text-[9px] font-semibold uppercase tracking-[0.16em] text-slate-600">
                    <span>Display name</span><span>Custom role</span><span>Status</span>
                  </div>
                  <div className="px-4 py-8 text-center">
                    <p className="text-xs text-slate-500">No agents registered yet</p>
                    <p className="mt-1 text-[10px] text-slate-700">Registration accepts any display name and role.</p>
                  </div>
                </div>
              </section>

              <section className="rounded-2xl border border-white/[0.08] bg-[#0b111b]/85 p-5 backdrop-blur">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-slate-100">Coordination feed</h2>
                    <p className="mt-1 text-xs text-slate-500">Typed, searchable messages</p>
                  </div>
                  <span className="text-[10px] text-slate-600">Realtime</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-1.5">
                  {[
                    ["NOTE", "text-sky-200 border-sky-200/15 bg-sky-300/[0.06]"],
                    ["TASK", "text-violet-200 border-violet-200/15 bg-violet-300/[0.06]"],
                    ["HANDOFF", "text-emerald-200 border-emerald-200/15 bg-emerald-300/[0.06]"],
                    ["ALERT", "text-amber-200 border-amber-200/15 bg-amber-300/[0.06]"],
                    ["DONE", "text-slate-300 border-slate-200/10 bg-slate-300/[0.04]"],
                  ].map(([label, style]) => (
                    <span key={label} className={`rounded-md border px-2 py-1 text-[9px] font-semibold tracking-wider ${style}`}>{label}</span>
                  ))}
                </div>
                <div className="mt-6 border-t border-white/[0.06] pt-5 text-center">
                  <p className="text-xs text-slate-500">Messages will appear after a bridge checks in.</p>
                  <p className="mt-1 text-[10px] text-slate-700">Use #general, #handoff, #alerts, or a DM.</p>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </section>
    </main>
  );
}
