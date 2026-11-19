import "server-only";

import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { authenticateAgent } from "./agent-auth";
import { authorizeWorkspaceOwner } from "./owner-auth";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { isHttpUrl, isUuid } from "./http";

type AuthenticatedAgent = NonNullable<Awaited<ReturnType<typeof authenticateAgent>>>;

const BODY_LIMIT = 64 * 1024;
const PUBLIC_STATUSES = ["queued", "in_progress", "blocked", "done"] as const;
type PublicTaskStatus = (typeof PUBLIC_STATUSES)[number];
type DatabaseTaskStatus = "PENDING" | "IN_PROGRESS" | "BLOCKED" | "DONE";
type DatabaseClient = ReturnType<typeof createAdminSupabaseClient>;

const TO_DATABASE_STATUS: Record<PublicTaskStatus, DatabaseTaskStatus> = {
  queued: "PENDING",
  in_progress: "IN_PROGRESS",
  blocked: "BLOCKED",
  done: "DONE",
};
const TO_PUBLIC_STATUS: Record<DatabaseTaskStatus, PublicTaskStatus> = {
  PENDING: "queued",
  IN_PROGRESS: "in_progress",
  BLOCKED: "blocked",
  DONE: "done",
};

export class TaskApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type OwnerActor = {
  kind: "owner";
  workspaceId: string;
  actorId: string;
};
type AgentActor = {
  kind: "agent";
  workspaceId: string;
  actorId: string;
  agent: AuthenticatedAgent;
};
type TaskActor = OwnerActor | AgentActor;

type TaskRow = {
  id: string;
  workspace_id: string;
  assigned_to: string | null;
  status: DatabaseTaskStatus;
  blocked_reason: string | null;
  locked_by: string | null;
  locked_at: string | null;
  completed_at: string | null;
  updated_at: string;
  [key: string]: unknown;
};

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, name: string, maximum: number, optional = false) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string") throw new TaskApiError("invalid_request", `${name} must be a string.`, 400);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new TaskApiError("invalid_request", `${name} must contain between 1 and ${maximum} characters.`, 400);
  }
  return normalized;
}

function nullableStringField(value: unknown, name: string, maximum: number) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return stringField(value, name, maximum);
}

function timestampField(value: unknown, name: string) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 100 || Number.isNaN(Date.parse(value))) {
    throw new TaskApiError("invalid_request", `${name} must be an ISO timestamp or null.`, 400);
  }
  return new Date(value).toISOString();
}

function statusField(value: unknown): PublicTaskStatus | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !PUBLIC_STATUSES.includes(value as PublicTaskStatus)) {
    throw new TaskApiError("invalid_status", `status must be one of: ${PUBLIC_STATUSES.join(", ")}.`, 400);
  }
  return value as PublicTaskStatus;
}

function idField(value: unknown, name: string, nullable = false) {
  if (nullable && value === null) return null;
  if (!isUuid(value)) throw new TaskApiError("invalid_request", `${name} must be a valid UUID${nullable ? " or null" : ""}.`, 400);
  return value;
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    throw new TaskApiError("forbidden", "Cross-origin owner writes are not allowed.", 403);
  }
}

async function readBody(request: Request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
    throw new TaskApiError("invalid_content_type", "Use application/json.", 415);
  }
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > BODY_LIMIT) throw new TaskApiError("payload_too_large", "Request body is too large.", 413);
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > BODY_LIMIT) throw new TaskApiError("payload_too_large", "Request body is too large.", 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new TaskApiError("invalid_json", "A valid JSON object is required.", 400); }
  if (!object(body)) throw new TaskApiError("invalid_request", "A JSON object is required.", 400);
  return body;
}

function permissionEnabled(configuration: unknown, permission: string) {
  return object(configuration) && object(configuration.permissions) && configuration.permissions[permission] === true;
}

async function requireEffectiveAgentPermission(db: DatabaseClient, agent: AuthenticatedAgent, permission: "delegate") {
  const { data: state, error: stateError } = await db
    .from("agent_config_state")
    .select("desired_revision,applied_revision,desired_configuration")
    .eq("workspace_id", agent.workspace_id)
    .eq("agent_id", agent.id)
    .maybeSingle();
  if (stateError) throw new TaskApiError("service_unavailable", "Task authorization is temporarily unavailable.", 503);
  if (!state || !permissionEnabled(state.desired_configuration, permission) || !Number.isInteger(state.applied_revision) || state.applied_revision < 1) {
    throw new TaskApiError("forbidden", `The applied agent configuration does not allow ${permission}.`, 403);
  }

  const { data: applied, error: revisionError } = await db
    .from("agent_config_revisions")
    .select("configuration")
    .eq("workspace_id", agent.workspace_id)
    .eq("agent_id", agent.id)
    .eq("revision", state.applied_revision)
    .maybeSingle();
  if (revisionError) throw new TaskApiError("service_unavailable", "Task authorization is temporarily unavailable.", 503);
  if (!applied || !permissionEnabled(applied.configuration, permission)) {
    throw new TaskApiError("forbidden", `The applied agent configuration does not allow ${permission}.`, 403);
  }
}

