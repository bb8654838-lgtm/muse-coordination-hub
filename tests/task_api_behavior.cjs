/* Exercise the public task routes with isolated owner/agent auth and an in-memory database boundary. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
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

const workspaceId = "11111111-1111-4111-8111-111111111111";
const otherWorkspaceId = "99999999-9999-4999-8999-999999999999";
const ownerId = "22222222-2222-4222-8222-222222222222";
const coordinatorId = "33333333-3333-4333-8333-333333333333";
const targetId = "44444444-4444-4444-8444-444444444444";
const agentToken = "isolated-coordinator-token";
let ownerAuthorized = true;
let sequence = 0;

const tables = {
  workspaces: [{ id: workspaceId, owner_id: ownerId }],
  agents: [
    { id: coordinatorId, workspace_id: workspaceId, status: "online" },
    { id: targetId, workspace_id: workspaceId, status: "online" },
  ],
  agent_config_state: [{
    workspace_id: workspaceId,
    agent_id: coordinatorId,
    desired_revision: 1,
    applied_revision: 1,
    desired_configuration: { permissions: { delegate: true } },
  }],
  agent_config_revisions: [{
    workspace_id: workspaceId,
    agent_id: coordinatorId,
    revision: 1,
    configuration: { permissions: { delegate: true } },
  }],
  tasks: [],
};

class Query {
  constructor(table) {
    this.table = table;
    this.filters = [];
    this.mode = "select";
    this.payload = null;
    this.ascending = true;
  }
  select() { return this; }
  eq(key, value) { this.filters.push(row => row[key] === value); return this; }
  insert(payload) { this.mode = "insert"; this.payload = payload; return this; }
  update(payload) { this.mode = "update"; this.payload = payload; return this; }
  order(key, options = {}) { this.orderKey = key; this.ascending = options.ascending !== false; return this; }
  rows() { return (tables[this.table] ?? []).filter(row => this.filters.every(filter => filter(row))); }
  async limit(value) {
    const rows = this.rows().slice().sort((left, right) => {
      const result = String(left[this.orderKey] ?? "").localeCompare(String(right[this.orderKey] ?? ""));
      return this.ascending ? result : -result;
    });
    return { data: rows.slice(0, value).map(row => ({ ...row })), error: null };
  }
  async single() {
    if (this.mode !== "insert") throw new Error("single() only implemented for fixture inserts");
    const now = new Date().toISOString();
    const row = {
      id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(++sequence).padStart(12, "0")}`,
      blocked_reason: null,
      result_link: null,
      locked_by: null,
      locked_at: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
      ...this.payload,
    };
    tables[this.table].push(row);
    return { data: { ...row }, error: null };
  }
  async maybeSingle() {
    if (this.mode === "update") {
      const row = this.rows()[0] ?? null;
      if (!row) return { data: null, error: null };
      Object.assign(row, this.payload, { updated_at: new Date().toISOString() });
      return { data: { ...row }, error: null };
    }
    const row = this.rows()[0] ?? null;
    return { data: row ? { ...row } : null, error: null };
  }
}
const db = { from(table) { return new Query(table); } };

const next = {
  NextResponse: {
    json(value, init = {}) {
      const headers = new Headers(init.headers);
      headers.set("Content-Type", "application/json");
      return new Response(JSON.stringify(value), { ...init, headers });
    },
  },
};
const http = {
  isUuid(value) { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); },
  isHttpUrl(value) { try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; } },
};
const taskApi = load("apps/web/lib/server/task-api.ts", {
  "server-only": {},
  "next/server": next,
  "./agent-auth": {
    async authenticateAgent(request) {
      if (request.headers.get("authorization") !== `Bearer ${agentToken}`) return null;
      return { id: coordinatorId, workspace_id: workspaceId, display_name: "Coordinator", role: "operations", status: "online" };
    },
  },
  "./owner-auth": {
    async authorizeWorkspaceOwner(id) {
      return ownerAuthorized && id === workspaceId
        ? { ok: true, user: { id: ownerId }, workspace: { id: workspaceId, owner_id: ownerId } }
        : { ok: false, status: ownerAuthorized ? 403 : 401 };
    },
  },
  "@/lib/supabase/admin": { createAdminSupabaseClient() { return db; } },
  "./http": http,
});
const collection = load("apps/web/app/api/tasks/route.ts", { "@/lib/server/task-api": taskApi });
const member = load("apps/web/app/api/tasks/[id]/route.ts", { "@/lib/server/task-api": taskApi });

function request(method, pathname, body, agent = false, extraHeaders = {}) {
  return new Request(`https://hub.example${pathname}`, {
    method,
    headers: {
      ...(agent ? { Authorization: `Bearer ${agentToken}` } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
}
async function json(response) { return response.json(); }
async function patch(id, body, agent = true) {
  return member.PATCH(request("PATCH", `/api/tasks/${id}${agent ? "" : `?workspace_id=${workspaceId}`}`, body, agent), { params: Promise.resolve({ id }) });
}

async function main() {
  let response = await collection.POST(request("POST", "/api/tasks", {
    assigned_to: targetId, title: "Plan rollout", detail: "Coordinate the isolated release.", priority: "high",
  }, true));
  assert.equal(response.status, 201);
  assert.match(response.headers.get("cache-control"), /no-store/);
  let payload = await json(response);
  const agentTaskId = payload.task.id;
  assert.equal(payload.task.status, "queued");
  assert.equal(payload.task.assigned_to, targetId);
  assert.equal(tables.tasks[0].status, "PENDING");
  assert.equal(tables.tasks[0].created_by, coordinatorId);
  assert.equal(tables.tasks[0].created_by_type, "agent");
  assert.equal(Object.hasOwn(tables.tasks[0], "priority"), false);

  response = await collection.POST(request("POST", "/api/tasks", {
    workspace_id: workspaceId, assigned_to: targetId, title: "Owner task", detail: "Created by the signed-in owner.",
  }));
  assert.equal(response.status, 201);
  const ownerTaskId = (await json(response)).task.id;
  assert.equal(tables.tasks[1].created_by, ownerId);
  assert.equal(tables.tasks[1].created_by_type, "owner");
  assert.equal(Object.hasOwn(tables.tasks[1], "priority"), false);

  response = await collection.GET(request("GET", "/api/tasks?status=queued&assigned_to=me", undefined, true));
  assert.equal(response.status, 200);
  assert.equal((await json(response)).tasks.length, 0);
  response = await collection.GET(request("GET", `/api/tasks?workspace_id=${workspaceId}&assigned_to=${targetId}`));
  assert.equal(response.status, 200);
  assert.equal((await json(response)).tasks.length, 2);

  response = await patch(agentTaskId, { status: "in_progress" });
  assert.equal(response.status, 200);
  payload = await json(response);
  assert.equal(payload.task.status, "in_progress");
  assert.equal(payload.task.locked_by, targetId);

  response = await patch(agentTaskId, { status: "blocked" });
  assert.equal(response.status, 409);
  response = await patch(agentTaskId, { status: "blocked", blocked_reason: "Waiting for fixture approval." });
  assert.equal(response.status, 200);
  assert.equal((await json(response)).task.status, "blocked");

  response = await patch(agentTaskId, { status: "done", result_link: "https://hub.example/results/fixture" });
  assert.equal(response.status, 200);
  payload = await json(response);
  assert.equal(payload.task.status, "done");
  assert.ok(payload.task.completed_at);

  response = await patch(agentTaskId, { status: "queued" });
  assert.equal(response.status, 200);
  payload = await json(response);
  assert.equal(payload.task.status, "queued");
  assert.equal(payload.task.completed_at, null);
  assert.equal(payload.task.locked_by, null);

  response = await patch(ownerTaskId, { title: "Updated by owner" }, false);
  assert.equal(response.status, 200);
  assert.equal((await json(response)).task.title, "Updated by owner");
  response = await patch(ownerTaskId, { title: "Cross origin" }, false);
  assert.equal(response.status, 200);
  response = await member.PATCH(request("PATCH", `/api/tasks/${ownerTaskId}?workspace_id=${workspaceId}`, { title: "Rejected" }, false, { Origin: "https://evil.example" }), { params: Promise.resolve({ id: ownerTaskId }) });
  assert.equal(response.status, 403);

  response = await collection.GET(request("GET", `/api/tasks?workspace_id=${otherWorkspaceId}`, undefined, true));
  assert.equal(response.status, 403);
  tables.agent_config_state[0].desired_configuration.permissions.delegate = false;
  response = await collection.GET(request("GET", "/api/tasks", undefined, true));
  assert.equal(response.status, 403);
  tables.agent_config_state[0].desired_configuration.permissions.delegate = true;
  tables.agent_config_revisions[0].configuration.permissions.delegate = false;
  response = await collection.POST(request("POST", "/api/tasks", { assigned_to: targetId, title: "Denied", detail: "No applied permission." }, true));
  assert.equal(response.status, 403);
  tables.agent_config_revisions[0].configuration.permissions.delegate = true;

  response = await patch(agentTaskId, { status: "unknown" });
  assert.equal(response.status, 400);
  response = await patch(agentTaskId, { priority: "HIGH" });
  assert.equal(response.status, 400);
  assert.equal(Object.hasOwn(tables.tasks.find(row => row.id === agentTaskId), "priority"), false);
  response = await patch(agentTaskId, { unexpected: true });
  assert.equal(response.status, 400);
  tables.agents.find(row => row.id === targetId).status = "revoked";
  response = await collection.POST(request("POST", "/api/tasks", { assigned_to: targetId, title: "Denied", detail: "Revoked target." }, true));
  assert.equal(response.status, 404);

  ownerAuthorized = false;
  response = await collection.GET(request("GET", `/api/tasks?workspace_id=${workspaceId}`));
  assert.equal(response.status, 401);
  console.log("Task REST routes passed owner/agent authorization, delegation permission, status and workspace isolation checks.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
