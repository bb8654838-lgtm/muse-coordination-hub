import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readlink, rename, rmdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ACTIONS = ["file_read", "file_write", "code_execute", "network_read", "external_send", "deploy", "delegate", "financial_action"];
const FORMAT = "muse-managed-skills-v1";
const MARKER = ".muse-skill-sync.json";
const FAILED = "Managed configuration sync failed. Check bundle integrity, directory ownership and filesystem permissions.";
const hash = value => createHash("sha256").update(value, "utf8").digest("hex");
const integer = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : object(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value);

function validate(configuration) {
  if (!object(configuration) || !integer(configuration.revision) || !Array.isArray(configuration.skills) || configuration.skills.length > 64 || Buffer.byteLength(JSON.stringify(configuration)) > 32_000_000) throw new Error("Invalid configuration");
  for (const field of ["role_prompt", "role_summary", "instructions"]) if (typeof configuration[field] !== "string" || configuration[field].includes("\0")) throw new Error("Invalid role content");
  if (configuration.role !== null && (!object(configuration.role) || ["name", "prompt", "summary"].some(key => typeof configuration.role[key] !== "string"))) throw new Error("Invalid role");
  if (!object(configuration.permissions) || Object.entries(configuration.permissions).some(([key, value]) => !ACTIONS.includes(key) || typeof value !== "boolean")) throw new Error("Invalid permissions");
  const actions = configuration.allowed_actions;
  if (!Array.isArray(actions) || new Set(actions).size !== actions.length || actions.some(key => !ACTIONS.includes(key) || configuration.permissions[key] !== true) || ACTIONS.some(key => configuration.permissions[key] === true && !actions.includes(key))) throw new Error("Invalid allowed actions");
  const seen = new Set();
  for (const skill of configuration.skills) {
    if (!object(skill) || !["bundled", "custom"].includes(skill.source) || typeof skill.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(skill.id) || typeof skill.name !== "string" || (skill.source === "custom" ? !integer(skill.version) : typeof skill.version !== "string" || !skill.version)) throw new Error("Invalid skill identity");
    const key = `${skill.source}-${skill.id}`;
    if (seen.has(key) || typeof skill.content !== "string" || skill.content.includes("\0") || skill.content.length > 100_000 || typeof skill.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(skill.sha256) || hash(skill.content) !== skill.sha256) throw new Error("Invalid skill content");
    seen.add(key);
  }
  return configuration;
}

async function safeDirectory(directory) {
  let cursor = path.parse(directory).root;
  for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const info = await lstat(cursor); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe directory"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
async function regularFile(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe managed file");
  return readFile(filename, "utf8");
}
async function ownedDirectory(directory, scope = null) {
  await safeDirectory(directory);
  try {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(path.join(directory, MARKER), JSON.stringify({ format: FORMAT, scope }), { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const marker = JSON.parse(await regularFile(path.join(directory, MARKER)));
    if (marker.format !== FORMAT || marker.scope !== scope) throw new Error("Unowned managed directory");
  }
}
async function currentConfiguration(namespace) {
  const current = path.join(namespace, "current");
  try { if (!(await lstat(current)).isSymbolicLink()) throw new Error("Unowned current pointer"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const target = await readlink(current);
  if (!/^revision-[1-9][0-9]*-[a-f0-9-]+$/.test(target)) throw new Error("Unsafe current pointer");
  const snapshot = path.join(namespace, target);
  await safeDirectory(snapshot);
  const configuration = validate(JSON.parse(await regularFile(path.join(snapshot, "configuration.json"))));
  if (!target.startsWith(`revision-${configuration.revision}-`)) throw new Error("Revision mismatch");
  for (const skill of configuration.skills) {
    const directory = path.join(snapshot, `${skill.source}-${skill.id}`);
    await safeDirectory(directory);
    if (hash(await regularFile(path.join(directory, "SKILL.md"))) !== skill.sha256) throw new Error("Modified managed skill");
  }
  return configuration;
}

/** No filesystem access until the authenticated hub returns a configured revision. */
export function createConfigurationSync({ request, baseUrl, agentKey, skillsDirectory }) {
  const root = path.resolve(skillsDirectory ?? path.join(process.cwd(), "skills"));
  const scope = hash(`${baseUrl}\0${agentKey ?? ""}`);
  let appliedRevision = 0, ackedRevision = 0, inFlight = null;
  async function ack(revision, status, error) {
    return request("/api/agents/me/configuration/ack", { method: "POST", payload: { revision, status, ...(error ? { error } : {}) } });
  }
  async function finish(revision) {
    try { await ack(revision, "applied"); ackedRevision = revision; return { revision, status: "applied", acknowledged: true }; }
    catch { return { revision, status: "applied", acknowledged: false }; }
  }
  async function run(hint) {
    if (integer(hint) && ackedRevision === hint) return { revision: hint, status: "applied", acknowledged: true };
    if (integer(hint) && appliedRevision === hint) return finish(hint);
    let revision = integer(hint) ? hint : null;
    let lock = null;
    try {
      let payload;
      try { payload = await request("/api/agents/me/configuration"); }
      catch (error) { if (error.status === 404 || error.status === 204) return { status: "unconfigured" }; throw error; }
      if (!payload?.configuration) return { status: "unconfigured" };
      if (integer(payload.configuration.revision)) revision = payload.configuration.revision;
      const configuration = validate(payload.configuration);
      await safeDirectory(root);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const managed = path.join(root, "muse-managed");
      await ownedDirectory(managed);
      const namespace = path.join(managed, scope);
      await ownedDirectory(namespace, scope);
      const lockPath = path.join(namespace, ".sync-lock");
      await mkdir(lockPath, { mode: 0o700 }); lock = lockPath;
      const existing = await currentConfiguration(namespace);
      if (existing && existing.revision > revision) throw new Error("Refusing revision downgrade");
      if (existing && canonical(existing) === canonical(configuration)) { appliedRevision = revision; return finish(revision); }
      const generation = `revision-${revision}-${randomUUID()}`;
      const snapshot = path.join(namespace, generation);
      await mkdir(snapshot, { mode: 0o700 });
      for (const skill of configuration.skills) {
        const directory = path.join(snapshot, `${skill.source}-${skill.id}`);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(path.join(directory, "SKILL.md"), skill.content, { flag: "wx", mode: 0o600 });
      }
      await writeFile(path.join(snapshot, "configuration.json"), JSON.stringify(configuration, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await ack(revision, "staged");
      const pointer = path.join(namespace, `current-${randomUUID()}`);
      await symlink(generation, pointer, "dir");
      await rename(pointer, path.join(namespace, "current"));
      appliedRevision = revision;
      return finish(revision);
    } catch {
      if (revision) { try { await ack(revision, "failed", FAILED); } catch { /* Retry on the next heartbeat. */ } }
      return { revision, status: "failed", error: FAILED };
    } finally {
      if (lock) await rmdir(lock).catch(() => {}); // Only an empty lock created by this invocation.
    }
  }
  return function syncConfiguration(hint) {
    if (!inFlight) inFlight = run(hint).finally(() => { inFlight = null; });
    return inFlight;
  };
}
