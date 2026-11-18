import type { Agent, Channel, Message, Task } from "@/lib/dashboard-types";

export const MESSAGE_TYPES: Message["message_type"][] = ["NOTE", "TASK", "HANDOFF", "ALERT", "DONE"];
export const TASK_STATUSES: Task["status"][] = ["PENDING", "IN_PROGRESS", "BLOCKED", "ESCALATED", "DONE"];

export type AgentPresence = "ONLINE" | "OFFLINE" | "REVOKED";

export function agentPresence(agent: Agent, now: number): AgentPresence {
  if (agent.status === "revoked") return "REVOKED";
  if (!agent.last_seen_at || !now) return "OFFLINE";
  return now - new Date(agent.last_seen_at).getTime() <= 90_000 ? "ONLINE" : "OFFLINE";
}

export function relativeTime(value: string | null, now: number) {
  if (!value || !now) return "Never";
  const seconds = Math.max(0, Math.floor((now - new Date(value).getTime()) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

export function timestamp(value: string) {
  return `${new Date(value).toISOString().slice(11, 16)} UTC`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function channelLabel(channel: Channel | undefined, agents: Agent[]) {
  if (!channel) return "Choose a channel";
  if (channel.channel_type === "group") return `#${channel.name}`;
  const member = agents.find((agent) => channel.member_agent_ids.includes(agent.id));
  return member ? `@${member.display_name}` : "Direct message";
}

export const messageTone: Record<Message["message_type"], string> = {
  NOTE: "border-sky-300/20 bg-sky-300/[0.08] text-sky-200",
  TASK: "border-amber-300/20 bg-amber-300/[0.08] text-amber-200",
  HANDOFF: "border-violet-300/20 bg-violet-300/[0.08] text-violet-200",
  ALERT: "border-rose-300/20 bg-rose-300/[0.08] text-rose-200",
  DONE: "border-emerald-300/20 bg-emerald-300/[0.08] text-emerald-200",
};

export const taskTone: Record<Task["status"], string> = {
  PENDING: "border-slate-300/15 bg-slate-300/[0.05] text-slate-300",
  IN_PROGRESS: "border-sky-300/20 bg-sky-300/[0.07] text-sky-200",
  BLOCKED: "border-amber-300/20 bg-amber-300/[0.07] text-amber-200",
  ESCALATED: "border-rose-300/20 bg-rose-300/[0.07] text-rose-200",
  DONE: "border-emerald-300/20 bg-emerald-300/[0.07] text-emerald-200",
};
