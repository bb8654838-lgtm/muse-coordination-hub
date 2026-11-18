import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const allowedStatuses = new Set(["online", "idle", "offline"]);

export async function POST(request: NextRequest) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return apiError("unauthorized", "A valid agent key is required.", 401);

    const body = await request.json().catch(() => ({}));
    const status = typeof body.status === "string" ? body.status : "online";
    if (!allowedStatuses.has(status)) {
      return apiError("invalid_status", "status must be online, idle, or offline.", 400);
    }

    const metadata =
      body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
        ? body.metadata
        : {};
    const seenAt = new Date().toISOString();
    const admin = createAdminSupabaseClient();
    const { error } = await admin.from("heartbeats").upsert(
      {
        agent_id: agent.id,
        workspace_id: agent.workspace_id,
        seen_at: seenAt,
        status,
        metadata,
      },
      { onConflict: "agent_id" },
    );

    if (error) return apiError("heartbeat_failed", "Heartbeat could not be recorded.", 500);
    return NextResponse.json({ ok: true, seen_at: seenAt });
  } catch {
    return apiError("heartbeat_unavailable", "Heartbeat service is unavailable.", 503);
  }
}
