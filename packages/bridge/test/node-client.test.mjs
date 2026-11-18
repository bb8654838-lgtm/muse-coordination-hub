import assert from "node:assert/strict";
import test from "node:test";

import { createBridgeClient } from "../src/client.mjs";

function recordingFetch() {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
      async text() {
        return JSON.stringify({ ok: true });
      },
    };
  };
  return { calls, fetchImpl };
}

test("registration sends a user-defined display name and role", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = createBridgeClient({ baseUrl: "https://hub.example", fetchImpl });
  await client.register({
    workspaceId: "workspace-id",
    inviteKey: "invite-key",
    displayName: "Custom Name",
    role: "Custom Role",
  });

  assert.equal(calls[0].url, "https://hub.example/api/agents/register");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    workspace_id: "workspace-id",
    invite_key: "invite-key",
    display_name: "Custom Name",
    role: "Custom Role",
  });
});

test("authenticated operations cover heartbeat, inbox, ACK lock, and completion", async () => {
  const { calls, fetchImpl } = recordingFetch();
  const client = createBridgeClient({
    baseUrl: "https://hub.example/",
    agentKey: "agent-secret",
    fetchImpl,
  });

  await client.heartbeat({ status: "online" });
  await client.inbox({ limit: 25 });
  await client.uploadFile({
    name: "result.txt",
    contentBase64: "cmVzdWx0",
    contentType: "text/plain",
    taskId: "task-id",
  });
  await client.ackTask("task-id");
  await client.completeTask("task-id", { resultLink: "https://result.example/item" });

  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    [
      "/api/agents/heartbeat",
      "/api/inbox",
      "/api/files",
      "/api/tasks/task-id/ack",
      "/api/tasks/task-id/complete",
    ],
  );
  assert.equal(new URL(calls[1].url).searchParams.get("limit"), "25");
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    name: "result.txt",
    content_base64: "cmVzdWx0",
    content_type: "text/plain",
    task_id: "task-id",
  });
  for (const call of calls) {
    assert.equal(call.init.headers.Authorization, "Bearer agent-secret");
  }
});
