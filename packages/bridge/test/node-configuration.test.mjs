import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeClient } from "../src/client.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");
const content = "# Review\r\nKeep byte identity — evidence first.\n";
function bundle(revision = 1, withSkills = true) {
  return { revision, role: null, role_prompt: "Review carefully.", role_summary: "Reviewer", instructions: "Review carefully.",
    permissions: { file_read: true, file_write: false }, allowed_actions: ["file_read"],
    skills: withSkills ? [{ source: "bundled", id: "review", version: "1.0.0", name: "Review", content, sha256: digest(content) }] : [] };
}
function fixture(directory, configuration = bundle()) {
  const hub = { configuration, acks: [], pulls: 0, heartbeats: 0, failApplied: false, failPull: false, stagedStatus: 200 };
  hub.client = createBridgeClient({ baseUrl: "https://hub.example", agentKey: "fixture-token", skillsDirectory: directory,
    fetchImpl: async (url, options) => {
      const route = new URL(url).pathname;
      if (route === "/api/agents/heartbeat") { hub.heartbeats++; return Response.json({ ok: true, ...(hub.configuration ? { configuration: { revision: hub.configuration.revision } } : {}) }); }
      if (route === "/api/agents/register") return Response.json({ agent_key: "fixture-token", agent: { id: "fixture" } });
      if (route === "/api/agents/me/configuration") { hub.pulls++; if (hub.failPull) throw new Error("fixture-only-raw-error-do-not-transmit"); return hub.configuration ? Response.json({ configuration: hub.configuration }) : new Response(null, { status: 204 }); }
      if (route.endsWith("/ack")) { const value = JSON.parse(options.body); hub.acks.push(value); if (value.status === "staged" && hub.stagedStatus !== 200) return Response.json({ error: "revision_conflict" }, { status: hub.stagedStatus }); if (value.status === "applied" && hub.failApplied) return Response.json({ error: "retry" }, { status: 503 }); return Response.json({ ok: true }); }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  }); return hub;
}
async function namespace(root) { const names = await readdir(join(root, "muse-managed")); return join(root, "muse-managed", names.find(name => /^[a-f0-9]{64}$/.test(name))); }

test("startup/heartbeat synchronize revisions, preserve manual files and deactivate removed skills atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-node-sync-"));
  await mkdir(join(root, "manual")); await writeFile(join(root, "manual", "SKILL.md"), "# Human-owned\n");
  const hub = fixture(root); assert.equal((await hub.client.syncConfiguration()).status, "applied");
  const managed = await namespace(root), first = await readlink(join(managed, "current"));
  assert.equal(await readFile(join(managed, "current", "bundled-review", "SKILL.md"), "utf8"), content);
  assert.deepEqual(hub.acks.map(ack => ack.status), ["staged", "applied"]);
  await hub.client.heartbeat(); assert.equal(hub.pulls, 1);
  hub.configuration = bundle(2, false); await hub.client.heartbeat();
  assert.notEqual(await readlink(join(managed, "current")), first);
  assert.equal(JSON.parse(await readFile(join(managed, "current", "configuration.json"))).revision, 2);
  assert.equal((await readdir(join(managed, "current"))).includes("bundled-review"), false);
  assert.equal(await readFile(join(managed, first, "bundled-review", "SKILL.md"), "utf8"), content);
  assert.equal(await readFile(join(root, "manual", "SKILL.md"), "utf8"), "# Human-owned\n");
  const second = await readlink(join(managed, "current"));
  const restart = fixture(root, bundle(2, false)); await restart.client.syncConfiguration();
  assert.equal(await readlink(join(managed, "current")), second);
  assert.deepEqual(restart.acks.map(ack => ack.status), ["applied"]);
});

test("legacy/unconfigured heartbeat performs no config request and creates no directories", async () => {
  const parent = await mkdtemp(join(tmpdir(), "muse-node-neutral-")), root = join(parent, "untouched");
  const hub = fixture(root, null); await hub.client.heartbeat(); assert.equal(hub.pulls, 0);
  assert.equal((await hub.client.syncConfiguration()).status, "unconfigured");
  assert.deepEqual(await readdir(parent), []); assert.deepEqual(hub.acks, []);
  const legacy = createBridgeClient({ baseUrl: "https://hub.example", agentKey: "fixture-token", skillsDirectory: root, fetchImpl: async () => Response.json({ error: "not_found" }, { status: 404 }) });
  assert.equal((await legacy.syncConfiguration()).status, "unconfigured"); assert.deepEqual(await readdir(parent), []);
});

