import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return apiError("unauthorized", "A valid agent key is required.", 401);

    const requestedLimit = Number.parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 50;
    const admin = createAdminSupabaseClient();

    const { data: channels, error: channelError } = await admin
      .from("channels")
      .select("id, name, channel_type, member_agent_ids")
      .eq("workspace_id", agent.workspace_id);

    if (channelError) return apiError("inbox_failed", "Inbox channels could not be read.", 500);

    const visibleChannels = (channels ?? []).filter(
      (channel) =>
        channel.channel_type === "group" ||
        (Array.isArray(channel.member_agent_ids) && channel.member_agent_ids.includes(agent.id)),
    );
    const channelIds = visibleChannels.map((channel) => channel.id);

    let messages: unknown[] = [];
    if (channelIds.length > 0) {
      const { data, error } = await admin
        .from("messages")
        .select("id, channel_id, sender_type, sender_id, body, message_type, mentions, reply_to, metadata, created_at")
        .in("channel_id", channelIds)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return apiError("inbox_failed", "Inbox messages could not be read.", 500);
      messages = (data ?? []).reverse();
    }

    const { data: tasks, error: taskError } = await admin
      .from("tasks")
      .select("id, channel_id, title, detail, status, due_at, result_link, locked_at, created_at, updated_at")
      .eq("workspace_id", agent.workspace_id)
      .eq("assigned_to", agent.id)
      .in("status", ["PENDING", "IN_PROGRESS", "BLOCKED", "ESCALATED"])
      .order("created_at", { ascending: true })
      .limit(limit);

    if (taskError) return apiError("inbox_failed", "Assigned tasks could not be read.", 500);

    return NextResponse.json(
      { agent, channels: visibleChannels, messages, tasks: tasks ?? [] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return apiError("inbox_unavailable", "Inbox service is unavailable.", 503);
  }
}
