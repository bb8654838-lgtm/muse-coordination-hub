"use client";

import {
  type FormEvent,
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
import { DeveloperCredit } from "@/components/developer-credit";
import { CommandCenterShell, type CommandView } from "@/components/dashboard/command-center-shell";
import { OverviewView } from "@/components/dashboard/overview-view";
import { FleetView } from "@/components/dashboard/fleet-view";
import { Modal } from "@/components/dashboard/modal";
import { CommsView } from "@/components/dashboard/comms-view";
import { PipelineView } from "@/components/dashboard/pipeline-view";
import { VaultView } from "@/components/dashboard/vault-view";
import { useTransferQueue } from "@/components/hooks/use-transfer-queue";
import { useWorkspaceRealtime } from "@/components/hooks/use-workspace-realtime";

const OWNER_REALTIME_CONTRACT = {
  event: "postgres_changes",
  filter: "workspace_id=eq.",
  subscriptions: [
    { table: "agents" },
    { table: "channels" },
    { table: "messages" },
    { table: "tasks" },
    { table: "files" },
    { table: "heartbeats" },
  ],
} as const; // Implemented by useWorkspaceRealtime; explicit here for the owner-surface contract.

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
  const [now, setNow] = useState(0);
  const [activeView, setActiveView] = useState<CommandView>("overview");
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initial.agents.find((agent) => agent.status !== "revoked")?.id ?? null);
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

  const { transfers, queuedCount, enqueue } = useTransferQueue();
  const realtimeState = useWorkspaceRealtime({
    workspaceId: workspace.id,
    onRefresh: refresh,
    onVisualEvent: enqueue,
  });

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    messageEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedMessages.length, selectedChannelId]);

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
    <>
      <CommandCenterShell
        activeTaskCount={tasks.filter((task) => task.status === "IN_PROGRESS").length}
        activeView={activeView}
        agentCount={activeAgents.length}
        agentLimit={workspace.agent_limit}
        footerCredit={<DeveloperCredit />}
        latestHeartbeat={relativeSeen(latestSeen, now)}
        notice={notice}
        onAccount={() => setAccountOpen(true)}
        onDismissNotice={() => setNotice("")}
        onInvite={() => { setInviteKey(""); setInviteOpen(true); }}
        onViewChange={setActiveView}
        onlineCount={onlineAgents.length}
        pendingCount={tasks.filter((task) => task.status === "PENDING").length}
        queuedTransfers={queuedCount}
        realtimeState={realtimeState}
        userEmail={user.email}
        views={{
          overview: (
            <OverviewView
              agents={agents}
              files={files}
              messages={messages}
              onPreview={enqueue}
              onSelectAgent={(agent) => setSelectedAgentId(agent.id)}
              queuedCount={queuedCount}
              realtimeState={realtimeState}
              selectedAgentId={selectedAgentId}
              tasks={tasks}
              transfers={transfers}
            />
          ),
          fleet: (
            <FleetView
              agentLimit={workspace.agent_limit}
              agents={agents}
              busy={busy}
              now={now}
              onInvite={() => { setInviteKey(""); setInviteOpen(true); }}
              onOpenDm={(agent) => { void openDm(agent); setActiveView("comms"); }}
              onRevoke={(agent) => void revokeAgent(agent)}
            />
          ),
          comms: (
            <CommsView
              agents={agents}
              busy={busy}
              channels={channels}
              mentionIds={mentionIds}
              messageBody={messageBody}
              messageEndRef={messageEndRef}
              messageType={messageType}
              onAddMention={addMention}
              onMessageBodyChange={setMessageBody}
              onMessageTypeChange={setMessageType}
              onOpenDm={(agent) => void openDm(agent)}
              onRemoveMention={(id) => setMentionIds((current) => current.filter((item) => item !== id))}
              onSelectChannel={setSelectedChannelId}
              onSendMessage={sendMessage}
              selectedChannelId={selectedChannelId}
              selectedMessages={selectedMessages}
            />
          ),
          pipeline: <PipelineView agents={agents} files={files} onNewTask={openTaskModal} tasks={tasks} workspaceId={workspace.id} />,
          vault: <VaultView agents={agents} files={files} workspaceId={workspace.id} />,
        }}
        workspaceName={workspace.name}
      />

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
            <div className="grid min-w-0 gap-4 sm:grid-cols-2">
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
    </>
  );
}

function FileLink({ file, workspaceId, agent }: { file: HandoffFile; workspaceId: string; agent?: Agent }) {
  return (
    <a className="block rounded-xl border border-white/[0.07] bg-black/10 p-3 transition hover:border-sky-300/20 hover:bg-sky-300/[0.03]" href={`/api/owner/files/${file.id}/download?workspace_id=${workspaceId}`}>
      <div className="flex min-w-0 items-start justify-between gap-3"><p className="min-w-0 truncate text-xs font-medium text-slate-300">{file.name}</p><span className="shrink-0 text-[9px] text-sky-300">Download</span></div>
      <p className="mt-1 text-[10px] text-slate-600">{formatBytes(file.size_bytes)} · {agent?.display_name ?? file.uploaded_by_type}</p>
    </a>
  );
}
