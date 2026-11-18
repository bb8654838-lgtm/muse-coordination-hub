export type VisualEventKind = "chat" | "file" | "task" | "done";

export type VisualTransferEvent = {
  id: string;
  kind: VisualEventKind;
  sourceId: string;
  targetId: string;
  label: string;
  createdAt: number;
  durationMs: number;
};

export type WorkspaceRealtimeTable =
  | "agents"
  | "channels"
  | "messages"
  | "tasks"
  | "files"
  | "heartbeats";

export type WorkspaceRealtimePayload = {
  eventType?: string;
  new?: Record<string, unknown>;
  old?: Record<string, unknown>;
};

const MUSE_CORE = "muse-core";

function text(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function firstString(value: unknown) {
  if (!Array.isArray(value)) return "";
  return value.find((entry): entry is string => typeof entry === "string") ?? "";
}

function shortLabel(value: unknown, fallback: string) {
  const label = text(value, fallback).replace(/\s+/g, " ");
  return label.length > 56 ? `${label.slice(0, 53)}…` : label;
}

function eventId(table: WorkspaceRealtimeTable, payload: WorkspaceRealtimePayload, record: Record<string, unknown>) {
  const identity = text(record.id, text(record.agent_id, "workspace"));
  const revision = text(
    record.updated_at,
    text(record.created_at, text(record.recorded_at, text(record.status, String(Date.now())))),
  );
  return `${table}:${payload.eventType ?? "UPDATE"}:${identity}:${revision}`;
}

export function visualEventFromRealtime(
  table: WorkspaceRealtimeTable,
  payload: WorkspaceRealtimePayload,
): VisualTransferEvent | null {
  const record = payload.new && Object.keys(payload.new).length ? payload.new : payload.old ?? {};
  const base = {
    id: eventId(table, payload, record),
    createdAt: Date.now(),
  };

  if (table === "messages") {
    const messageType = text(record.message_type, "NOTE").toUpperCase();
    const kind: VisualEventKind = messageType === "DONE"
      ? "done"
      : messageType === "HANDOFF"
        ? "file"
        : messageType === "TASK"
          ? "task"
          : "chat";
    return {
      ...base,
      kind,
      sourceId: text(record.sender_id, record.sender_type === "owner" ? "owner" : MUSE_CORE),
      targetId: firstString(record.mentions) || MUSE_CORE,
      label: shortLabel(record.body, messageType),
      durationMs: kind === "chat" ? 1450 : kind === "done" ? 2100 : 1850,
    };
  }

  if (table === "files") {
    return {
      ...base,
      kind: "file",
      sourceId: text(record.uploaded_by, MUSE_CORE),
      targetId: text(record.task_id, MUSE_CORE),
      label: shortLabel(record.name, "Secure handoff"),
      durationMs: 1900,
    };
  }

  if (table === "tasks") {
    const completed = text(record.status).toUpperCase() === "DONE";
    return {
      ...base,
      kind: completed ? "done" : "task",
      sourceId: text(record.created_by, MUSE_CORE),
      targetId: text(record.assigned_to, MUSE_CORE),
      label: shortLabel(record.title, completed ? "Task complete" : "Task dispatch"),
      durationMs: completed ? 2200 : 1850,
    };
  }

  if (table === "heartbeats") {
    return {
      ...base,
      kind: "chat",
      sourceId: text(record.agent_id, MUSE_CORE),
      targetId: MUSE_CORE,
      label: "Heartbeat acknowledged",
      durationMs: 1100,
    };
  }

  if (table === "agents") {
    return {
      ...base,
      kind: "chat",
      sourceId: text(record.id, MUSE_CORE),
      targetId: MUSE_CORE,
      label: shortLabel(record.display_name, "Presence updated"),
      durationMs: 1250,
    };
  }

  if (table === "channels" && payload.eventType === "INSERT") {
    return {
      ...base,
      kind: "chat",
      sourceId: "owner",
      targetId: MUSE_CORE,
      label: shortLabel(record.name, "Channel opened"),
      durationMs: 1300,
    };
  }

  return null;
}

export function makePreviewVisualEvent(
  kind: VisualEventKind,
  sourceId: string,
  targetId: string,
): VisualTransferEvent {
  const labels: Record<VisualEventKind, string> = {
    chat: "Realtime reply",
    file: "Encrypted handoff",
    task: "Task dispatch",
    done: "Completion return",
  };
  const duration: Record<VisualEventKind, number> = {
    chat: 1450,
    file: 1900,
    task: 1850,
    done: 2200,
  };
  const token = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    id: `preview:${kind}:${token}`,
    kind,
    sourceId,
    targetId,
    label: labels[kind],
    createdAt: Date.now(),
    durationMs: duration[kind],
  };
}
