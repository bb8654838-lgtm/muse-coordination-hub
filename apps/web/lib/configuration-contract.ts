/** Pure, browser-safe desired-configuration contract. No runtime synchronization. */
export const PERMISSION_KEYS = ["file_read", "file_write", "code_execute", "network_read", "external_send", "deploy", "delegate", "financial_action"] as const;
export type PermissionKey = typeof PERMISSION_KEYS[number];
export type Permissions = Record<PermissionKey, boolean>;
export const MAX_INSTRUCTIONS_LENGTH = 20000;
export const MAX_SKILL_LENGTH = 100000;
export const MAX_SKILLS = 64;
export type RoleChoice = { kind: "preset"; id: string; version: string } | { kind: "custom"; id: string; version: number };
export type SkillChoice = { source: "bundled"; id: string; version: string; enabled: boolean } | { source: "custom"; id: string; version: number; enabled: boolean };
export type DesiredConfiguration = { role: RoleChoice | null; skills: SkillChoice[]; instructions: string; permissions: Permissions };
export type ConfigurationInput = DesiredConfiguration & { workspace_id: string; base_revision: number };
export type RoleInput = Omit<DesiredConfiguration, "role"> & { workspace_id: string; name: string; description: string; base_version?: number };
export type SkillInput = { workspace_id: string; content: string; name: string; description: string; skill_id?: string; base_version?: number };
export type Validation<T> = { ok: true; value: T } | { ok: false; message: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semver = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => Object.keys(v).every(k => keys.includes(k));
const integer = (v: unknown, minimum: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= minimum && v <= 2147483647;
const failure = (message: string): { ok: false; message: string } => ({ ok: false, message });
export function emptyPermissions(): Permissions { return Object.fromEntries(PERMISSION_KEYS.map(k => [k, false])) as Permissions; }
export function emptyConfiguration(): DesiredConfiguration { return { role: null, skills: [], instructions: "", permissions: emptyPermissions() }; }
export function configurationSyncBadge(desiredRevision: number, appliedRevision = 0, syncStatus?: string, syncRevision = desiredRevision): string {
  if (desiredRevision === 0) return "Unconfigured";
  if (appliedRevision === desiredRevision) return "Synced";
  if (syncRevision === desiredRevision && syncStatus === "failed") return "Sync failed";
  if (syncRevision === desiredRevision && syncStatus === "staged") return "Staged";
  return "Pending sync";
}
export function estimateTokenCount(text: string): number { return Math.ceil(text.length / 4); }
function parsePermissions(value: unknown): Validation<Permissions> {
  if (!record(value) || !exactKeys(value, PERMISSION_KEYS) || Object.values(value).some(v => typeof v !== "boolean")) return failure("Permissions must contain known boolean action flags only.");
  return { ok: true, value: { ...emptyPermissions(), ...value } as Permissions };
}
function parseSkills(value: unknown): Validation<SkillChoice[]> {
  if (!Array.isArray(value) || value.length > MAX_SKILLS) return failure(`Select at most ${MAX_SKILLS} skills.`);
  const seen = new Set<string>();
  for (const s of value) {
    if (!record(s) || !exactKeys(s, ["source", "id", "version", "enabled"]) || typeof s.enabled !== "boolean" || typeof s.id !== "string" || s.id.length > 120) return failure("Invalid skill selection.");
    if (s.source === "bundled") { if (!slug.test(s.id) || typeof s.version !== "string" || !semver.test(s.version)) return failure("Bundled skills need an immutable version and safe identifier."); }
    else if (s.source === "custom") { if (!uuid.test(s.id) || !integer(s.version, 1)) return failure("Custom skills need an ID and integer version."); }
    else return failure("Remote or unknown skill sources are not supported.");
    const key = `${s.source}:${s.id}`;
    if (seen.has(key)) return failure("Duplicate skill selections are not supported.");
    seen.add(key);
  }
  return { ok: true, value: value.map(s => ({ ...s })) as SkillChoice[] };
}
function parseDetails(value: Record<string, unknown>): Validation<Omit<DesiredConfiguration, "role">> {
  if (typeof value.instructions !== "string" || value.instructions.length > MAX_INSTRUCTIONS_LENGTH || value.instructions.includes("\0")) return failure("Instructions must be text of at most 20,000 characters without NUL bytes.");
  const skills = parseSkills(value.skills);
  if (!skills.ok) return skills;
  const permissions = parsePermissions(value.permissions);
  if (!permissions.ok) return permissions;
  return { ok: true, value: { skills: skills.value, permissions: permissions.value, instructions: value.instructions } };
}
export function validateConfigurationInput(value: unknown): Validation<ConfigurationInput> {
  if (!record(value) || !exactKeys(value, ["workspace_id", "base_revision", "role", "skills", "instructions", "permissions"]) || typeof value.workspace_id !== "string" || !uuid.test(value.workspace_id) || !integer(value.base_revision, 0)) return failure("A workspace ID and non-negative integer base_revision are required.");
  let role: RoleChoice | null = null;
  if (value.role !== null) {
    if (!record(value.role) || !exactKeys(value.role, ["kind", "id", "version"]) || typeof value.role.id !== "string" || value.role.id.length > 120) return failure("Invalid role selection.");
    if (value.role.kind === "preset" && slug.test(value.role.id) && typeof value.role.version === "string" && semver.test(value.role.version)) role = { kind: "preset", id: value.role.id, version: value.role.version };
    else if (value.role.kind === "custom" && uuid.test(value.role.id) && integer(value.role.version, 1)) role = { kind: "custom", id: value.role.id, version: value.role.version };
    else return failure("Role versions must be pinned, never 'latest'.");
  }
  const details = parseDetails(value);
  if (!details.ok) return details;
  return { ok: true, value: { workspace_id: value.workspace_id, base_revision: value.base_revision, role, ...details.value } };
}
export function validateRoleInput(value: unknown): Validation<RoleInput> {
  if (!record(value) || !exactKeys(value, ["workspace_id", "name", "description", "instructions", "skills", "permissions", "base_version"]) || typeof value.workspace_id !== "string" || !uuid.test(value.workspace_id)) return failure("A valid workspace ID is required.");
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 120 || value.name.includes("\0")) return failure("A role name between 1 and 120 characters is required.");
  if (typeof value.description !== "string" || value.description.length > 2000 || value.description.includes("\0")) return failure("Description must be text of at most 2,000 characters.");
  if (value.base_version !== undefined && !integer(value.base_version, 1)) return failure("base_version must be a positive integer.");
  const details = parseDetails(value);
  if (!details.ok) return details;
  return { ok: true, value: { workspace_id: value.workspace_id, name: value.name.trim(), description: value.description, ...details.value, ...(value.base_version !== undefined ? { base_version: value.base_version as number } : {}) } };
}
export function validateSkillInput(value: unknown): Validation<SkillInput> {
  if (!record(value) || !exactKeys(value, ["workspace_id", "content", "skill_id", "base_version"]) || typeof value.workspace_id !== "string" || !uuid.test(value.workspace_id)) return failure("A valid workspace ID is required.");
  if (typeof value.content !== "string" || value.content.length > MAX_SKILL_LENGTH || value.content.includes("\0")) return failure("SKILL.md must be text of at most 100,000 characters without NUL bytes.");
  const frontmatter = value.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter || frontmatter[1].length > 4096) return failure("SKILL.md needs YAML frontmatter with a scalar name and description.");
  const scalar = (key: string) => {
    const match = frontmatter[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return match?.[1].trim().replace(/^(["'])(.*)\1$/, "$2");
  };
  const name = scalar("name"), description = scalar("description");
  if (!name || !slug.test(name) || name.length > 120 || !description || description.length > 500 || /^[>|&*!{[]/.test(description)) return failure("Frontmatter needs a kebab-case name and a one-line description (up to 500 characters).");
  if (value.skill_id !== undefined && (typeof value.skill_id !== "string" || !uuid.test(value.skill_id) || !integer(value.base_version, 1))) return failure("Updating a skill requires skill_id and base_version.");
  if (value.skill_id === undefined && value.base_version !== undefined) return failure("base_version is only accepted when updating a skill.");
  return { ok: true, value: { workspace_id: value.workspace_id, content: value.content, name, description, ...(value.skill_id ? { skill_id: value.skill_id as string, base_version: value.base_version as number } : {}) } };
}
export function selectPreset(preset: { id: string; version: string; description: string; skill_ids: readonly string[]; optional_skill_ids: readonly string[] }, skills: readonly { id: string; version: string }[]): DesiredConfiguration {
  const defaults = new Set(preset.skill_ids);
  const chosen = new Set([...preset.skill_ids, ...preset.optional_skill_ids]);
  return { ...emptyConfiguration(), role: { kind: "preset", id: preset.id, version: preset.version }, skills: skills.filter(s => chosen.has(s.id)).map(s => ({ source: "bundled", id: s.id, version: s.version, enabled: defaults.has(s.id) })) };
}
