import "server-only";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { bundledSkills, getBundledSkill, getStarterPreset, starterPresets } from "@muse/skills";
import { resolveBundledSkill, resolveStarterPreset } from "@muse/skills/server";
import { emptyConfiguration, estimateTokenCount, configurationSyncBadge, type DesiredConfiguration, type RoleInput, type SkillChoice, type SkillInput, validateConfigurationInput, validateRoleInput, validateSkillInput } from "@/lib/configuration-contract";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { authorizeWorkspaceOwner } from "./owner-auth";
import { apiError, isUuid } from "./http";
export const CONFIGURATION_SETUP_MESSAGE = "Run supabase/migrations/002_agent_configuration.sql in the Supabase SQL editor, then reload. Configuration remains unavailable until setup is verified.";
export function isConfigurationSetupError(error: { code?: string; message?: string } | null): boolean {
  return !!error && (["42P01", "42883", "PGRST202", "PGRST205"].includes(error.code ?? ""));
}
class ConfigurationError extends Error {
  constructor(public code: string, message: string, public status: number) { super(message); }
}
function databaseFailure(error: { code?: string; message?: string }): never {
  if (isConfigurationSetupError(error)) throw new ConfigurationError("CONFIGURATION_SETUP_REQUIRED", CONFIGURATION_SETUP_MESSAGE, 503);
  if (error.message?.includes("BASE_REVISION_CONFLICT")) throw new ConfigurationError("BASE_REVISION_CONFLICT", "Configuration changed elsewhere. Reload the latest revision before saving; your draft has not been overwritten.", 409);
  if (error.message?.includes("BASE_VERSION_CONFLICT")) throw new ConfigurationError("BASE_VERSION_CONFLICT", "The template changed elsewhere. Reload the latest version before saving.", 409);
  if (error.code === "23505") throw new ConfigurationError("DUPLICATE_NAME", "A role with this name already exists in your workspace.", 409);
  if (error.code === "42501") throw new ConfigurationError("FORBIDDEN", "Workspace owner access is required.", 403);
  if (error.code === "P0002" || error.message?.includes("REFERENCE_NOT_FOUND")) throw new ConfigurationError("NOT_FOUND", "The requested workspace configuration resource was not found.", 404);
  throw new ConfigurationError("CONFIGURATION_UNAVAILABLE", "Configuration could not be stored or loaded. Please retry.", 503);
}
export async function configurationResponse(work: () => Promise<unknown>, status = 200) {
  try { return NextResponse.json(await work(), { status, headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) {
    const response = error instanceof ConfigurationError ? apiError(error.code, error.message, error.status) : apiError("CONFIGURATION_UNAVAILABLE", "Configuration is temporarily unavailable. Please retry.", 503);
    response.headers.set("Cache-Control", "private, no-store");
    return response;
  }
}
export async function readConfigurationBody(request: Request): Promise<Record<string, unknown>> {
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") throw new ConfigurationError("FORBIDDEN_ORIGIN", "Cross-site configuration writes are not permitted.", 403);
  if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) throw new ConfigurationError("INVALID_CONTENT_TYPE", "Use application/json for configuration writes.", 415);
  const reader = request.body?.getReader();
  if (!reader) throw new ConfigurationError("INVALID_JSON", "A JSON request body is required.", 400);
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 512000) { await reader.cancel(); throw new ConfigurationError("BODY_TOO_LARGE", "Configuration requests must not exceed 512 KB.", 413); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ConfigurationError("INVALID_JSON", "Configuration writes require a JSON object.", 400);
    return body as Record<string, unknown>;
  } catch (error) { if (error instanceof ConfigurationError) throw error; throw new ConfigurationError("INVALID_JSON", "The request body must be valid UTF-8 JSON.", 400); }
  finally { reader.releaseLock(); }
}
export async function requireOwner(workspaceId: unknown) {
  if (!isUuid(workspaceId)) throw new ConfigurationError("INVALID_WORKSPACE", "A valid workspace_id is required.", 400);
  const owner = await authorizeWorkspaceOwner(workspaceId);
  if (!owner.ok) throw new ConfigurationError(owner.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN", "Workspace owner access is required.", owner.status);
  return { db: createAdminSupabaseClient(), ownerId: owner.user.id, workspaceId: owner.workspace.id };
}
export type OwnerContext = Awaited<ReturnType<typeof requireOwner>>;
function assertOwnedWorkspace(context: OwnerContext, workspaceId: string) {
  if (workspaceId !== context.workspaceId) throw new ConfigurationError("FORBIDDEN", "Workspace owner access is required.", 403);
}
async function requireAgent(context: OwnerContext, agentId: string) {
  if (!isUuid(agentId)) throw new ConfigurationError("INVALID_AGENT", "A valid agent ID is required.", 400);
  const { data, error } = await context.db.from("agents").select("id, display_name, status").eq("workspace_id", context.workspaceId).eq("id", agentId).neq("status", "revoked").maybeSingle();
  if (error) databaseFailure(error);
  if (!data) throw new ConfigurationError("AGENT_NOT_FOUND", "The agent was not found in your workspace.", 404);
  return data;
}
async function resolveSkill(context: OwnerContext, choice: SkillChoice) {
  if (choice.source === "bundled") {
    const metadata = getBundledSkill(choice.id);
    if (!metadata || metadata.version !== choice.version) throw new ConfigurationError("SKILL_NOT_FOUND", "The selected bundled skill/version is not available.", 400);
    const content = await resolveBundledSkill(choice.id, choice.version);
    return { ...choice, name: metadata.name, content, sha256: metadata.sha256 };
  }
  const { data, error } = await context.db.from("workspace_skill_versions").select("name, content, sha256").eq("workspace_id", context.workspaceId).eq("skill_id", choice.id).eq("version", choice.version).maybeSingle();
  if (error) databaseFailure(error);
  if (!data) throw new ConfigurationError("SKILL_NOT_FOUND", "The selected custom skill/version was not found in your workspace.", 404);
  if (createHash("sha256").update(data.content).digest("hex") !== data.sha256) throw new ConfigurationError("SKILL_INTEGRITY_ERROR", "The stored custom skill failed integrity verification.", 503);
  return { ...choice, ...data };
}
export async function resolveDesiredConfiguration(context: OwnerContext, configuration: DesiredConfiguration) {
  let role: { name: string; content: string } | null = null;
  if (configuration.role?.kind === "preset") {
    const preset = getStarterPreset(configuration.role.id);
    if (!preset || preset.version !== configuration.role.version) throw new ConfigurationError("ROLE_NOT_FOUND", "The selected starter preset/version is unavailable.", 400);
    role = { name: preset.name, content: await resolveStarterPreset(preset.id, preset.version) };
  } else if (configuration.role?.kind === "custom") {
    const { data, error } = await context.db.from("workspace_role_versions").select("name, instructions").eq("workspace_id", context.workspaceId).eq("role_id", configuration.role.id).eq("version", configuration.role.version).maybeSingle();
    if (error) databaseFailure(error);
    if (!data) throw new ConfigurationError("ROLE_NOT_FOUND", "The selected custom role/version was not found in your workspace.", 404);
    role = { name: data.name, content: data.instructions };
  }
  // Resolve disabled references too; never persist a dangling or foreign-workspace selection.
  const selected = await Promise.all(configuration.skills.map(choice => resolveSkill(context, choice)));
  const skills = selected.filter(skill => skill.enabled);
  const text = [role?.content ?? "", configuration.instructions, ...skills.map(skill => skill.content)].join("\n\n");
  const bundle = { role, skills, instructions: configuration.instructions, permissions: configuration.permissions, estimated_tokens: estimateTokenCount(text) };
  return { ...bundle, sha256: createHash("sha256").update(JSON.stringify(bundle)).digest("hex") };
}
export async function listRoles(context: OwnerContext) {
  const [roles, versions] = await Promise.all([
    context.db.from("workspace_roles").select("id, name, description, current_version, updated_at").eq("workspace_id", context.workspaceId).order("name"),
    context.db.from("workspace_role_versions").select("role_id, version, name, description, instructions, skills, permissions").eq("workspace_id", context.workspaceId).order("version", { ascending: false }),
  ]);
  if (roles.error) databaseFailure(roles.error); if (versions.error) databaseFailure(versions.error);
  return { workspace_id: context.workspaceId, presets: starterPresets, roles: roles.data ?? [], versions: versions.data ?? [] };
}
export async function saveRole(context: OwnerContext, body: unknown, roleId: string | null = null) {
  const parsed = validateRoleInput(body);
  if (!parsed.ok) throw new ConfigurationError("INVALID_ROLE", parsed.message, 400);
  const value: RoleInput = parsed.value;
  if (roleId !== null && (!isUuid(roleId) || value.base_version === undefined)) throw new ConfigurationError("INVALID_ROLE", "Editing a role requires a valid ID and base_version.", 400);
  if (roleId === null && value.base_version !== undefined) throw new ConfigurationError("INVALID_ROLE", "New roles must not supply base_version.", 400);
  assertOwnedWorkspace(context, value.workspace_id);
  await Promise.all(value.skills.map(choice => resolveSkill(context, choice)));
  const { workspace_id: _workspaceId, base_version: _baseVersion, ...definition } = value;
  const { data, error } = await context.db.rpc("save_workspace_role", { p_workspace_id: context.workspaceId, p_owner_id: context.ownerId, p_role_id: roleId, p_base_version: value.base_version ?? null, p_definition: definition });
  if (error) databaseFailure(error);
  return { workspace_id: context.workspaceId, role: data };
}
export async function listSkills(context: OwnerContext) {
  const { data, error } = await context.db.from("workspace_skill_versions").select("skill_id, version, name, description, content, sha256, created_at").eq("workspace_id", context.workspaceId).order("version", { ascending: false });
  if (error) databaseFailure(error);
  return { workspace_id: context.workspaceId, bundled_skills: bundledSkills, custom_skills: data ?? [] };
}
export async function saveSkill(context: OwnerContext, body: unknown) {
  const parsed = validateSkillInput(body);
  if (!parsed.ok) throw new ConfigurationError("INVALID_SKILL", parsed.message, 400);
  const value: SkillInput = parsed.value;
  assertOwnedWorkspace(context, value.workspace_id);
  const { data, error } = await context.db.rpc("save_workspace_skill", { p_workspace_id: context.workspaceId, p_owner_id: context.ownerId, p_skill_id: value.skill_id ?? null, p_base_version: value.base_version ?? null, p_name: value.name, p_description: value.description, p_content: value.content, p_sha256: createHash("sha256").update(value.content).digest("hex") });
  if (error) databaseFailure(error);
  return { workspace_id: context.workspaceId, skill: { skill_id: data.id, version: data.version } };
}
export async function getAgentConfiguration(context: OwnerContext, agentId: string) {
  await requireAgent(context, agentId);
  const { data, error } = await context.db.from("agent_config_state").select("desired_revision, applied_revision, desired_configuration, updated_at").eq("workspace_id", context.workspaceId).eq("agent_id", agentId).maybeSingle();
  if (error) databaseFailure(error);
  const configuration = (data?.desired_configuration ?? emptyConfiguration()) as DesiredConfiguration;
  return { workspace_id: context.workspaceId, agent_id: agentId, desired_revision: data?.desired_revision ?? 0, applied_revision: data?.applied_revision ?? 0, configuration: { ...configuration, permissions: { ...emptyConfiguration().permissions, ...configuration.permissions } }, sync_badge: configurationSyncBadge(data?.desired_revision ?? 0), updated_at: data?.updated_at ?? null };
}
export async function saveAgentConfiguration(context: OwnerContext, agentId: string, body: unknown) {
  const parsed = validateConfigurationInput(body);
  if (!parsed.ok) throw new ConfigurationError("INVALID_CONFIGURATION", parsed.message, 400);
  const value = parsed.value;
  assertOwnedWorkspace(context, value.workspace_id); await requireAgent(context, agentId);
  const { workspace_id: _workspaceId, base_revision: _baseRevision, ...configuration } = value;
  const resolved = await resolveDesiredConfiguration(context, configuration);
  const { data, error } = await context.db.rpc("save_agent_configuration", { p_workspace_id: context.workspaceId, p_owner_id: context.ownerId, p_agent_id: agentId, p_base_revision: value.base_revision, p_configuration: configuration, p_resolved_bundle: resolved });
  if (error) databaseFailure(error);
  return { workspace_id: context.workspaceId, agent_id: agentId, ...data, estimated_tokens: resolved.estimated_tokens, sync_badge: configurationSyncBadge(data.desired_revision) };
}
