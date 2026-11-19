/* Full isolated owner-save -> agent-pull -> bridge-write -> ACK -> admin-read verification. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
function load(relative, dependencies = {}) {
  const filename = path.join(root, relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = instance.require.bind(instance);
  instance.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : native(name);
  instance._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
  return instance.exports;
}

const metadata = load("packages/skills/src/index.ts");
const resolver = load("packages/skills/src/server.ts", { "server-only": {}, "./index": metadata });
const contract = load("apps/web/lib/configuration-contract.ts", { "@muse/skills": metadata });
const httpHelpers = load("apps/web/lib/server/http.ts");
const workspaceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const token = "isolated-stage-b-agent-token";
const tables = {
  agents: [{ id: agentId, workspace_id: workspaceId, display_name: "Isolated coordinator", status: "online" }],
  agent_config_state: [],
  agent_config_revisions: [],
};

class Query {
  constructor(table) { this.table = table; this.filters = []; this.exclusions = []; }
  select() { return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  neq(key, value) { this.exclusions.push(row => row[key] !== value); return this; }
  rows() { return (tables[this.table] ?? []).filter(row => this.filters.every(test => test(row)) && this.exclusions.every(test => test(row))); }
  async maybeSingle() { const row = this.rows()[0] ?? null; return { data: row ? structuredClone(row) : null, error: null }; }
}
const db = {
  from(table) { return new Query(table); },
  async rpc(name, args) {
    if (name === "save_agent_configuration") {
      let state = tables.agent_config_state.find(row => row.workspace_id === args.p_workspace_id && row.agent_id === args.p_agent_id);
      const current = state?.desired_revision ?? 0;
      if (current !== args.p_base_revision) return { data: null, error: { message: "CONFIGURATION_REVISION_CONFLICT" } };
      const desiredRevision = current + 1;
      tables.agent_config_revisions.push({
        workspace_id: args.p_workspace_id,
        agent_id: args.p_agent_id,
        revision: desiredRevision,
        desired_configuration: structuredClone(args.p_configuration),
        resolved_bundle: structuredClone(args.p_resolved_bundle),
      });
      if (!state) {
        state = { workspace_id: args.p_workspace_id, agent_id: args.p_agent_id };
        tables.agent_config_state.push(state);
      }
      Object.assign(state, {
        desired_revision: desiredRevision,
        applied_revision: state.applied_revision ?? 0,
        desired_configuration: structuredClone(args.p_configuration),
        sync_revision: desiredRevision,
        sync_status: "pending",
        sync_error: null,
        updated_at: new Date().toISOString(),
      });
      return { data: { desired_revision: desiredRevision, applied_revision: state.applied_revision }, error: null };
    }
    if (name === "ack_agent_configuration") {
      const state = tables.agent_config_state.find(row => row.workspace_id === args.p_workspace_id && row.agent_id === args.p_agent_id);
      if (!state || state.desired_revision !== args.p_revision) return { data: null, error: { message: "CONFIGURATION_REVISION_CONFLICT" } };
      state.sync_revision = args.p_revision;
      state.sync_status = args.p_status;
      state.sync_error = args.p_error;
      if (args.p_status === "applied") state.applied_revision = args.p_revision;
      state.updated_at = new Date().toISOString();
      return { data: { revision: args.p_revision, status: args.p_status, applied_revision: state.applied_revision }, error: null };
    }
    throw new Error(`Unexpected RPC ${name}`);
  },
};
const adminDependency = { createAdminSupabaseClient() { return db; } };
const ownerService = load("apps/web/lib/server/agent-configuration.ts", {
  "server-only": {},
  "@muse/skills": metadata,
  "@muse/skills/server": resolver,
  "@/lib/configuration-contract": contract,
  "./owner-auth": {
    async authorizeWorkspaceOwner(requestedWorkspace) {
      return requestedWorkspace === workspaceId
        ? { ok: true, user: { id: ownerId }, workspace: { id: workspaceId, owner_id: ownerId } }
        : { ok: false, status: 403 };
    },
  },
  "@/lib/supabase/admin": adminDependency,
  "./http": httpHelpers,
});
const bridgeService = load("apps/web/lib/server/bridge-configuration.ts", {
  "server-only": {},
  "@/lib/configuration-contract": contract,
  "@/lib/supabase/admin": adminDependency,
  "./agent-auth": {
    async authenticateAgent(request) {
      return request.headers.get("authorization") === `Bearer ${token}`
        ? { id: agentId, workspace_id: workspaceId, display_name: "Isolated coordinator", role: "operations", status: "online" }
        : null;
    },
  },
  "./http": httpHelpers,
  "./agent-configuration": ownerService,
});
const ownerRoute = load("apps/web/app/api/owner/agents/[id]/configuration/route.ts", { "@/lib/server/agent-configuration": ownerService });
const pullRoute = load("apps/web/app/api/agents/me/configuration/route.ts", { "@/lib/server/bridge-configuration": bridgeService });
const ackRoute = load("apps/web/app/api/agents/me/configuration/ack/route.ts", { "@/lib/server/bridge-configuration": bridgeService });
const context = { params: Promise.resolve({ id: agentId }) };

async function main() {
  const { createBridgeClient } = await import("../packages/bridge/src/client.mjs");
  const fixturesRoot = path.join(root, "tests", "stage-b-fixtures");
  await fsp.mkdir(fixturesRoot, { recursive: true });
  const isolatedDirectory = await fsp.mkdtemp(path.join(fixturesRoot, "stage-b-e2e-"));
  const manualDirectory = path.join(isolatedDirectory, "manual-owned");
  const manualSkill = path.join(manualDirectory, "SKILL.md");
  await fsp.mkdir(manualDirectory);
  await fsp.writeFile(manualSkill, "Manual owner content.\n");
  try {
    const initialResponse = await ownerRoute.GET(new Request(`https://hub.example/api/owner/agents/${agentId}/configuration?workspace_id=${workspaceId}`), context);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.desired_revision, 0);
    assert.equal(initial.applied_revision, 0);

    const role = metadata.getStarterPreset("operations-coordinator");
    const skill = metadata.getBundledSkill("muse-task-triage");
    assert.ok(role && skill, "Operations Coordinator preset and task-triage skill must exist in the bundled catalog");
    const desired = {
      workspace_id: workspaceId,
      base_revision: 0,
      ...contract.emptyConfiguration(),
      role: { kind: "preset", id: role.id, version: role.version },
      skills: [{ source: "bundled", id: skill.id, version: skill.version, enabled: true }],
      instructions: "Coordinate assigned work without touching non-managed folders.",
      permissions: { ...contract.emptyConfiguration().permissions, file_read: true, file_write: true, delegate: true },
    };
    const saveResponse = await ownerRoute.PUT(new Request(`https://hub.example/api/owner/agents/${agentId}/configuration`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://hub.example" },
      body: JSON.stringify(desired),
    }), context);
    assert.equal(saveResponse.status, 200);
    const saved = await saveResponse.json();
    assert.equal(saved.desired_revision, 1);
    assert.equal(saved.applied_revision, 0);
    assert.equal(saved.sync_badge, "Pending sync");
    assert.equal(tables.agent_config_revisions.length, 1);

    const fetchImpl = async (url, init = {}) => {
      const request = new Request(url, init);
      const pathname = new URL(url).pathname;
      if (pathname === "/api/agents/me/configuration" && request.method === "GET") return pullRoute.GET(request);
      if (pathname === "/api/agents/me/configuration/ack" && request.method === "POST") return ackRoute.POST(request);
      return new Response(JSON.stringify({ error: { message: "Not found" } }), { status: 404, headers: { "Content-Type": "application/json" } });
    };
    const client = createBridgeClient({ baseUrl: "https://hub.example", agentKey: token, fetchImpl, skillsDirectory: isolatedDirectory });
    const sync = await client.syncConfiguration();
    assert.deepEqual(sync, { revision: 1, status: "applied", acknowledged: true });

    const namespace = path.join(isolatedDirectory, "muse-managed", createHash("sha256").update(`https://hub.example\0${token}`).digest("hex"));
    const managedSkill = path.join(namespace, "current", "bundled-muse-task-triage", "SKILL.md");
    const resolved = tables.agent_config_revisions[0].resolved_bundle.skills.find(item => item.id === "muse-task-triage");
    assert.equal(await fsp.readFile(managedSkill, "utf8"), resolved.content);
    assert.equal(await fsp.readFile(manualSkill, "utf8"), "Manual owner content.\n");

    const adminResponse = await ownerRoute.GET(new Request(`https://hub.example/api/owner/agents/${agentId}/configuration?workspace_id=${workspaceId}`), context);
    assert.equal(adminResponse.status, 200);
    const admin = await adminResponse.json();
    assert.equal(admin.desired_revision, 1);
    assert.equal(admin.applied_revision, 1);
    assert.equal(admin.sync_status, "applied");
    assert.equal(admin.sync_badge, "Synced");
    console.log("Isolated preset assignment, revision pull, managed SKILL.md write, ACK and admin applied-state verification passed.");
  } finally {
    await fsp.rm(isolatedDirectory, { recursive: true, force: true });
    assert.equal(fs.existsSync(isolatedDirectory), false, "Temporary test agent folder must be cleaned up");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
