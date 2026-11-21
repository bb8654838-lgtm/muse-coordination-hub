import "server-only";

import { authorizeWorkspaceOwner } from "@/lib/server/owner-auth";
import { createServerSupabaseClient } from "@/lib/supabase/server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_BODY_BYTES = 4096;

export type CommerceActionInput = {
  workspace_id: string;
  pack_id: string;
  license_key?: string;
};

export function commerceError(error: string, status: number, message: string) {
  return Response.json({ error, message }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function readCommerceAction(
  request: Request,
  options: { licenseRequired: boolean },
): Promise<CommerceActionInput | Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
    return commerceError("unsupported_content_type", 415, "Send this request as JSON.");
  }
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return commerceError("payload_too_large", 413, "The request is too large.");
  }
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return commerceError("payload_too_large", 413, "The request is too large.");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return commerceError("invalid_json", 400, "The request body is not valid JSON."); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return commerceError("invalid_request", 400, "The request is invalid.");
  const input = value as Record<string, unknown>;
  if (typeof input.workspace_id !== "string" || !UUID.test(input.workspace_id) || typeof input.pack_id !== "string" || !PACK_ID.test(input.pack_id)) {
    return commerceError("invalid_request", 400, "A valid workspace and pack are required.");
  }
  if (options.licenseRequired && (typeof input.license_key !== "string" || input.license_key.length < 1 || input.license_key.length > 256 || /[\x00-\x1f\x7f]/.test(input.license_key))) {
    return commerceError("invalid_license", 400, "Enter a valid license key.");
  }
  return { workspace_id: input.workspace_id, pack_id: input.pack_id, ...(typeof input.license_key === "string" ? { license_key: input.license_key } : {}) };
}

function commerceBaseUrl(): URL | Response {
  const configured = process.env.MUSE_COMMERCE_API_URL?.trim();
  if (!configured) return commerceError("commerce_not_configured", 503, "Pack commerce is not configured for this Hub.");
  try {
    const url = new URL(configured);
    const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !local) || url.username || url.password || url.search || url.hash) throw new Error("invalid origin");
    url.pathname = "/";
    return url;
  } catch {
    return commerceError("commerce_not_configured", 503, "Pack commerce is not configured for this Hub.");
  }
}

export async function proxyCommerceRequest(
  request: Request,
  options: { workspaceId: string; method: "GET" | "POST"; path: string; body?: Record<string, string> },
): Promise<Response> {
  if (!UUID.test(options.workspaceId)) return commerceError("invalid_workspace", 400, "Choose a valid workspace.");
  if (options.method === "POST") {
    const origin = request.headers.get("origin");
    if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
      return commerceError("cross_origin_write", 403, "Cross-origin pack changes are not allowed.");
    }
  }

  const owner = await authorizeWorkspaceOwner(options.workspaceId);
  if (!owner.ok) return commerceError(owner.status === 401 ? "unauthorized" : "forbidden", owner.status, owner.status === 401 ? "Sign in as the workspace owner." : "Only the workspace owner can manage packs.");

  const supabase = await createServerSupabaseClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token || session.user.id !== owner.user.id) return commerceError("unauthorized", 401, "Your session has expired. Sign in again.");

  const base = commerceBaseUrl();
  if (base instanceof Response) return base;
  const target = new URL(options.path.replace(/^\/+/, ""), base);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${session.access_token}`,
    "x-muse-workspace": options.workspaceId,
    Origin: base.origin,
  };
  if (options.body) headers["Content-Type"] = "application/json";

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: options.method,
      headers,
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return commerceError("commerce_unavailable", 502, "Pack commerce is temporarily unavailable.");
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) return commerceError("invalid_commerce_response", 502, "Pack commerce returned an invalid response.");
  const body = await upstream.arrayBuffer();
  if (body.byteLength > 1_048_576) return commerceError("invalid_commerce_response", 502, "Pack commerce returned an oversized response.");
  return new Response(body, {
    status: upstream.status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}
