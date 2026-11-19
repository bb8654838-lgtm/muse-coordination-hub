import "server-only";
import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { PERMISSION_KEYS, emptyConfiguration } from "@/lib/configuration-contract";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authenticateAgent } from "./agent-auth";
import { apiError } from "./http";
import { isConfigurationSetupError } from "./agent-configuration";

const SETUP = "Run supabase/migrations/002_agent_configuration.sql followed by 003_agent_configuration_sync.sql, then retry.";
class BridgeConfigurationError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
function unavailable(error: { code?: string; message?: string }): never {
  if (isConfigurationSetupError(error)) throw new BridgeConfigurationError("CONFIGURATION_SETUP_REQUIRED", SETUP, 503);
  if (error.message?.includes("CONFIGURATION_REVISION_CONFLICT")) throw new BridgeConfigurationError("CONFIGURATION_REVISION_CONFLICT", "Pull the latest configuration before acknowledging this revision.", 409);
  if (error.code === "42501" || error.message?.includes("CONFIGURATION_AGENT_NOT_FOUND")) throw new BridgeConfigurationError("UNAUTHORIZED", "A valid agent bearer token is required.", 401);
  throw new BridgeConfigurationError("CONFIGURATION_UNAVAILABLE", "Configuration is temporarily unavailable. Retry on the next heartbeat.", 503);
}
export async function bridgeConfigurationResponse(work: () => Promise<unknown | null>) {
  const headers = { "Cache-Control": "private, no-store" };
  try {
    const result = await work();
    return result === null ? new NextResponse(null, { status: 204, headers }) : NextResponse.json(result, { headers });
  } catch (error) {
    const response = error instanceof BridgeConfigurationError ? apiError(error.code, error.message, error.status) : apiError("CONFIGURATION_UNAVAILABLE", "Configuration is temporarily unavailable. Retry on the next heartbeat.", 503);
    response.headers.set("Cache-Control", headers["Cache-Control"]);
    return response;
  }
}
async function identity(request: NextRequest) {
  const agent = await authenticateAgent(request);
  if (!agent) throw new BridgeConfigurationError("UNAUTHORIZED", "A valid agent bearer token is required.", 401);
  return agent;
}
function corrupt(): never { throw new BridgeConfigurationError("CONFIGURATION_INTEGRITY_ERROR", "The stored configuration failed integrity validation.", 503); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Stage A froze and resolved bundled/workspace versions server-side at save time.
 * Pull the immutable bundle, never a mutable latest skill or untrusted filesystem path.
 */
export async function pullBridgeConfiguration(request: NextRequest) {
  const agent = await identity(request);
  const db = createAdminSupabaseClient();
  const { data: state, error: stateError } = await db.from("agent_config_state").select("desired_revision").eq("workspace_id", agent.workspace_id).eq("agent_id", agent.id).maybeSingle();
  if (stateError) unavailable(stateError);
  if (!state || state.desired_revision === 0) return null;
  if (!Number.isInteger(state.desired_revision) || state.desired_revision < 1) corrupt();
  const { data: revision, error } = await db.from("agent_config_revisions").select("revision, resolved_bundle").eq("workspace_id", agent.workspace_id).eq("agent_id", agent.id).eq("revision", state.desired_revision).maybeSingle();
  if (error) unavailable(error);
  if (!revision || revision.revision !== state.desired_revision || !record(revision.resolved_bundle)) corrupt();
  const bundle = revision.resolved_bundle;
  if (!Array.isArray(bundle.skills) || bundle.skills.length > 64 || typeof bundle.instructions !== "string" || !record(bundle.permissions)) corrupt();
  if (Object.entries(bundle.permissions).some(([key, value]) => !PERMISSION_KEYS.includes(key as typeof PERMISSION_KEYS[number]) || typeof value !== "boolean")) corrupt();
  const permissions = { ...emptyConfiguration().permissions, ...bundle.permissions };
  const seen = new Set<string>();
  const skills = bundle.skills.map((skill: unknown) => {
    if (!record(skill) || !["bundled", "custom"].includes(String(skill.source)) || typeof skill.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(skill.id) || typeof skill.name !== "string" || skill.enabled !== true || typeof skill.content !== "string" || skill.content.length > 100000 || skill.content.includes("\0") || typeof skill.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(skill.sha256)) corrupt();
    if (skill.source === "custom" ? !Number.isInteger(skill.version) || Number(skill.version) < 1 : typeof skill.version !== "string" || !skill.version) corrupt();
    const id = `${skill.source}:${skill.id}`;
    if (seen.has(id) || createHash("sha256").update(skill.content, "utf8").digest("hex") !== skill.sha256) corrupt();
    seen.add(id);
    return { source: skill.source, id: skill.id, version: skill.version, name: skill.name, content: skill.content, sha256: skill.sha256 };
  });
  const resolvedRole = bundle.role;
  if (resolvedRole !== null && (!record(resolvedRole) || typeof resolvedRole.name !== "string" || typeof resolvedRole.content !== "string")) corrupt();
  const role = record(resolvedRole) ? { name: String(resolvedRole.name), prompt: String(resolvedRole.content), summary: String(resolvedRole.name) } : null;
  return { configuration: { revision: state.desired_revision, role, role_summary: role?.summary ?? "", role_prompt: [role?.prompt ?? "", bundle.instructions].filter(Boolean).join("\n\n"), instructions: bundle.instructions, skills, permissions, allowed_actions: PERMISSION_KEYS.filter(key => permissions[key] === true) } };
}

/** Missing configuration tables never break a legacy heartbeat. */
export async function bridgeHeartbeatConfiguration(workspaceId: string, agentId: string) {
  try {
    const { data, error } = await createAdminSupabaseClient().from("agent_config_state").select("*").eq("workspace_id", workspaceId).eq("agent_id", agentId).maybeSingle();
    if (error || !data || !Number.isInteger(data.desired_revision) || data.desired_revision < 1) return null;
    return { revision: data.desired_revision, applied_revision: data.applied_revision ?? 0, sync_status: data.sync_status ?? "pending", sync_revision: data.sync_revision ?? 0 };
  } catch { return null; }
}

async function acknowledgementBody(request: NextRequest) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new BridgeConfigurationError("INVALID_CONTENT_TYPE", "Use application/json.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new BridgeConfigurationError("INVALID_ACK", "A JSON object is required.", 400);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 8192) { await reader.cancel(); throw new BridgeConfigurationError("BODY_TOO_LARGE", "Acknowledgements must not exceed 8 KB.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(body) || Object.keys(body).some(key => !["revision", "status", "error"].includes(key)) || !Number.isInteger(body.revision) || Number(body.revision) < 1 || Number(body.revision) > 2147483647 || !["staged", "applied", "failed"].includes(String(body.status)) || (body.error !== undefined && (body.status !== "failed" || typeof body.error !== "string" || body.error.length > 2000 || body.error.includes("\0")))) throw new BridgeConfigurationError("INVALID_ACK", "Provide a positive revision and staged, applied or failed status; an optional error is only valid for failed acknowledgements.", 400);
    return { revision: Number(body.revision), status: String(body.status), error: typeof body.error === "string" ? body.error : null };
  } catch (error) {
    if (error instanceof BridgeConfigurationError) throw error;
    throw new BridgeConfigurationError("INVALID_ACK", "The body must be valid UTF-8 JSON.", 400);
  } finally { reader.releaseLock(); }
}
export async function acknowledgeBridgeConfiguration(request: NextRequest) {
  const agent = await identity(request);
  const body = await acknowledgementBody(request);
  const { data, error } = await createAdminSupabaseClient().rpc("ack_agent_configuration", { p_workspace_id: agent.workspace_id, p_agent_id: agent.id, p_revision: body.revision, p_status: body.status, p_error: body.error });
  if (error) unavailable(error);
  if (!data) unavailable({});
  return { acknowledgement: data };
}
