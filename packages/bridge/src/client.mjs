const DEFAULT_TIMEOUT_MS = 30_000;

export class BridgeError extends Error {
  constructor(message, { status = 0, payload = null } = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = status;
    this.payload = payload;
  }
}

function normalizedBaseUrl(value) {
  if (!value || typeof value !== "string") {
    throw new TypeError("baseUrl is required");
  }
  return value.replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Polling aborted"));
      },
      { once: true },
    );
  });
}

export function createBridgeClient({
  baseUrl,
  agentKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("A Fetch-compatible implementation is required");
  }

  const origin = normalizedBaseUrl(baseUrl);

  async function request(path, { method = "GET", payload, query, authenticated = true } = {}) {
    if (authenticated && !agentKey) {
      throw new BridgeError("MUSE_AGENT_KEY is required for this operation");
    }

    const url = new URL(`${origin}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const headers = { Accept: "application/json" };
    if (authenticated) headers.Authorization = `Bearer ${agentKey}`;
    if (payload !== undefined) headers["Content-Type"] = "application/json";

    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), positiveInteger(timeoutMs, DEFAULT_TIMEOUT_MS));

    let response;
    try {
      response = await fetchImpl(url.toString(), {
        method,
        headers,
        body: payload === undefined ? undefined : JSON.stringify(payload),
        signal: timeoutController.signal,
      });
    } catch (error) {
      throw new BridgeError(`Hub request failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }
    }

    if (!response.ok) {
      const message = data?.error?.message ?? `Hub returned HTTP ${response.status}`;
      throw new BridgeError(message, { status: response.status, payload: data });
    }
    return data;
  }

  return {
    register({ workspaceId, inviteKey, displayName, role }) {
      return request("/api/agents/register", {
        method: "POST",
        authenticated: false,
        payload: {
          workspace_id: workspaceId,
          invite_key: inviteKey,
          display_name: displayName,
          role,
        },
      });
    },

    heartbeat({ status = "online", metadata = {} } = {}) {
      return request("/api/agents/heartbeat", {
        method: "POST",
        payload: { status, metadata },
      });
    },

    inbox({ limit = 50 } = {}) {
      return request("/api/inbox", {
        query: { limit: Math.min(100, positiveInteger(limit, 50)) },
      });
    },

    sendMessage({ channelId, body, type = "NOTE", mentions = [], replyTo = null, metadata = {} }) {
      return request("/api/messages", {
        method: "POST",
        payload: {
          channel_id: channelId,
          body,
          type,
          mentions,
          reply_to: replyTo,
          metadata,
        },
      });
    },

    uploadFile({ name, contentBase64, contentType = "application/octet-stream", taskId = null }) {
      return request("/api/files", {
        method: "POST",
        payload: {
          name,
          content_base64: contentBase64,
          content_type: contentType,
          task_id: taskId,
        },
      });
    },

    ackTask(taskId) {
      return request(`/api/tasks/${encodeURIComponent(taskId)}/ack`, { method: "POST" });
    },

    completeTask(taskId, { resultLink = null } = {}) {
      return request(`/api/tasks/${encodeURIComponent(taskId)}/complete`, {
        method: "POST",
        payload: { result_link: resultLink },
      });
    },

    async *pollInbox({ limit = 50, intervalSeconds = 60, signal } = {}) {
      const intervalMs = Math.max(5, positiveInteger(intervalSeconds, 60)) * 1000;
      while (!signal?.aborted) {
        yield await this.inbox({ limit });
        await delay(intervalMs, signal);
      }
    },
  };
}