async function resolveActor(request: Request, requestedWorkspaceId: unknown, permission: "delegate" = "delegate"): Promise<TaskActor> {
  const db = createAdminSupabaseClient();
  if (request.headers.has("authorization")) {
    const agent = await authenticateAgent(request as NextRequest);
    if (!agent) throw new TaskApiError("unauthorized", "A valid agent bearer token is required.", 401);
    if (requestedWorkspaceId !== undefined && requestedWorkspaceId !== null && requestedWorkspaceId !== "" && requestedWorkspaceId !== agent.workspace_id) {
      throw new TaskApiError("forbidden", "The requested workspace does not match the agent workspace.", 403);
    }
    await requireEffectiveAgentPermission(db, agent, permission);
    return { kind: "agent", workspaceId: agent.workspace_id, actorId: agent.id, agent };
  }

  if (!isUuid(requestedWorkspaceId)) throw new TaskApiError("invalid_workspace", "A valid workspace_id is required.", 400);
  const authorization = await authorizeWorkspaceOwner(requestedWorkspaceId);
  if (!authorization.ok) {
    throw new TaskApiError(
      authorization.status === 401 ? "unauthorized" : "forbidden",
      authorization.status === 401 ? "Sign in as the workspace owner." : "Workspace owner access is required.",
      authorization.status,
    );
  }
  return { kind: "owner", workspaceId: requestedWorkspaceId, actorId: authorization.user.id };
}

async function requireAssignableAgent(db: DatabaseClient, workspaceId: string, agentId: string) {
  const { data, error } = await db.from("agents").select("id,status").eq("workspace_id", workspaceId).eq("id", agentId).maybeSingle();
  if (error) throw new TaskApiError("service_unavailable", "Agent validation is temporarily unavailable.", 503);
  if (!data || data.status === "revoked") throw new TaskApiError("agent_not_found", "The assigned agent is not active in this workspace.", 404);
}

function serializeTask(task: TaskRow) {
  return { ...task, status: TO_PUBLIC_STATUS[task.status] ?? String(task.status).toLowerCase() };
}

function databaseFailure(message: string): never {
  throw new TaskApiError("service_unavailable", message, 503);
}

export async function listTasks(request: Request) {
  const url = new URL(request.url);
  const actor = await resolveActor(request, url.searchParams.get("workspace_id"));
  const db = createAdminSupabaseClient();
  const status = statusField(url.searchParams.get("status") ?? undefined);
  const assignedParameter = url.searchParams.get("assigned_to");
  const assignedTo = assignedParameter === "me" && actor.kind === "agent"
    ? actor.agent.id
    : assignedParameter === null ? undefined : idField(assignedParameter, "assigned_to");
  const parsedLimit = Number(url.searchParams.get("limit") ?? "100");
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 200) {
    throw new TaskApiError("invalid_request", "limit must be an integer between 1 and 200.", 400);
  }

  let query = db.from("tasks").select("*").eq("workspace_id", actor.workspaceId);
  if (status) query = query.eq("status", TO_DATABASE_STATUS[status]);
  if (assignedTo) query = query.eq("assigned_to", assignedTo);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(parsedLimit);
  if (error) databaseFailure("Tasks could not be loaded.");
  return { tasks: ((data ?? []) as TaskRow[]).map(serializeTask) };
}

export async function createTask(request: Request) {
  const body = await readBody(request);
  const urlWorkspace = new URL(request.url).searchParams.get("workspace_id");
  if (body.workspace_id !== undefined && urlWorkspace && body.workspace_id !== urlWorkspace) {
    throw new TaskApiError("invalid_workspace", "Body and query workspace_id values must match.", 400);
  }
  const requestedWorkspace = body.workspace_id ?? urlWorkspace;
  const actor = await resolveActor(request, requestedWorkspace);
  if (actor.kind === "owner") sameOrigin(request);

  const assignedTo = idField(body.assigned_to, "assigned_to") as string;
  const title = stringField(body.title, "title", 240);
  const detail = stringField(body.detail, "detail", 20_000);
  const status = statusField(body.status);
  if (status && status !== "queued") throw new TaskApiError("invalid_status", "New tasks must start with queued status.", 400);
  const dueAt = timestampField(body.due_at, "due_at");
  const channelId = body.channel_id === undefined ? undefined : idField(body.channel_id, "channel_id", true);
  const db = createAdminSupabaseClient();
  await requireAssignableAgent(db, actor.workspaceId, assignedTo);

  const payload = {
    workspace_id: actor.workspaceId,
    channel_id: channelId ?? null,
    created_by: actor.actorId,
    created_by_type: actor.kind,
    assigned_to: assignedTo,
    title,
    detail,
    status: "PENDING" as const,
    due_at: dueAt ?? null,
  };
  const { data, error } = await db.from("tasks").insert(payload).select("*").single();
  if (error || !data) databaseFailure("The task could not be created.");
  return { task: serializeTask(data as TaskRow) };
}

