import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { hashSecret, requiredServerSecret } from "@/lib/server/agent-auth";
import { authorizeWorkspaceOwner } from "@/lib/server/owner-auth";
import { apiError, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const workspaceId = body?.workspace_id;
  if (!isUuid(workspaceId)) return apiError("invalid_workspace", "A valid workspace is required.", 400);

  const authorization = await authorizeWorkspaceOwner(workspaceId);
  if (!authorization.ok) {
    return apiError(
      authorization.status === 401 ? "unauthorized" : "forbidden",
      authorization.status === 401 ? "Sign in as the workspace owner." : "Workspace owner access is required.",
      authorization.status,
    );
  }

  const inviteKey = randomBytes(32).toString("hex");
  const inviteHash = hashSecret(inviteKey, requiredServerSecret("MUSE_INVITE_PEPPER"));
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from("workspaces")
    .update({ agent_invite_hash: inviteHash })
    .eq("id", workspaceId)
    .eq("owner_id", authorization.user.id)
    .select("id, updated_at")
    .single();

  if (error) return apiError("invite_rotation_failed", "The invite key could not be rotated.", 500);

  return NextResponse.json(
    { workspace_id: data.id, invite_key: inviteKey, rotated_at: data.updated_at },
    { headers: { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" } },
  );
}
