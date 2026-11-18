import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return apiError("unauthorized", "A valid agent key is required.", 401);

    const { id } = await context.params;
    if (!isUuid(id)) return apiError("invalid_task_id", "A valid task id is required.", 400);

    const lockedAt = new Date().toISOString();
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from("tasks")
      .update({ status: "IN_PROGRESS", locked_by: agent.id, locked_at: lockedAt })
      .eq("id", id)
      .eq("workspace_id", agent.workspace_id)
      .eq("assigned_to", agent.id)
      .eq("status", "PENDING")
      .is("locked_by", null)
      .select("id, title, status, assigned_to, locked_by, locked_at, updated_at")
      .maybeSingle();

    if (error) return apiError("task_ack_failed", "Task ACK failed.", 500);
    if (!data) {
      return apiError(
        "task_not_claimable",
        "Task is not pending, is assigned elsewhere, or has already been locked.",
        409,
      );
    }

    return NextResponse.json({ task: data });
  } catch {
    return apiError("tasks_unavailable", "Task service is unavailable.", 503);
  }
}
