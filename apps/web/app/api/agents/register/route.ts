import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { hashSecret, requiredServerSecret } from "@/lib/server/agent-auth";
import { apiError, boundedString, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return apiError("invalid_json", "A JSON request body is required.", 400);
  }

  const workspaceId = body.workspace_id;
  const inviteKey = boundedString(body.invite_key, 512);
  const displayName = boundedString(body.display_name, 80);
  const role = boundedString(body.role, 120);

  if (!isUuid(workspaceId) || !inviteKey || !displayName || !role) {
    return apiError(
      "invalid_registration",
      "workspace_id, invite_key, display_name, and role are required.",
      400,
    );
  }

  try {
    const admin = createAdminSupabaseClient();
    const rawAgentKey = `muse_${randomBytes(32).toString("base64url")}`;
    const inviteHash = hashSecret(
      inviteKey,
      requiredServerSecret("MUSE_INVITE_PEPPER"),
    );
    const agentKeyHash = hashSecret(
      rawAgentKey,
      requiredServerSecret("MUSE_AGENT_KEY_PEPPER"),
    );

    const { data, error } = await admin.rpc("register_agent", {
      p_workspace_id: workspaceId,
      p_invite_key_hash: inviteHash,
      p_display_name: displayName,
      p_role: role,
      p_api_key_hash: agentKeyHash,
    });

    if (error) {
      const reason = `${error.message} ${error.details ?? ""}`.toLowerCase();
      if (reason.includes("agent_limit_reached")) {
        return apiError(
          "agent_limit_reached",
          "This workspace already has its maximum of 10 active agents.",
          409,
        );
      }
      if (reason.includes("invalid_invite_key")) {
        return apiError("invalid_invite_key", "The invite key is invalid.", 401);
      }
      if (reason.includes("workspace_not_found")) {
        return apiError("workspace_not_found", "Workspace not found.", 404);
      }
      if (error.code === "23505") {
        return apiError(
          "agent_identity_conflict",
          "That display name is already active in this workspace.",
          409,
        );
      }
      return apiError("registration_failed", "Agent registration failed.", 500);
    }

    const agent = Array.isArray(data) ? data[0] : data;
    return NextResponse.json(
      {
        agent: {
          id: agent.id,
          workspace_id: agent.workspace_id,
          display_name: agent.display_name,
          role: agent.role,
          status: agent.status,
        },
        agent_key: rawAgentKey,
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return apiError("server_not_configured", "The registration service is unavailable.", 503);
  }
}