test("applied ACK retry does not restage; modified managed skills fail without disturbing manual files", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-node-retry-")), hub = fixture(root);
  hub.failApplied = true; assert.deepEqual(await hub.client.syncConfiguration(), { revision: 1, status: "applied", acknowledged: false });
  const managed = await namespace(root), before = await readlink(join(managed, "current"));
  hub.failApplied = false; await hub.client.heartbeat(); assert.equal(await readlink(join(managed, "current")), before);
  assert.deepEqual(hub.acks.map(ack => ack.status), ["staged", "applied", "applied"]);
  await writeFile(join(managed, "current", "bundled-review", "SKILL.md"), "# Local modification");
  hub.configuration = bundle(2); assert.equal((await hub.client.syncConfiguration()).status, "failed");
  assert.equal(await readlink(join(managed, "current")), before); assert.equal(hub.acks.at(-1).status, "failed");
  assert.equal(await readFile(join(managed, "current", "bundled-review", "SKILL.md"), "utf8"), "# Local modification");
});

test("invalid checksum/traversal, unowned namespace and symlink roots never overwrite user files", async () => {
  for (const mutation of [config => { config.skills[0].sha256 = "0".repeat(64); }, config => { config.skills[0].id = "../escape"; }, config => { config.allowed_actions.push("deploy"); }]) {
    const parent = await mkdtemp(join(tmpdir(), "muse-node-invalid-")), root = join(parent, "untouched"), config = bundle(); mutation(config);
    const hub = fixture(root, config); assert.equal((await hub.client.syncConfiguration()).status, "failed"); assert.deepEqual(await readdir(parent), []);
    assert.equal(hub.acks.at(-1).status, "failed"); assert.doesNotMatch(hub.acks.at(-1).error, /fixture-only|escape/);
  }
  const root = await mkdtemp(join(tmpdir(), "muse-node-unowned-")); await mkdir(join(root, "muse-managed")); await writeFile(join(root, "muse-managed", "manual.txt"), "manual");
  assert.equal((await fixture(root).client.syncConfiguration()).status, "failed"); assert.equal(await readFile(join(root, "muse-managed", "manual.txt"), "utf8"), "manual");
  const parent = await mkdtemp(join(tmpdir(), "muse-node-link-")), target = join(parent, "target"), linked = join(parent, "linked"); await mkdir(target); await symlink(target, linked);
  assert.equal((await fixture(linked).client.syncConfiguration()).status, "failed"); assert.deepEqual(await readdir(target), []);
});

test("staged ACK conflict and transient fetch errors keep last active snapshot intact", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-node-conflict-")), hub = fixture(root);
  await hub.client.syncConfiguration(); const managed = await namespace(root), before = await readlink(join(managed, "current"));
  hub.configuration = bundle(2); hub.stagedStatus = 409; assert.equal((await hub.client.syncConfiguration()).status, "failed");
  assert.equal(await readlink(join(managed, "current")), before);
  hub.stagedStatus = 200; await hub.client.heartbeat(); assert.notEqual(await readlink(join(managed, "current")), before);
  hub.failPull = true; const count = hub.acks.length; assert.equal((await hub.client.syncConfiguration()).status, "failed"); assert.equal(hub.acks.length, count);
});

test("registration sync and concurrent heartbeats apply once", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-node-concurrent-")), hub = fixture(root);
  await hub.client.register({ workspaceId: "fixture", inviteKey: "fixture", displayName: "Fixture", role: "review" });
  assert.equal(hub.pulls, 1); hub.configuration = bundle(2);
  await Promise.all([hub.client.heartbeat(), hub.client.heartbeat(), hub.client.heartbeat()]);
  assert.equal(hub.pulls, 2); assert.equal(hub.acks.filter(ack => ack.status === "staged").length, 2);
});
