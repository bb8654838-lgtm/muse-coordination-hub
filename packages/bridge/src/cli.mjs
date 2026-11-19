#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import { createBridgeClient, BridgeError } from "./client.mjs";

const contentTypes = new Map([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".txt", "text/plain"],
  [".webp", "image/webp"],
  [".zip", "application/zip"],
]);

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const options = {};
  const positionals = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll("-", "_");
    const next = tokens[index + 1];
    if (!next || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return { command, options, positionals };
}

function required(value, label) {
  if (!value || value === true) throw new Error(`${label} is required`);
  return value;
}

function usage() {
  console.log(`Muse Bridge (Node.js)

Usage:
  muse-bridge register --workspace ID --invite KEY --name NAME --role ROLE
  muse-bridge heartbeat [--status online|idle|offline]
  muse-bridge inbox [--limit 50] [--watch] [--interval 60]
  muse-bridge message --channel ID --body TEXT [--type NOTE] [--mentions ID,ID]
  muse-bridge file FILE_PATH [--task TASK_ID] [--content-type MIME]
  muse-bridge ack TASK_ID
  muse-bridge complete TASK_ID [--result-link URL]

Configuration:
  --url URL       defaults to MUSE_HUB_URL
  --key KEY       defaults to MUSE_AGENT_KEY (environment use is safer)
`);
}

async function main() {
  const { command, options, positionals } = parseArguments(process.argv.slice(2));
  if (!command || command === "help" || options.help) {
    usage();
    return;
  }

  const client = createBridgeClient({
    baseUrl: options.url || process.env.MUSE_HUB_URL,
    agentKey: options.key || process.env.MUSE_AGENT_KEY,
  });

  if ((options.key || process.env.MUSE_AGENT_KEY) && command !== "heartbeat" && command !== "register") await client.syncConfiguration();
  let result;
  switch (command) {
    case "register":
      result = await client.register({
        workspaceId: required(options.workspace, "--workspace"),
        inviteKey: required(options.invite, "--invite"),
        displayName: required(options.name, "--name"),
        role: required(options.role, "--role"),
      });
      break;
    case "heartbeat":
      result = await client.heartbeat({ status: options.status || "online" });
      break;
    case "inbox":
      if (options.watch) {
        const controller = new AbortController();
        process.once("SIGINT", () => controller.abort());
        for await (const inbox of client.pollInbox({
          limit: options.limit || 50,
          intervalSeconds: options.interval || 60,
          signal: controller.signal,
        })) {
          console.log(JSON.stringify(inbox));
        }
        return;
      }
      result = await client.inbox({ limit: options.limit || 50 });
      break;
    case "message":
      result = await client.sendMessage({
        channelId: required(options.channel, "--channel"),
        body: required(options.body, "--body"),
        type: options.type || "NOTE",
        mentions:
          typeof options.mentions === "string"
            ? options.mentions.split(",").map((value) => value.trim()).filter(Boolean)
            : [],
        replyTo: options.reply_to || null,
      });
      break;
    case "file": {
      const filePath = required(positionals[0], "FILE_PATH");
      const content = await readFile(filePath);
      const suffix = extname(filePath).toLowerCase();
      result = await client.uploadFile({
        name: basename(filePath),
        contentBase64: content.toString("base64"),
        contentType: options.content_type || contentTypes.get(suffix) || "application/octet-stream",
        taskId: options.task || null,
      });
      break;
    }
    case "ack":
      result = await client.ackTask(required(positionals[0], "TASK_ID"));
      break;
    case "complete":
      result = await client.completeTask(required(positionals[0], "TASK_ID"), {
        resultLink: options.result_link || null,
      });
      break;
    default:
      usage();
      throw new Error(`Unknown command: ${command}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  if (error instanceof BridgeError) {
    console.error(JSON.stringify({ error: error.message, status: error.status, details: error.payload }));
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
});