export async function updateTask(request: Request, taskId: string) {
  if (!isUuid(taskId)) throw new TaskApiError("invalid_task", "A valid task id is required.", 400);
  const body = await readBody(request);
  const urlWorkspace = new URL(request.url).searchParams.get("workspace_id");
  if (body.workspace_id !== undefined && urlWorkspace && body.workspace_id !== urlWorkspace) {
    throw new TaskApiError("invalid_workspace", "Body and query workspace_id values must match.", 400);
  }
  const actor = await resolveActor(request, body.workspace_id ?? urlWorkspace);
  if (actor.kind === "owner") sameOrigin(request);
  const db = createAdminSupabaseClient();

  const { data: currentData, error: currentError } = await db.from("tasks").select("*").eq("workspace_id", actor.workspaceId).eq("id", taskId).maybeSingle();
  if (currentError) databaseFailure("The task could not be loaded.");
  if (!currentData) throw new TaskApiError("task_not_found", "Task not found in this workspace.", 404);
  const current = currentData as TaskRow;

  const allowed = new Set(["workspace_id", "assigned_to", "title", "detail", "status", "blocked_reason", "result_link", "due_at"]);
  const unknown = Object.keys(body).filter(key => !allowed.has(key));
  if (unknown.length) throw new TaskApiError("invalid_request", `Unsupported field: ${unknown[0]}.`, 400);

  const patch: Record<string, unknown> = {};
  if (body.assigned_to !== undefined) patch.assigned_to = idField(body.assigned_to, "assigned_to", true);
  const title = stringField(body.title, "title", 240, true); if (title !== undefined) patch.title = title;
  const detail = stringField(body.detail, "detail", 20_000, true); if (detail !== undefined) patch.detail = detail;
  const status = statusField(body.status);
  const blockedReason = nullableStringField(body.blocked_reason, "blocked_reason", 2_000);
  const resultLink = nullableStringField(body.result_link, "result_link", 2_000);
  const dueAt = timestampField(body.due_at, "due_at");
  if (blockedReason !== undefined) patch.blocked_reason = blockedReason;
  if (resultLink !== undefined) {
    if (resultLink !== null && !isHttpUrl(resultLink)) throw new TaskApiError("invalid_request", "result_link must be an HTTP(S) URL or null.", 400);
    patch.result_link = resultLink;
  }
  if (dueAt !== undefined) patch.due_at = dueAt;

  const effectiveAssignee = patch.assigned_to === undefined ? current.assigned_to : patch.assigned_to as string | null;
  if (effectiveAssignee) await requireAssignableAgent(db, actor.workspaceId, effectiveAssignee);

  const now = new Date().toISOString();
  if (status) {
    patch.status = TO_DATABASE_STATUS[status];
    if (status === "queued") Object.assign(patch, { locked_by: null, locked_at: null, blocked_reason: null, completed_at: null });
    if (status === "in_progress" || status === "blocked") {
      if (!effectiveAssignee) throw new TaskApiError("invalid_transition", `${status} tasks must have an assigned agent.`, 409);
      patch.locked_by = effectiveAssignee;
      patch.locked_at = now;
      patch.completed_at = null;
      if (status === "in_progress") patch.blocked_reason = null;
      if (status === "blocked" && !(blockedReason ?? current.blocked_reason)) {
        throw new TaskApiError("invalid_transition", "blocked_reason is required when status is blocked.", 409);
      }
    }
    if (status === "done") patch.completed_at = now;
  } else if (body.assigned_to !== undefined && ["IN_PROGRESS", "BLOCKED"].includes(current.status)) {
    if (!effectiveAssignee) throw new TaskApiError("invalid_transition", "Active tasks must have an assigned agent.", 409);
    patch.locked_by = effectiveAssignee;
    patch.locked_at = now;
  }

  if (!status && blockedReason !== undefined && current.status !== "BLOCKED") {
    throw new TaskApiError("invalid_transition", "blocked_reason can only be changed on a blocked task.", 409);
  }
  if (Object.keys(patch).length === 0) throw new TaskApiError("invalid_request", "At least one task field must be updated.", 400);

  const { data, error } = await db.from("tasks").update(patch).eq("workspace_id", actor.workspaceId).eq("id", taskId).select("*").maybeSingle();
  if (error) databaseFailure("The task could not be updated.");
  if (!data) throw new TaskApiError("task_not_found", "Task not found in this workspace.", 404);
  return { task: serializeTask(data as TaskRow) };
}

export async function taskApiResponse(work: () => Promise<unknown>, successStatus = 200) {
  try {
    const result = await work();
    return NextResponse.json(result, { status: successStatus, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TaskApiError) return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "Cache-Control": "no-store" } });
    return NextResponse.json({ error: { code: "internal_error", message: "The task request could not be completed." } }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
