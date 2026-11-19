"use client";

import type { FormEvent, RefObject } from "react";
import type { Agent, Channel, Message } from "@/lib/dashboard-types";

const MESSAGE_TYPES: Message["message_type"][] = ["NOTE", "TASK", "HANDOFF", "ALERT", "DONE"];
const COMMAND_CHANNELS = ["general", "handoff", "alerts"];

type CommsViewProps = {
  agents: Agent[];
  channels: Channel[];
  selectedChannelId: string;
  selectedMessages: Message[];
  messageBody: string;
  messageType: Message["message_type"];
  mentionIds: string[];
  busy: string;
  messageEndRef: RefObject<HTMLDivElement | null>;
  onSelectChannel: (id: string) => void;
  onOpenDm: (agent: Agent) => void;
  onMessageBodyChange: (value: string) => void;
  onMessageTypeChange: (value: Message["message_type"]) => void;
  onAddMention: (id: string) => void;
  onRemoveMention: (id: string) => void;
  onSendMessage: (event: FormEvent<HTMLFormElement>) => void;
};

function channelLabel(channel: Channel | undefined, agents: Agent[]) {
  if (!channel) return "Choose a channel";
  if (channel.channel_type === "group") return `#${channel.name}`;
  const agent = agents.find((item) => channel.member_agent_ids.includes(item.id));
  return agent ? `@${agent.display_name}` : "Direct message";
}

export function CommsView(props: CommsViewProps) {
  const selected = props.channels.find((channel) => channel.id === props.selectedChannelId);
  const activeAgents = props.agents.filter((agent) => agent.status !== "revoked");
  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,260px)_minmax(0,1fr)]" data-view="comms">
      <aside className="panel min-w-0 h-fit"><h2 className="text-sm font-semibold text-slate-100">Comms</h2><p className="mt-1 text-xs text-slate-500">general · handoff · alerts</p><div className="mt-4 space-y-1">{props.channels.filter((channel) => channel.channel_type === "group").map((channel) => <button className={`sidebar-link ${channel.id === props.selectedChannelId ? "sidebar-link-active" : ""}`} key={channel.id} onClick={() => props.onSelectChannel(channel.id)} type="button"># {channel.name}</button>)}{!props.channels.some((channel) => COMMAND_CHANNELS.includes(channel.name.toLowerCase())) ? <p className="px-2 py-2 text-[10px] text-slate-600">Workspace channels appear here.</p> : null}</div><p className="section-label mt-6 px-2">Direct links</p><div className="mt-2 space-y-1">{activeAgents.map((agent) => <button className="sidebar-link" key={agent.id} onClick={() => props.onOpenDm(agent)} type="button"><span className="h-1.5 w-1.5 rounded-full bg-emerald-300/70" />{agent.display_name}</button>)}</div></aside>
      <section className="panel min-w-0 flex min-h-[650px] flex-col overflow-hidden p-0"><header className="flex min-w-0 items-center justify-between border-b border-white/[0.07] px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-100">{channelLabel(selected, props.agents)}</h2><p className="mt-1 text-xs text-slate-500">Live typed coordination and replies</p></div><span className="count-pill">{props.selectedMessages.length}</span></header><div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-5 sm:px-5">{props.selectedMessages.map((message) => { const owner = message.sender_type === "owner"; const sender = owner ? "You" : message.sender_type === "system" ? "System" : props.agents.find((agent) => agent.id === message.sender_id)?.display_name ?? "Agent"; return <article className={`flex min-w-0 ${owner ? "justify-end" : "justify-start"}`} key={message.id}><div className={`min-w-0 max-w-[86%] rounded-2xl border px-3.5 py-3 sm:max-w-[72%] ${owner ? "border-emerald-300/15 bg-emerald-300/[0.07]" : "border-white/[0.08] bg-white/[0.035]"}`}><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="rounded-md border border-white/10 px-1.5 py-0.5 text-[9px] font-semibold text-violet-200">{message.message_type}</span><span className="text-[11px] font-medium text-slate-300">{sender}</span><time className="text-[9px] tabular text-slate-600">{new Date(message.created_at).toISOString().slice(11, 16)} UTC</time>{message.reply_to ? <span className="text-[9px] text-sky-300">reply waveform ≈</span> : null}</div><p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-6 text-slate-200">{message.body}</p></div></article>; })}{!props.selectedMessages.length ? <div className="grid min-w-0 flex-1 place-items-center text-center"><p className="text-xs text-slate-600">No messages in this channel.</p></div> : null}<div ref={props.messageEndRef} /></div><form className="border-t border-white/[0.07] bg-black/10 p-4" onSubmit={props.onSendMessage}>{props.mentionIds.length ? <div className="mb-2 flex flex-wrap gap-1">{props.mentionIds.map((id) => <button className="mention-pill" key={id} onClick={() => props.onRemoveMention(id)} type="button">@{props.agents.find((agent) => agent.id === id)?.display_name ?? "agent"} ×</button>)}</div> : null}<textarea className="form-input min-h-24 resize-y" disabled={!selected} maxLength={20000} onChange={(event) => props.onMessageBodyChange(event.target.value)} placeholder={selected ? `Message ${channelLabel(selected, props.agents)}` : "Choose a channel"} required value={props.messageBody} /><div className="mt-2 flex flex-wrap items-center gap-2"><select className="compact-select" onChange={(event) => props.onMessageTypeChange(event.target.value as Message["message_type"])} value={props.messageType}>{MESSAGE_TYPES.map((type) => <option key={type}>{type}</option>)}</select><select aria-label="Mention an agent" className="compact-select min-w-32" onChange={(event) => props.onAddMention(event.target.value)} value=""><option value="">@ Mention</option>{activeAgents.map((agent) => <option key={agent.id} value={agent.id}>@{agent.display_name}</option>)}</select><button className="primary-button ml-auto" disabled={!selected || !props.messageBody.trim() || props.busy === "message"} type="submit">{props.busy === "message" ? "Sending…" : "Send"}</button></div></form></section>
    </div>
  );
}
