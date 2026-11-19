/* Execute the real owner handlers and server logic with a mocked database/auth boundary. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const ts = require("typescript");
const { NextResponse } = require("next/server");
const root = path.resolve(__dirname, "..");

function load(relative, dependencies = {}) {
  const filename = path.join(root, relative);
  const instance = new Module(filename, module);
  instance.filename = filename;
  instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const nativeRequire = instance.require.bind(instance);
  instance.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : nativeRequire(name);
  instance._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
  return instance.exports;
}

const metadata = load("packages/skills/src/index.ts");
const resolver = load("packages/skills/src/server.ts", { "server-only": {}, "./index": metadata });
const contract = load("apps/web/lib/configuration-contract.ts", { "@muse/skills": metadata });
const workspace = "11111111-1111-4111-8111-111111111111";
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const owner = "33333333-3333-4333-8333-333333333333";
const agent = "44444444-4444-4444-8444-444444444444";
const skill = "55555555-5555-4555-8555-555555555555";
let signedIn = true;
let rpcError = null;
let missingTables = false;
let rpcCalls = [];
const tables = {
  workspaces: [{ id: workspace, owner_id: owner }, { id: otherWorkspace, owner_id: "66666666-6666-4666-8666-666666666666" }],
  agents: [{ id: agent, workspace_id: workspace, display_name: "Slot 1", status: "online" }],
  workspace_roles: [], workspace_role_versions: [], workspace_skill_versions: [], agent_config_state: [],
};
const db = {
  from(table) {
    const filters = [];
    const result = () => missingTables && table === "workspace_roles"
      ? { data: null, error: { code: "PGRST205", message: "workspace_roles not found" } }
      : { data: (tables[table] ?? []).filter(row => filters.every(test => test(row))), error: null };
    const query = {
      select() { return query; }, order() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      neq(key, value) { filters.push(row => row[key] !== value); return query; },
      async maybeSingle() { const value = result(); return { ...value, data: value.data?.[0] ?? null }; },
      then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
    };
    return query;
  },
  async rpc(name, args) {
    rpcCalls.push({ name, args });
    if (rpcError) return { data: null, error: rpcError };
    return { data: name === "save_workspace_skill" ? { id: skill, version: 1 } :
      name === "save_workspace_role" ? { id: skill, version: 1 } :
      { desired_revision: 1, applied_revision: 0 }, error: null };
  },
};
const server = load("apps/web/lib/server/agent-configuration.ts", {
  "server-only": {}, "@muse/skills": metadata, "@muse/skills/server": resolver,
  "@/lib/configuration-contract": contract,
  "./owner-auth": { async authorizeWorkspaceOwner(workspaceId) {
    if (!signedIn) return { ok: false, status: 401 };
    const owned = tables.workspaces.find(row => row.id === workspaceId && row.owner_id === owner);
    return owned ? { ok: true, user: { id: owner }, workspace: owned } : { ok: false, status: 403 };
  } },
  "@/lib/supabase/admin": { createAdminSupabaseClient() { return db; } },
  "./http": load("apps/web/lib/server/http.ts"),
});
const dependencies = { "@/lib/server/agent-configuration": server };
const roles = load("apps/web/app/api/owner/roles/route.ts", dependencies);
const skills = load("apps/web/app/api/owner/skills/route.ts", dependencies);
const configuration = load("apps/web/app/api/owner/agents/[id]/configuration/route.ts", dependencies);
const request = (route, method = "GET", body, origin = "https://hub.example") => new Request(
  `https://hub.example/api/owner/${route}?workspace_id=${workspace}`,
  { method, headers: { "Content-Type": "application/json", Origin: origin }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) },
);
const context = { params: Promise.resolve({ id: agent }) };

async function main() {
  signedIn = false;
  assert.equal((await roles.GET(request("roles"))).status, 401);
  assert.equal((await configuration.PUT(request("agents/x/configuration", "PUT", { workspace_id: workspace, base_revision: 0, ...contract.emptyConfiguration() }), context)).status, 401);
  assert.equal(rpcCalls.length, 0);
  signedIn = true;
  assert.equal((await roles.GET(new Request(`https://hub.example/api/owner/roles?workspace_id=${otherWorkspace}`))).status, 403);
  assert.equal((await roles.GET(new Request("https://hub.example/api/owner/roles?workspace_id=invalid"))).status, 400);

  missingTables = true;
  const setup = await roles.GET(request("roles"));
  assert.equal(setup.status, 503);
  assert.equal((await setup.json()).error.code, "CONFIGURATION_SETUP_REQUIRED");
  missingTables = false;

  const neutral = await configuration.GET(request("agents/x/configuration"), context);
  assert.equal(neutral.status, 200);
  const initial = await neutral.json();
  assert.equal(initial.desired_revision, 0);
  assert.equal(initial.applied_revision, 0);
  assert.deepEqual(initial.configuration, contract.emptyConfiguration());
  assert.equal(rpcCalls.length, 0, "Reading a newly linked slot must not create configuration");

  const preset = metadata.starterPresets[7];
  const enabled = metadata.bundledSkills[0];
  const disabled = metadata.bundledSkills[1];
  const input = { workspace_id: workspace, base_revision: 0, ...contract.emptyConfiguration(),
    role: { kind: "preset", id: preset.id, version: preset.version },
    skills: [{ source: "bundled", id: enabled.id, version: enabled.version, enabled: true },
      { source: "bundled", id: disabled.id, version: disabled.version, enabled: false }],
  };
  const saved = await configuration.PUT(request("agents/x/configuration", "PUT", input), context);
  assert.equal(saved.status, 200);
  const acknowledgment = await saved.json();
  assert.equal(acknowledgment.desired_revision, 1);
  assert.equal(acknowledgment.applied_revision, 0);
  assert.equal(acknowledgment.sync_badge, "Pending sync");
  const write = rpcCalls.at(-1);
  assert.equal(write.name, "save_agent_configuration");
  assert.equal(write.args.p_base_revision, 0);
  assert.equal(write.args.p_configuration.role.id, preset.id, "Any preset can be assigned to any slot");
  assert.equal(write.args.p_resolved_bundle.skills.length, 1, "OFF skills must not enter the resolved snapshot");
  assert.equal(write.args.p_resolved_bundle.skills[0].id, enabled.id);
  assert.match(write.args.p_resolved_bundle.role.content, /^---\nname:/);

  rpcError = { code: "P0001", message: "BASE_REVISION_CONFLICT" };
  const conflict = await configuration.PUT(request("agents/x/configuration", "PUT", input), context);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "BASE_REVISION_CONFLICT");
  rpcError = null;
  const callsBeforeInvalid = rpcCalls.length;
  assert.equal((await configuration.PUT(request("agents/x/configuration", "PUT", { ...input, base_revision: "0" }), context)).status, 400);
  assert.equal((await configuration.PUT(request("agents/x/configuration", "PUT", input, "https://other.example"), context)).status, 403);
  assert.equal((await skills.POST(request("skills", "POST", []))).status, 400);
  assert.equal(rpcCalls.length, callsBeforeInvalid);

  const custom = await skills.POST(request("skills", "POST", {
    workspace_id: workspace, content: "---\nname: local-check\ndescription: Verify a local change.\n---\n\n# Check\n\nRun tests and record the result.\n",
  }));
  assert.equal(custom.status, 201);
  assert.deepEqual((await custom.json()).skill, { skill_id: skill, version: 1 }, "The save response must match the Admin read-back contract");
  assert.equal(rpcCalls.at(-1).name, "save_workspace_skill");
  assert.equal(rpcCalls.at(-1).args.p_base_version, null);
  console.log("owner configuration behavior: PASS (real handlers, owner gates, neutral reads, preset mixing, OFF snapshots, conflict 409, CSRF, setup errors, skill read-back shape)");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
