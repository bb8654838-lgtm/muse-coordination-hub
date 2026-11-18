import { NextRequest, NextResponse } from "next/server";

import { authorizeWorkspaceOwner } from "@/lib/server/owner-auth";
import { apiError, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const workspaceId = body?.workspace_id;
  const agentId = body?.agent_id;
  if (!isUuid(workspaceId) || !isUuid(agentId)) {
    return apiError("invalid_request", "Valid workspace and agent ids are required.", 400);
  }

  const authorization = await authorizeWorkspaceOwner(workspaceId);
  if (!authorization.ok) {
    return apiError(
      authorization.status === 401 ? "unauthorized" : "forbidden",
      authorization.status === 401 ? "Sign in as the workspace owner." : "Workspace owner access is required.",
      authorization.status,
    );
  }

  const admin = createAdminSupabaseClient();
  const { data: agent } = await admin
    .from("agents")
    .select("id, display_name")
    .eq("id", agentId)
    .eq("workspace_id", workspaceId)
    .neq("status", "revoked")
    .maybeSingle();
  if (!agent) return apiError("agent_not_found", "Active agent not found.", 404);

  const { data: candidates, error: lookupError } = await admin
    .from("channels")
    .select("id, workspace_id, name, channel_type, member_agent_ids, created_at")
    .eq("workspace_id", workspaceId)
    .eq("channel_type", "dm")
    .contains("member_agent_ids", [agentId]);
  if (lookupError) return apiError("dm_failed", "The direct channel could not be read.", 500);

  const existing = (candidates ?? []).find(
    (channel) => channel.member_agent_ids.length === 1 && channel.member_agent_ids[0] === agentId,
  );
  if (existing) return NextResponse.json({ channel: existing });

  const safeName = agent.display_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "agent";
  const { data: channel, error } = await admin
    .from("channels")
    .insert({
      workspace_id: workspaceId,
      name: `dm-${safeName}-${agent.id.slice(0, 8)}`,
      channel_type: "dm",
      member_agent_ids: [agentId],
    })
    .select("id, workspace_id, name, channel_type, member_agent_ids, created_at")
    .single();
  if (error) return apiError("dm_failed", "The direct channel could not be created.", 500);

  return NextResponse.json({ channel }, { status: 201 });
}
