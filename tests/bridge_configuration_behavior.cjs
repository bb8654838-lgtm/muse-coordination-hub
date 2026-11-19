/* Exercise real bearer authentication, routes and configuration resolution against an isolated DB boundary. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { createHash } = require("node:crypto");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
function load(relative, dependencies = {}) {
  const filename = path.join(root, relative), instance = new Module(filename, module);
  instance.filename = filename; instance.paths = Module._nodeModulePaths(path.dirname(filename));
  const native = instance.require.bind(instance);
  instance.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : native(name);
  instance._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
  return instance.exports;
}
const pepper = process.env.MUSE_AGENT_KEY_PEPPER;
process.env.MUSE_AGENT_KEY_PEPPER = "fixture-only-pepper-not-a-production-secret";
const metadata = load("packages/skills/src/index.ts");
const contract = load("apps/web/lib/configuration-contract.ts", { "@muse/skills": metadata });
const workspace = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222";
const token = "fixture-only-agent-token-not-a-production-secret";
let databaseError = null, rpcError = null, calls = [];
const tables = { agents: [], agent_config_state: [], agent_config_revisions: [] };
const db = {
  from(table) {
    const filters = [], query = {
      select() { return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      neq(key, value) { filters.push(row => row[key] !== value); return query; },
      async maybeSingle() { return { data: (tables[table] ?? []).find(row => filters.every(filter => filter(row))) ?? null, error: table === "agents" ? null : databaseError }; },
    }; return query;
  },
  async rpc(name, args) {
    calls.push({ name, args });
    return rpcError ? { data: null, error: rpcError } : { data: { revision: args.p_revision, status: args.p_status, applied_revision: args.p_status === "applied" ? args.p_revision : 0 }, error: null };
  },
};
const boundary = { "server-only": {}, "@/lib/supabase/admin": { createAdminSupabaseClient() { return db; } } };
const auth = load("apps/web/lib/server/agent-auth.ts", boundary);
tables.agents.push({ id: agentId, workspace_id: workspace, display_name: "Fixture", role: "review", status: "online", api_key_hash: auth.hashSecret(token, process.env.MUSE_AGENT_KEY_PEPPER) });
const server = load("apps/web/lib/server/bridge-configuration.ts", {
  ...boundary, "@/lib/configuration-contract": contract, "./agent-auth": auth,
  "./http": load("apps/web/lib/server/http.ts"),
  "./agent-configuration": { isConfigurationSetupError(error) { return ["42P01", "42703", "PGRST205", "PGRST202"].includes(error.code); } },
});
const deps = { "@/lib/server/bridge-configuration": server };
const pull = load("apps/web/app/api/agents/me/configuration/route.ts", deps);
const ack = load("apps/web/app/api/agents/me/configuration/ack/route.ts", deps);
const request = (body, key = token, type = "application/json") => new Request("https://hub.example/api/agents/me/configuration" + (body === undefined ? "" : "/ack"), {
  method: body === undefined ? "GET" : "POST",
  headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), "Content-Type": type },
  ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
});
const digest = value => createHash("sha256").update(value).digest("hex");
const frozen = {
  role: { id: "reviewer", version: 1, name: "Reviewer", content: "Review carefully." }, instructions: "Use evidence.",
  permissions: { ...contract.emptyConfiguration().permissions, file_read: true },
  skills: [
    { source: "bundled", id: "review", version: "1.0.0", name: "Bundled Review", enabled: true, content: "# Bundled\r\nReview evidence.\n", sha256: digest("# Bundled\r\nReview evidence.\n") },
    { source: "custom", id: "33333333-3333-4333-8333-333333333333", version: 2, name: "Workspace Skill", enabled: true, content: "# Workspace\nFrozen version two.\n", sha256: digest("# Workspace\nFrozen version two.\n") },
  ],
};
async function main() {
  for (const key of [null, "short", "fixture-only-wrong-token-with-sufficient-length"]) {
    assert.equal((await pull.GET(request(undefined, key))).status, 401);
    assert.equal((await ack.POST(request({ revision: 1, status: "applied" }, key))).status, 401);
  }
  tables.agents[0].status = "revoked";
  assert.equal((await pull.GET(request())).status, 401);
  tables.agents[0].status = "online";
  let response = await pull.GET(request());
  assert.equal(response.status, 204); assert.equal(await response.text(), "");
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal(await server.bridgeHeartbeatConfiguration(workspace, agentId), null);
  tables.agent_config_state.push({ workspace_id: workspace, agent_id: agentId, desired_revision: 1, applied_revision: 0, sync_revision: 1, sync_status: "pending" });
  tables.agent_config_revisions.push({ workspace_id: workspace, agent_id: agentId, revision: 1, resolved_bundle: frozen });
  // Another agent/workspace's newer row must never be selected.
  tables.agent_config_revisions.unshift({ workspace_id: "other", agent_id: agentId, revision: 1, resolved_bundle: { instructions: "foreign" } });
  response = await pull.GET(request()); assert.equal(response.status, 200);
  const configuration = (await response.json()).configuration;
  assert.equal(configuration.revision, 1);
  assert.equal(configuration.role_prompt, "Review carefully.\n\nUse evidence.");
  assert.equal(configuration.role_summary, "Reviewer");
  assert.deepEqual(configuration.allowed_actions, ["file_read"]);
  assert.equal(configuration.skills.length, 2);
  assert.equal(configuration.skills[0].content, frozen.skills[0].content);
  assert.equal(configuration.skills[1].version, 2);
  assert.equal(calls.length, 0);
  assert.equal((await server.bridgeHeartbeatConfiguration(workspace, agentId)).revision, 1);
  assert.equal(await server.bridgeHeartbeatConfiguration("other", agentId), null);
  const original = frozen.skills[0].sha256;
  frozen.skills[0].sha256 = "0".repeat(64);
  assert.equal((await pull.GET(request())).status, 503);
  frozen.skills[0].sha256 = original;
  frozen.skills.push({ ...frozen.skills[0] });
  assert.equal((await pull.GET(request())).status, 503); frozen.skills.pop();
  frozen.skills[0].id = "../escape";
  assert.equal((await pull.GET(request())).status, 503); frozen.skills[0].id = "review";
  for (const body of [{ revision: 0, status: "applied" }, { revision: 1, status: "unknown" }, { revision: true, status: "staged" }, { revision: 1, status: "applied", error: "wrong" }, { revision: 1, status: "failed", error: "x".repeat(2001) }, { revision: 1, status: "applied", workspace_id: "other" }, "{"]) {
    assert.equal((await ack.POST(request(body))).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal((await ack.POST(request({ revision: 1, status: "staged" }, token, "text/plain"))).status, 415);
  assert.equal((await ack.POST(request(" ".repeat(8193)))).status, 413);
  for (const status of ["staged", "applied", "failed"]) {
    response = await ack.POST(request({ revision: 1, status, ...(status === "failed" ? { error: "Filesystem permissions denied." } : {}) }));
    assert.equal(response.status, 200); assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(calls.at(-1).name, "ack_agent_configuration");
    assert.equal(calls.at(-1).args.p_workspace_id, workspace); assert.equal(calls.at(-1).args.p_agent_id, agentId);
    assert.equal(calls.at(-1).args.p_status, status);
    assert.equal(calls.at(-1).args.p_error, status === "failed" ? "Filesystem permissions denied." : null);
  }
  rpcError = { code: "P0001", message: "CONFIGURATION_REVISION_CONFLICT" };
  assert.equal((await ack.POST(request({ revision: 1, status: "applied" }))).status, 409);
  rpcError = { code: "PGRST202", message: "function absent" };
  assert.equal((await ack.POST(request({ revision: 1, status: "applied" }))).status, 503); rpcError = null;
  databaseError = { code: "42P01", message: "table absent" };
  assert.equal((await pull.GET(request())).status, 503);
  assert.equal(await server.bridgeHeartbeatConfiguration(workspace, agentId), null);
  console.log("Bridge configuration route/auth/integrity/ACK behavior passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  if (pepper === undefined) delete process.env.MUSE_AGENT_KEY_PEPPER; else process.env.MUSE_AGENT_KEY_PEPPER = pepper;
});
