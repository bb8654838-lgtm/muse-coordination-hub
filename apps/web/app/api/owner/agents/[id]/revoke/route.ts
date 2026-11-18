import { NextRequest, NextResponse } from "next/server";

import { authorizeWorkspaceOwner } from "@/lib/server/owner-auth";
import { apiError, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await request.json().catch(() => null);
  const workspaceId = body?.workspace_id;
  if (!isUuid(id) || !isUuid(workspaceId)) {
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
  const { data, error } = await admin
    .from("agents")
    .update({ status: "revoked" })
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .neq("status", "revoked")
    .select("id, display_name, status, updated_at")
    .maybeSingle();

  if (error) return apiError("revoke_failed", "The agent could not be revoked.", 500);
  if (!data) return apiError("agent_not_found", "Active agent not found.", 404);

  return NextResponse.json({ agent: data });
}
