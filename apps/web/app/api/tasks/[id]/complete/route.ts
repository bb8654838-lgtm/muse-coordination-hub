import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError, boundedString, isHttpUrl, isUuid } from "@/lib/server/http";
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

    const body = await request.json().catch(() => ({}));
    const rawResultLink = body.result_link ?? null;
    const resultLink = rawResultLink === null ? null : boundedString(rawResultLink, 2048);
    if (rawResultLink !== null && (!resultLink || !isHttpUrl(resultLink))) {
      return apiError("invalid_result_link", "result_link must be an HTTP or HTTPS URL.", 400);
    }

    const completedAt = new Date().toISOString();
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin
      .from("tasks")
      .update({ status: "DONE", result_link: resultLink, completed_at: completedAt })
      .eq("id", id)
      .eq("workspace_id", agent.workspace_id)
      .eq("assigned_to", agent.id)
      .eq("locked_by", agent.id)
      .eq("status", "IN_PROGRESS")
      .select("id, title, status, result_link, completed_at, updated_at")
      .maybeSingle();

    if (error) return apiError("task_completion_failed", "Task completion failed.", 500);
    if (!data) {
      return apiError(
        "task_not_completable",
        "Task must be ACKed and locked by this agent before completion.",
        409,
      );
    }

    return NextResponse.json({ task: data });
  } catch {
    return apiError("tasks_unavailable", "Task service is unavailable.", 503);
  }
}
