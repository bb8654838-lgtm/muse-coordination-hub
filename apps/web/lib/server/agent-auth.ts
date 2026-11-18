import "server-only";

import { createHmac } from "node:crypto";
import type { NextRequest } from "next/server";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export type AgentIdentity = {
  id: string;
  workspace_id: string;
  display_name: string;
  role: string;
  status: string;
};

export function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
}

export function requiredServerSecret(name: "MUSE_AGENT_KEY_PEPPER" | "MUSE_INVITE_KEY_PEPPER") {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} must contain at least 32 characters.`);
  }
  return value;
}

export async function authenticateAgent(request: NextRequest): Promise<AgentIdentity | null> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return null;
  }

  const rawKey = authorization.slice("Bearer ".length).trim();
  if (rawKey.length < 32) {
    return null;
  }

  const keyHash = hashSecret(rawKey, requiredServerSecret("MUSE_AGENT_KEY_PEPPER"));
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("agents")
    .select("id, workspace_id, display_name, role, status")
    .eq("api_key_hash", keyHash)
    .neq("status", "revoked")
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as AgentIdentity;
}
