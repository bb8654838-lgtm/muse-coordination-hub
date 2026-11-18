"use client";

import {
  type FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";

import type {
  Agent,
  Channel,
  DashboardSnapshot,
  HandoffFile,
  Message,
  Task,
} from "@/lib/dashboard-types";
import { createBrowserSupabaseClient } from "@/lib/supabase/client";

const PRESENCE_WINDOW_MS = 2 * 60 * 1000;
const TASK_STATUSES: Task["status"][] = [
  "PENDING",
  "IN_PROGRESS",
  "DONE",
  "ESCALATED",
  "BLOCKED",
];
const MESSAGE_TYPES: Message["message_type"][] = [
  "NOTE",
  "TASK",
  "HANDOFF",
  "ALERT",
  "DONE",
];

const taskTone: Record<Task["status"], string> = {
  PENDING: "bg-amber-300",
  IN_PROGRESS: "bg-sky-300",
  DONE: "bg-emerald-300",
  ESCALATED: "bg-violet-300",
  BLOCKED: "bg-rose-300",
};

const messageTone: Record<Message["message_type"], string> = {
  NOTE: "border-sky-300/20 bg-sky-300/[0.08] text-sky-200",
  TASK: "border-violet-300/20 bg-violet-300/[0.08] text-violet-200",
  HANDOFF: "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200",
  ALERT: "border-amber-300/20 bg-amber-300/[0.08] text-amber-200",
  DONE: "border-slate-300/15 bg-slate-300/[0.06] text-slate-300",
};

function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M4.5 15c4 0 5-7.5 8.7-7.5 2.3 0 2.9 2.8 6.3 2.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M4.5 9c4 0 5 7.5 8.7 7.5 2.3 0 2.9-2.8 6.3-2.8" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function Modal({
  title,
  description,
  children,
  onClose,
}: {
  title: string;
  description: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 px-4 py-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-white/10 bg-[#0c131f] p-6 shadow-2xl shadow-black/60">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="modal-title" className="text-base font-semibold text-slate-50">{title}</h2>
            <p className="mt-1 text-xs leading-5 text-slate-500">{description}</p>
          </div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close modal">×</button>
        </div>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function timestamp(value: string) {
  return `${new Date(value).toISOString().slice(11, 16)} UTC`;
}

function relativeSeen(value: string | null, now: number) {
  if (!value || !now) return "Never";
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function presenceFor(agent: Agent, now: number) {
  if (agent.status === "revoked") return "REVOKED" as const;
  if (agent.last_seen_at && now && now - Date.parse(agent.last_seen_at) <= PRESENCE_WINDOW_MS) {
    return "ONLINE" as const;
  }
  return "OFFLINE" as const;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function channelLabel(channel: Channel, agents: Agent[]) {
  if (channel.channel_type === "group") return `#${channel.name}`;
  const agent = agents.find((item) => channel.member_agent_ids.includes(item.id));
  return agent ? `@${agent.display_name}` : "Direct message";
}

function JsonError(response: Response) {
  return response.json().catch(() => null) as Promise<{ error?: { message?: string } } | null>;
}

type TaskDraft = {
  title: string;
  detail: string;
  assignedTo: string;
  channelId: string;
  dueAt: string;
};

export function OwnerDashboard({
  initial,
  user,
}: {
  initial: DashboardSnapshot;
  user: { id: string; email: string };
}) {
  const router = useRouter();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const workspace = initial.workspace;
  const [agents, setAgents] = useState(initial.agents);
  const [channels, setChannels] = useState(initial.channels);
  const [messages, setMessages] = useState(initial.messages);
  const [tasks, setTasks] = useState(initial.tasks);
  const [files, setFiles] = useState(initial.files);
  const firstGroup = initial.channels.find((channel) => channel.channel_type === "group");
  const [selectedChannelId, setSelectedChannelId] = useState(firstGroup?.id ?? "");
  const [messageBody, setMessageBody] = useState("");
  const [messageType, setMessageType] = useState<Message["message_type"]>("NOTE");
  const [mentionIds, setMentionIds] = useState<string[]>([]);
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [realtimeState, setRealtimeState] = useState("CONNECTING");
  const [now, setNow] = useState(0);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteKey, setInviteKey] = useState("");
  const [taskOpen, setTaskOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [taskDraft, setTaskDraft] = useState<TaskDraft>({
    title: "",
    detail: "",
    assignedTo: "",
    channelId: firstGroup?.id ?? "",
    dueAt: "",
  });
  const messageEndRef = useRef<HTMLDivElement>(null);

  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status !== "revoked"),
    [agents],
  );
  const onlineAgents = useMemo(
    () => activeAgents.filter((agent) => presenceFor(agent, now) === "ONLINE"),
    [activeAgents, now],
  );
  const groupChannels = useMemo(
    () => channels.filter((channel) => channel.channel_type === "group"),
    [channels],
  );
  const selectedChannel = channels.find((channel) => channel.id === selectedChannelId);
  const selectedMessages = useMemo(
    () => messages.filter((message) => message.channel_id === selectedChannelId),
    [messages, selectedChannelId],
  );
  const latestSeen = useMemo(
    () => agents.map((agent) => agent.last_seen_at).filter(Boolean).sort().at(-1) ?? null,
    [agents],
  );

  const refresh = useCallback(async () => {
    const id = workspace.id;
    const [agentsResult, channelsResult, messagesResult, tasksResult, filesResult] = await Promise.all([
      supabase.from("agents").select("id, workspace_id, display_name, role, status, last_seen_at, created_at, updated_at").eq("workspace_id", id).order("created_at"),
      supabase.from("channels").select("id, workspace_id, name, channel_type, member_agent_ids, created_at").eq("workspace_id", id).order("created_at"),
      supabase.from("messages").select("id, workspace_id, channel_id, sender_type, sender_id, body, message_type, mentions, reply_to, metadata, created_at").eq("workspace_id", id).order("created_at", { ascending: false }).limit(200),
      supabase.from("tasks").select("id, workspace_id, channel_id, title, detail, assigned_to, created_by, created_by_type, status, due_at, result_link, blocked_reason, locked_by, locked_at, completed_at, created_at, updated_at").eq("workspace_id", id).order("created_at", { ascending: false }),
      supabase.from("files").select("id, workspace_id, task_id, name, content_type, size_bytes, uploaded_by, uploaded_by_type, state, created_at").eq("workspace_id", id).neq("state", "deleted").order("created_at", { ascending: false }),
    ]);

    const error = [agentsResult, channelsResult, messagesResult, tasksResult, filesResult]
      .map((result) => result.error)
      .find(Boolean);
    if (error) throw error;

    setAgents((agentsResult.data ?? []) as Agent[]);
    setChannels((channelsResult.data ?? []) as Channel[]);
    setMessages(((messagesResult.data ?? []) as Message[]).reverse());
    setTasks((tasksResult.data ?? []) as Task[]);
    setFiles((filesResult.data ?? []) as HandoffFile[]);
  }, [supabase, workspace.id]);

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedMessages.length, selectedChannelId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const queueRefresh = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        refresh().catch(() => setNotice("Realtime update received, but refresh failed."));
      }, 120);
    };
    const filter = `workspace_id=eq.${workspace.id}`;
    const realtime = supabase
      .channel(`owner-workspace-${workspace.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "agents", filter }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "channels", filter }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks", filter }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "files", filter }, queueRefresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "heartbeats", filter }, queueRefresh)
      .subscribe((status: string) => {
        if (status === "SUBSCRIBED") setRealtimeState("LIVE");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setRealtimeState("ERROR");
        else setRealtimeState("CONNECTING");
      });

    return () => {
      if (timer) clearTimeout(timer);
      void supabase.removeChannel(realtime);
    };
  }, [refresh, supabase, workspace.id]);

  useEffect(() => {
    if (selectedChannelId && channels.some((channel) => channel.id === selectedChannelId)) return;
    const fallback = channels.find((channel) => channel.channel_type === "group");
    setSelectedChannelId(fallback?.id ?? "");
  }, [channels, selectedChannelId]);

  async function signOut() {
    setBusy("signout");
    await supabase.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = messageBody.trim();
    if (!body || !selectedChannelId) return;
    setBusy("message");
    setNotice("");
    const { data, error } = await supabase
      .from("messages")
      .insert({
        workspace_id: workspace.id,
        channel_id: selectedChannelId,
        sender_type: "owner",
        sender_id: user.id,
        body,
        message_type: messageType,
        mentions: mentionIds,
      })
      .select("id, workspace_id, channel_id, sender_type, sender_id, body, message_type, mentions, reply_to, metadata, created_at")
      .single();
    setBusy("");
    if (error || !data) {
      setNotice("Message could not be sent.");
      return;
    }
    setMessages((current) => current.some((message) => message.id === data.id) ? current : [...current, data as Message]);
    setMessageBody("");
    setMentionIds([]);
  }

  function addMention(agentId: string) {
    if (!agentId || mentionIds.includes(agentId)) return;
    const agent = agents.find((item) => item.id === agentId);
    setMentionIds((current) => [...current, agentId]);
    if (agent) setMessageBody((current) => `${current}${current && !current.endsWith(" ") ? " " : ""}@${agent.display_name} `);
  }

  async function openDm(agent: Agent) {
    const existing = channels.find(
      (channel) => channel.channel_type === "dm" && channel.member_agent_ids.length === 1 && channel.member_agent_ids[0] === agent.id,
    );
    if (existing) {
      setSelectedChannelId(existing.id);
      return;
    }

    setBusy(`dm:${agent.id}`);
    const response = await fetch("/api/owner/channels/dm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id, agent_id: agent.id }),
    });
    setBusy("");
    if (!response.ok) {
      setNotice("Direct channel could not be opened.");
      return;
    }
    const payload = (await response.json()) as { channel: Channel };
    setChannels((current) => current.some((channel) => channel.id === payload.channel.id) ? current : [...current, payload.channel]);
    setSelectedChannelId(payload.channel.id);
  }

  async function revokeAgent(agent: Agent) {
    if (!window.confirm(`Revoke ${agent.display_name}? Its current key will stop working immediately.`)) return;
    setBusy(`revoke:${agent.id}`);
    const response = await fetch(`/api/owner/agents/${agent.id}/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    setBusy("");
    if (!response.ok) {
      setNotice("Agent could not be revoked.");
      return;
    }
    await refresh();
    setNotice(`${agent.display_name} was revoked.`);
  }

  async function rotateInvite() {
    setBusy("invite");
    setInviteKey("");
    const response = await fetch("/api/owner/invite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspace.id }),
    });
    setBusy("");
    if (!response.ok) {
      const payload = await JsonError(response);
      setNotice(payload?.error?.message ?? "Invite key could not be rotated.");
      return;
    }
    const payload = (await response.json()) as { invite_key: string };
    setInviteKey(payload.invite_key);
  }

  async function copyInvite() {
    if (!inviteKey) return;
    try {
      await navigator.clipboard.writeText(inviteKey);
      setNotice("Invite key copied to clipboard.");
    } catch {
      setNotice("Clipboard permission was denied. Copy the key manually.");
    }
  }

  function openTaskModal() {
    setTaskDraft({
      title: "",
      detail: "",
      assignedTo: activeAgents[0]?.id ?? "",
      channelId: selectedChannel?.channel_type === "group" ? selectedChannel.id : groupChannels[0]?.id ?? "",
      dueAt: "",
    });
    setTaskOpen(true);
  }

  async function createTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = taskDraft.title.trim();
    if (!title) return;
    setBusy("task");
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        workspace_id: workspace.id,
        channel_id: taskDraft.channelId || null,
        title,
        detail: taskDraft.detail.trim(),
        assigned_to: taskDraft.assignedTo || null,
        created_by: user.id,
        created_by_type: "owner",
        status: "PENDING",
        due_at: taskDraft.dueAt ? new Date(taskDraft.dueAt).toISOString() : null,
      })
      .select("id, workspace_id, channel_id, title, detail, assigned_to, created_by, created_by_type, status, due_at, result_link, blocked_reason, locked_by, locked_at, completed_at, created_at, updated_at")
      .single();
    setBusy("");
    if (error || !data) {
      setNotice("Task could not be created.");
      return;
    }
    setTasks((current) => [data as Task, ...current.filter((task) => task.id !== data.id)]);
    setTaskOpen(false);
    setNotice("Task created and queued for acknowledgement.");
  }

  async function updatePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (newPassword.length < 12) {
      setNotice("Use at least 12 characters for the new password.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setNotice("Password confirmation does not match.");
      return;
    }
    setBusy("password");
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setBusy("");
    if (error) {
      setNotice("Password could not be updated.");
      return;
    }
    setNewPassword("");
    setConfirmPassword("");
    setAccountOpen(false);
    setNotice("Owner password updated.");
  }

  return (
    <main className="min-h-screen bg-dot-grid lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      <aside className="hidden min-h-screen border-r border-white/[0.08] bg-[#080d15]/90 p-4 backdrop-blur-xl lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col">
        <div className="flex items-center gap-3 px-2 py-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl border border-emerald-200/20 bg-emerald-300/10 text-emerald-200"><Mark /></div>
          <div><p className="text-sm font-semibold text-slate-100">Muse Hub</p><p className="text-xs text-slate-500">Owner console</p></div>
        </div>

        <div className="mt-5 rounded-xl border border-white/[0.08] bg-white/[0.035] p-3">
          <div className="flex items-center justify-between"><p className="section-label">Workspace</p><span className={`h-2 w-2 rounded-full ${realtimeState === "LIVE" ? "bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.7)]" : "bg-amber-300"}`} /></div>
          <p className="mt-2 truncate text-sm font-medium text-slate-200">{workspace.name}</p>
          <p className="mt-1 text-xs text-slate-500">{activeAgents.length} of {workspace.agent_limit} agent slots used</p>
        </div>

        <nav className="mt-7 min-h-0 flex-1 overflow-y-auto" aria-label="Workspace channels">
          <p className="section-label px-2">Channels</p>
          <div className="mt-2 space-y-1">
            {groupChannels.map((channel) => (
              <button key={channel.id} type="button" onClick={() => setSelectedChannelId(channel.id)} className={`sidebar-link ${selectedChannelId === channel.id ? "sidebar-link-active" : ""}`}>
                <span className="text-slate-600">#</span>{channel.name}
              </button>
            ))}
          </div>
          <p className="section-label mt-7 px-2">Direct messages</p>
          <div className="mt-2 space-y-1">
            {activeAgents.map((agent) => {
              const dm = channels.find((channel) => channel.channel_type === "dm" && channel.member_agent_ids.length === 1 && channel.member_agent_ids[0] === agent.id);
              const selected = dm?.id === selectedChannelId;
              const presence = presenceFor(agent, now);
              return (
                <button key={agent.id} type="button" onClick={() => void openDm(agent)} className={`sidebar-link ${selected ? "sidebar-link-active" : ""}`} disabled={busy === `dm:${agent.id}`}>
                  <span className={`h-1.5 w-1.5 rounded-full ${presence === "ONLINE" ? "bg-emerald-300" : "bg-slate-600"}`} />
                  <span className="truncate">{agent.display_name}</span>
                </button>
              );
            })}
            {activeAgents.length === 0 ? <p className="px-2 py-2 text-xs text-slate-600">No active agents</p> : null}
          </div>
        </nav>

        <div className="mt-4 rounded-xl border border-white/[0.08] bg-white/[0.03] p-3">
          <div className="flex items-center justify-between"><p className="text-xs font-medium text-slate-300">Realtime</p><span className={`text-[10px] font-semibold ${realtimeState === "LIVE" ? "text-emerald-300" : realtimeState === "ERROR" ? "text-rose-300" : "text-amber-300"}`}>{realtimeState}</span></div>
          <p className="mt-1 truncate text-[11px] text-slate-600">{user.email}</p>
        </div>
      </aside>

      <section className="min-w-0">
        <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/[0.08] bg-[#080d15]/85 px-4 backdrop-blur-xl sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-emerald-200/20 bg-emerald-300/10 text-emerald-200 lg:hidden"><Mark className="h-5 w-5" /></div>
            <div className="min-w-0"><h1 className="truncate text-sm font-semibold text-slate-100 sm:text-base">{workspace.name}</h1><p className="hidden text-xs text-slate-500 sm:block">Live coordination and owner controls</p></div>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="secondary-button hidden sm:block" onClick={() => setAccountOpen(true)}>Account</button>
            <button type="button" className="secondary-button sm:hidden" onClick={() => setAccountOpen(true)} aria-label="Account settings">⚙</button>
            <button type="button" className="primary-button" onClick={() => { setInviteKey(""); setInviteOpen(true); }}>Invite agent</button>
          </div>
        </header>

        <div className="mx-auto max-w-[1600px] p-4 sm:p-7">
          {notice ? (
            <div className="mb-4 flex items-center justify-between gap-4 rounded-xl border border-emerald-300/15 bg-emerald-300/[0.06] px-4 py-3 text-xs text-emerald-100" aria-live="polite">
              <span>{notice}</span><button type="button" onClick={() => setNotice("")} className="text-emerald-300/70">Dismiss</button>
            </div>
          ) : null}

          <div className="mb-4 flex gap-2 overflow-x-auto pb-1 lg:hidden">
            {groupChannels.map((channel) => <button key={channel.id} type="button" onClick={() => setSelectedChannelId(channel.id)} className={`channel-chip ${selectedChannelId === channel.id ? "channel-chip-active" : ""}`}>#{channel.name}</button>)}
            {activeAgents.map((agent) => <button key={agent.id} type="button" onClick={() => void openDm(agent)} className="channel-chip">@{agent.display_name}</button>)}
          </div>

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Workspace metrics">
            {[
              ["Online agents", `${onlineAgents.length} / ${workspace.agent_limit}`, `${activeAgents.length} registered`],
              ["Pending ACK", String(tasks.filter((task) => task.status === "PENDING").length), "Waiting for an agent"],
              ["Active tasks", String(tasks.filter((task) => task.status === "IN_PROGRESS").length), "Locked and running"],
              ["Latest heartbeat", relativeSeen(latestSeen, now), realtimeState === "LIVE" ? "Realtime connected" : "Connecting realtime"],
            ].map(([label, value, hint], index) => (
              <article key={label} className="metric-card"><div className="flex items-center justify-between"><p className="text-xs text-slate-500">{label}</p><span className={`h-1.5 w-1.5 rounded-full ${index === 0 && onlineAgents.length ? "bg-emerald-300" : "bg-slate-600"}`} /></div><p className="mt-3 text-2xl font-semibold tracking-tight text-slate-100">{value}</p><p className="mt-1 text-[11px] text-slate-600">{hint}</p></article>
            ))}
          </section>

          <div className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_370px]">
            <section className="panel flex min-h-[620px] flex-col overflow-hidden p-0">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-4 sm:px-5">
                <div><div className="flex items-center gap-2"><h2 className="text-sm font-semibold text-slate-100">{selectedChannel ? channelLabel(selectedChannel, agents) : "Choose a channel"}</h2><span className="rounded-md border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold text-slate-500">LIVE</span></div><p className="mt-1 text-xs text-slate-500">Typed coordination messages, delivered in real time</p></div>
                <span className="text-[10px] text-slate-600">{selectedMessages.length} messages</span>
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-5">
                {selectedMessages.map((message) => {
                  const sender = message.sender_type === "owner" ? "You" : message.sender_type === "system" ? "System" : agents.find((agent) => agent.id === message.sender_id)?.display_name ?? "Agent";
                  const isOwner = message.sender_type === "owner";
                  return (
                    <article key={message.id} className={`flex ${isOwner ? "justify-end" : "justify-start"}`}>
                      <div className={`max-w-[86%] rounded-2xl border px-3.5 py-3 sm:max-w-[72%] ${isOwner ? "border-emerald-300/15 bg-emerald-300/[0.07]" : "border-white/[0.08] bg-white/[0.035]"}`}>
                        <div className="flex flex-wrap items-center gap-2"><span className={`rounded-md border px-1.5 py-0.5 text-[9px] font-semibold tracking-wider ${messageTone[message.message_type]}`}>{message.message_type}</span><span className="text-[11px] font-medium text-slate-300">{sender}</span><time className="text-[9px] text-slate-600">{timestamp(message.created_at)}</time></div>
                        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-200">{message.body}</p>
                        {message.mentions.length ? <div className="mt-2 flex flex-wrap gap-1">{message.mentions.map((id) => <span key={id} className="mention-pill">@{agents.find((agent) => agent.id === id)?.display_name ?? "agent"}</span>)}</div> : null}
                      </div>
                    </article>
                  );
                })}
                {selectedMessages.length === 0 ? <div className="grid min-h-80 place-items-center text-center"><div><div className="mx-auto grid h-11 w-11 place-items-center rounded-xl border border-dashed border-white/15 text-slate-600">#</div><p className="mt-3 text-sm text-slate-400">No messages in this channel</p><p className="mt-1 text-xs text-slate-600">Start the coordination thread below.</p></div></div> : null}
                <div ref={messageEndRef} />
              </div>

              <form className="border-t border-white/[0.07] bg-black/10 p-4" onSubmit={sendMessage}>
                {mentionIds.length ? <div className="mb-2 flex flex-wrap gap-1">{mentionIds.map((id) => <button key={id} type="button" className="mention-pill" onClick={() => setMentionIds((current) => current.filter((item) => item !== id))}>@{agents.find((agent) => agent.id === id)?.display_name ?? "agent"} ×</button>)}</div> : null}
                <textarea className="form-input min-h-24 resize-y" placeholder={selectedChannel ? `Message ${channelLabel(selectedChannel, agents)}` : "Choose a channel"} value={messageBody} onChange={(event) => setMessageBody(event.target.value)} disabled={!selectedChannel} maxLength={20000} required />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <select className="compact-select" value={messageType} onChange={(event) => setMessageType(event.target.value as Message["message_type"])}>{MESSAGE_TYPES.map((type) => <option key={type}>{type}</option>)}</select>
                  <select className="compact-select min-w-32" value="" onChange={(event) => addMention(event.target.value)} aria-label="Mention an agent"><option value="">@ Mention</option>{activeAgents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.display_name}</option>)}</select>
                  <button type="submit" className="primary-button ml-auto" disabled={!selectedChannel || !messageBody.trim() || busy === "message"}>{busy === "message" ? "Sending…" : "Send"}</button>
                </div>
              </form>
            </section>

            <aside className="space-y-5">
              <section className="panel" id="agents">
                <div className="flex items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-100">Agents</h2><p className="mt-1 text-xs text-slate-500">Presence from last heartbeat</p></div><span className="count-pill">{activeAgents.length} / {workspace.agent_limit}</span></div>
                <button type="button" className="secondary-button mt-4 w-full" onClick={() => { setInviteKey(""); setInviteOpen(true); }}>Generate / rotate invite key</button>
                <div className="mt-4 space-y-2">
                  {agents.map((agent) => {
                    const presence = presenceFor(agent, now);
                    return (
                      <div key={agent.id} className="rounded-xl border border-white/[0.07] bg-black/10 p-3">
                        <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="flex items-center gap-2"><span className={`h-2 w-2 shrink-0 rounded-full ${presence === "ONLINE" ? "bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.65)]" : presence === "REVOKED" ? "bg-rose-300" : "bg-slate-600"}`} /><p className="truncate text-xs font-medium text-slate-200">{agent.display_name}</p></div><p className="mt-1 truncate pl-4 text-[11px] text-slate-500">{agent.role}</p></div><span className={`text-[9px] font-semibold ${presence === "ONLINE" ? "text-emerald-300" : presence === "REVOKED" ? "text-rose-300" : "text-slate-500"}`}>{presence}</span></div>
                        <div className="mt-2 flex items-center justify-between border-t border-white/[0.05] pt-2"><span className="text-[10px] text-slate-600">{relativeSeen(agent.last_seen_at, now)}</span>{presence !== "REVOKED" ? <button type="button" className="text-[10px] font-medium text-rose-300/80 hover:text-rose-200" onClick={() => void revokeAgent(agent)} disabled={busy === `revoke:${agent.id}`}>{busy === `revoke:${agent.id}` ? "Revoking…" : "Revoke"}</button> : null}</div>
                      </div>
                    );
                  })}
                  {agents.length === 0 ? <p className="rounded-xl border border-dashed border-white/10 px-3 py-8 text-center text-xs text-slate-600">No agents registered</p> : null}
                </div>
              </section>

              <section className="panel">
                <div className="flex items-start justify-between"><div><h2 className="text-sm font-semibold text-slate-100">Handoff files</h2><p className="mt-1 text-xs text-slate-500">Private, signed downloads</p></div><span className="count-pill">{files.length}</span></div>
                <div className="mt-4 space-y-2">
                  {files.slice(0, 6).map((file) => <FileLink key={file.id} file={file} workspaceId={workspace.id} agent={agents.find((agent) => agent.id === file.uploaded_by)} />)}
                  {files.length === 0 ? <p className="rounded-xl border border-dashed border-white/10 px-3 py-7 text-center text-xs text-slate-600">No handoffs uploaded</p> : null}
                </div>
              </section>
            </aside>
          </div>

          <section className="panel mt-5" id="tasks">
            <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-sm font-semibold text-slate-100">Task board</h2><p className="mt-1 text-xs text-slate-500">Live state, assignments, results, and attached handoffs</p></div><button type="button" className="primary-button" onClick={openTaskModal}>New task</button></div>
            <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
              {TASK_STATUSES.map((status) => {
                const statusTasks = tasks.filter((task) => task.status === status);
                return (
                  <div key={status} className="task-column">
                    <div className="flex items-center justify-between"><div className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${taskTone[status]}`} /><h3 className="text-[11px] font-semibold text-slate-300">{status.replace("_", " ")}</h3></div><span className="rounded bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-slate-600">{statusTasks.length}</span></div>
                    <div className="mt-3 space-y-2">
                      {statusTasks.map((task) => {
                        const assignee = agents.find((agent) => agent.id === task.assigned_to);
                        const taskFiles = files.filter((file) => file.task_id === task.id);
                        return (
                          <article key={task.id} className="task-card">
                            <p className="text-xs font-medium leading-5 text-slate-200">{task.title}</p>
                            {task.detail ? <p className="mt-1 line-clamp-3 text-[10px] leading-4 text-slate-500">{task.detail}</p> : null}
                            <div className="mt-3 space-y-1.5 text-[10px] text-slate-500"><p><span className="text-slate-600">Assignee · </span>{assignee?.display_name ?? "Unassigned"}</p>{task.due_at ? <p><span className="text-slate-600">Due · </span>{new Date(task.due_at).toISOString().slice(0, 16).replace("T", " ")} UTC</p> : null}{task.blocked_reason ? <p className="text-rose-300/80">{task.blocked_reason}</p> : null}</div>
                            {task.result_link ? <a className="mt-3 block truncate text-[10px] text-emerald-300 hover:underline" href={task.result_link} target="_blank" rel="noreferrer">Open result ↗</a> : null}
                            {taskFiles.length ? <div className="mt-3 border-t border-white/[0.05] pt-2">{taskFiles.map((file) => <a key={file.id} className="block truncate py-0.5 text-[10px] text-sky-300/80 hover:text-sky-200" href={`/api/owner/files/${file.id}/download?workspace_id=${workspace.id}`}>↳ {file.name}</a>)}</div> : null}
                          </article>
                        );
                      })}
                      {statusTasks.length === 0 ? <p className="rounded-lg border border-dashed border-white/[0.07] px-2 py-8 text-center text-[10px] text-slate-700">No tasks</p> : null}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </section>

      {inviteOpen ? (
        <Modal title="Agent invite key" description="Rotating invalidates the previous workspace invite. Existing agent keys continue to work." onClose={() => { setInviteOpen(false); setInviteKey(""); }}>
          {inviteKey ? <div><p className="text-xs font-medium text-emerald-200">New key generated</p><p className="mt-1 text-xs leading-5 text-slate-500">It is shown once. Store it securely before closing.</p><div className="mt-4 flex gap-2"><input className="form-input font-mono text-xs" readOnly value={inviteKey} aria-label="New invite key" /><button type="button" className="secondary-button" onClick={() => void copyInvite()}>Copy</button></div></div> : <div><div className="rounded-xl border border-amber-300/15 bg-amber-300/[0.06] p-3 text-xs leading-5 text-amber-100">The current invite will stop registering new agents immediately after rotation.</div><button type="button" className="primary-button mt-5 w-full" onClick={() => void rotateInvite()} disabled={busy === "invite"}>{busy === "invite" ? "Generating…" : "Rotate and reveal new key"}</button></div>}
        </Modal>
      ) : null}

      {taskOpen ? (
        <Modal title="Create task" description="Assign work to an agent; pending tasks are atomically claimed through ACK." onClose={() => setTaskOpen(false)}>
          <form className="space-y-4" onSubmit={createTask}>
            <label className="field-label">Title<input className="form-input mt-2" value={taskDraft.title} onChange={(event) => setTaskDraft((draft) => ({ ...draft, title: event.target.value }))} maxLength={240} required /></label>
            <label className="field-label">Detail<textarea className="form-input mt-2 min-h-28 resize-y" value={taskDraft.detail} onChange={(event) => setTaskDraft((draft) => ({ ...draft, detail: event.target.value }))} maxLength={20000} /></label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="field-label">Assign to<select className="form-input mt-2" value={taskDraft.assignedTo} onChange={(event) => setTaskDraft((draft) => ({ ...draft, assignedTo: event.target.value }))}><option value="">Unassigned</option>{activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.display_name} · {agent.role}</option>)}</select></label>
              <label className="field-label">Channel<select className="form-input mt-2" value={taskDraft.channelId} onChange={(event) => setTaskDraft((draft) => ({ ...draft, channelId: event.target.value }))}><option value="">No channel</option>{groupChannels.map((channel) => <option key={channel.id} value={channel.id}>#{channel.name}</option>)}</select></label>
            </div>
            <label className="field-label">Due date (optional)<input className="form-input mt-2" type="datetime-local" value={taskDraft.dueAt} onChange={(event) => setTaskDraft((draft) => ({ ...draft, dueAt: event.target.value }))} /></label>
            <button type="submit" className="primary-button w-full" disabled={busy === "task"}>{busy === "task" ? "Creating…" : "Create and assign task"}</button>
          </form>
        </Modal>
      ) : null}

      {accountOpen ? (
        <Modal title="Owner account" description={user.email} onClose={() => setAccountOpen(false)}>
          <form className="space-y-4" onSubmit={updatePassword}>
            <label className="field-label">New password<input className="form-input mt-2" type="password" autoComplete="new-password" minLength={12} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required /></label>
            <label className="field-label">Confirm password<input className="form-input mt-2" type="password" autoComplete="new-password" minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required /></label>
            <button type="submit" className="primary-button w-full" disabled={busy === "password"}>{busy === "password" ? "Updating…" : "Update password"}</button>
          </form>
          <div className="mt-6 border-t border-white/[0.07] pt-5"><button type="button" className="danger-button w-full" onClick={() => void signOut()} disabled={busy === "signout"}>{busy === "signout" ? "Signing out…" : "Sign out"}</button></div>
        </Modal>
      ) : null}
    </main>
  );
}

function FileLink({ file, workspaceId, agent }: { file: HandoffFile; workspaceId: string; agent?: Agent }) {
  return (
    <a className="block rounded-xl border border-white/[0.07] bg-black/10 p-3 transition hover:border-sky-300/20 hover:bg-sky-300/[0.03]" href={`/api/owner/files/${file.id}/download?workspace_id=${workspaceId}`}>
      <div className="flex items-start justify-between gap-3"><p className="min-w-0 truncate text-xs font-medium text-slate-300">{file.name}</p><span className="shrink-0 text-[9px] text-sky-300">Download</span></div>
      <p className="mt-1 text-[10px] text-slate-600">{formatBytes(file.size_bytes)} · {agent?.display_name ?? file.uploaded_by_type}</p>
    </a>
  );
}
