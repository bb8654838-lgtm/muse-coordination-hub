export type Workspace = {
  id: string;
  name: string;
  owner_id: string;
  agent_limit: number;
  created_at: string;
};

export type Agent = {
  id: string;
  workspace_id: string;
  display_name: string;
  role: string;
  status: "online" | "idle" | "offline" | "revoked";
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Channel = {
  id: string;
  workspace_id: string;
  name: string;
  channel_type: "group" | "dm";
  member_agent_ids: string[];
  created_at: string;
};

export type Message = {
  id: string;
  workspace_id: string;
  channel_id: string;
  sender_type: "owner" | "agent" | "system";
  sender_id: string | null;
  body: string;
  message_type: "NOTE" | "TASK" | "HANDOFF" | "ALERT" | "DONE";
  mentions: string[];
  reply_to: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
};

export type Task = {
  id: string;
  workspace_id: string;
  channel_id: string | null;
  title: string;
  detail: string;
  assigned_to: string | null;
  created_by: string;
  created_by_type: "owner" | "agent";
  status: "PENDING" | "IN_PROGRESS" | "DONE" | "ESCALATED" | "BLOCKED";
  due_at: string | null;
  result_link: string | null;
  blocked_reason: string | null;
  locked_by: string | null;
  locked_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type HandoffFile = {
  id: string;
  workspace_id: string;
  task_id: string | null;
  name: string;
  content_type: string | null;
  size_bytes: number;
  uploaded_by: string;
  uploaded_by_type: "owner" | "agent";
  state: "uploaded" | "picked" | "posted" | "deleted";
  created_at: string;
};

export type DashboardSnapshot = {
  workspace: Workspace;
  agents: Agent[];
  channels: Channel[];
  messages: Message[];
  tasks: Task[];
  files: HandoffFile[];
};
