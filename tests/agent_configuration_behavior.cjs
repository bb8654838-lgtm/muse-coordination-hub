/* Real HTTP requests and shared Node/Python on-disk snapshots, fixture-only. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const http = require("node:http");
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const root = path.resolve(__dirname, "..");
const execute = promisify(execFile);
const digest = text => createHash("sha256").update(text, "utf8").digest("hex");
async function main() {
  const { createBridgeClient } = await import("../packages/bridge/src/client.mjs");
  const fixtures = path.join(root, "tests", "stage-b-fixtures");
  await fs.mkdir(fixtures, { recursive: true });
  const directory = await fs.mkdtemp(path.join(fixtures, "interop-"));
  const manual = path.join(directory, "manual", "SKILL.md");
  await fs.mkdir(path.dirname(manual)); await fs.writeFile(manual, "User-owned\r\n");
  const token = "fixture-interop-key";
  const bundle = revision => {
    const content = `---\r\nname: Evidence\r\ndescription: Preserve exact bytes.\r\n---\r\n# Vérification 🏛️ ${revision}\r\n`;
    return { revision, role: { name: "Scoped reviewer", prompt: "Keep scope bounded.", summary: "Evidence only." }, role_prompt: "Keep scope bounded.\n\nRetain sources.", role_summary: "Evidence only.", instructions: "Retain sources.", permissions: { file_read: true, deploy: false }, allowed_actions: ["file_read"], skills: [{ source: "bundled", id: "evidence", version: "1.0.0", name: "Evidence", content, sha256: digest(content) }] };
  };
  let configuration = bundle(1), unavailable = 204, refuseApplied = false;
  const acknowledgments = [];
  const server = http.createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/agents/heartbeat") {
      response.end(JSON.stringify({ agent: { id: "fixture" }, configuration: configuration ? { revision: configuration.revision } : null })); return;
    }
    if (request.url === "/api/agents/me/configuration") {
      if (!configuration) { response.writeHead(unavailable); response.end(); return; }
      response.end(JSON.stringify({ configuration })); return;
    }
    if (request.url === "/api/agents/me/configuration/ack") {
      let text = ""; for await (const chunk of request) text += chunk;
      const body = JSON.parse(text); acknowledgments.push(body);
      if (body.status === "applied" && refuseApplied) { refuseApplied = false; response.writeHead(503); response.end("{}"); return; }
      response.end(JSON.stringify({ acknowledgment: { revision: body.revision, status: body.status } })); return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const python = async skillsDirectory => {
    const code = `import json\nfrom muse_bridge.client import BridgeClient\nc=BridgeClient(base_url=${JSON.stringify(baseUrl)},agent_key=${JSON.stringify(token)},skills_directory=${JSON.stringify(skillsDirectory)})\nprint(json.dumps(c.sync_configuration()))\n`;
    const result = await execute("python3", ["-c", code], { cwd: root, env: { ...process.env, TMPDIR: directory, PYTHONPATH: path.join(root, "packages", "bridge", "python") }, timeout: 15000 });
    return JSON.parse(result.stdout);
  };
  try {
    const client = createBridgeClient({ baseUrl, agentKey: token, skillsDirectory: directory });
    assert.deepEqual(await client.syncConfiguration(), { revision: 1, status: "applied", acknowledged: true });
    assert.deepEqual(acknowledgments.map(a => a.status), ["staged", "applied"]);
    const namespace = path.join(directory, "muse-managed", digest(`${baseUrl}\0${token}`));
    const first = await fs.readlink(path.join(namespace, "current"));
    assert.equal(await fs.readFile(path.join(namespace, "current", "bundled-evidence", "SKILL.md"), "utf8"), configuration.skills[0].content);
    assert.deepEqual(await python(directory), { revision: 1, status: "applied", acknowledged: true });
    assert.equal(await fs.readlink(path.join(namespace, "current")), first);
    assert.deepEqual(acknowledgments.map(a => a.status), ["staged", "applied", "applied"]);
    configuration = bundle(2);
    await client.heartbeat();
    assert.deepEqual(acknowledgments.at(-1), { revision: 2, status: "applied" });
    const second = await fs.readlink(path.join(namespace, "current"));
    assert.notEqual(second, first);
    assert.deepEqual(await python(directory), { revision: 2, status: "applied", acknowledged: true });
    assert.equal(await fs.readFile(manual, "utf8"), "User-owned\r\n");
    assert.equal(await fs.readFile(path.join(namespace, first, "bundled-evidence", "SKILL.md"), "utf8"), bundle(1).skills[0].content);
    configuration = bundle(3); refuseApplied = true;
    assert.deepEqual(await client.syncConfiguration(), { revision: 3, status: "applied", acknowledged: false });
    const stagedCount = acknowledgments.filter(a => a.revision === 3 && a.status === "staged").length;
    assert.deepEqual(await client.syncConfiguration(), { revision: 3, status: "applied", acknowledged: true });
    assert.equal(acknowledgments.filter(a => a.revision === 3 && a.status === "staged").length, stagedCount);
    for (const status of [204, 404]) {
      configuration = null; unavailable = status;
      const neutral = path.join(directory, `neutral-${status}`);
      await fs.mkdir(neutral); await fs.writeFile(path.join(neutral, "SKILL.md"), "Manual\n");
      const neutralClient = createBridgeClient({ baseUrl, agentKey: token, skillsDirectory: neutral });
      assert.equal((await neutralClient.syncConfiguration()).status, "unconfigured");
      assert.equal((await python(neutral)).status, "unconfigured");
      assert.deepEqual(await fs.readdir(neutral), ["SKILL.md"]);
      assert.equal(await fs.readFile(path.join(neutral, "SKILL.md"), "utf8"), "Manual\n");
    }
    console.log("Node/Python real HTTP, heartbeat, immutable snapshot interop, ACK retry and neutral preservation passed.");
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
