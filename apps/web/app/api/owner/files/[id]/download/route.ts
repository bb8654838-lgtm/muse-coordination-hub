import { NextRequest, NextResponse } from "next/server";

import { authorizeWorkspaceOwner } from "@/lib/server/owner-auth";
import { apiError, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
const STORAGE_BUCKET = "handoffs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const workspaceId = request.nextUrl.searchParams.get("workspace_id");
  if (!isUuid(id) || !isUuid(workspaceId)) {
    return apiError("invalid_request", "Valid workspace and file ids are required.", 400);
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
  const { data: file } = await admin
    .from("files")
    .select("storage_path")
    .eq("id", id)
    .eq("workspace_id", workspaceId)
    .neq("state", "deleted")
    .maybeSingle();
  if (!file) return apiError("file_not_found", "File not found.", 404);

  const { data, error } = await admin.storage
    .from(STORAGE_BUCKET)
    .createSignedUrl(file.storage_path, 60);
  if (error || !data?.signedUrl) {
    return apiError("download_failed", "A download link could not be created.", 500);
  }

  return NextResponse.redirect(data.signedUrl, {
    headers: { "Cache-Control": "no-store, max-age=0" },
  });
}
