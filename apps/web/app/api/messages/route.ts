import { NextRequest, NextResponse } from "next/server";

import { authenticateAgent } from "@/lib/server/agent-auth";
import { apiError, boundedString, isUuid } from "@/lib/server/http";
import { createAdminSupabaseClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const allowedMessageTypes = new Set(["NOTE", "TASK", "HANDOFF", "ALERT", "DONE"]);

export async function POST(request: NextRequest) {
  try {
    const agent = await authenticateAgent(request);
    if (!agent) return apiError("unauthorized", "A valid agent key is required.", 401);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return apiError("invalid_json", "A JSON request body is required.", 400);
    }

    const channelId = body.channel_id;
    const messageBody = boundedString(body.body, 20000);
    const messageType = typeof body.type === "string" ? body.type.toUpperCase() : "NOTE";
    const replyTo = body.reply_to ?? null;
    const mentions = Array.isArray(body.mentions)
      ? [...new Set(body.mentions.filter(isUuid))].slice(0, 10)
      : [];

    if (!isUuid(channelId) || !messageBody || !allowedMessageTypes.has(messageType)) {
      return apiError("invalid_message", "channel_id, body, and a valid message type are required.", 400);
    }
    if (replyTo !== null && !isUuid(replyTo)) {
      return apiError("invalid_reply", "reply_to must be a valid message id.", 400);
    }

    const admin = createAdminSupabaseClient();
    const { data: channel, error: channelError } = await admin
      .from("channels")
      .select("id, channel_type, member_agent_ids")
      .eq("id", channelId)
      .eq("workspace_id", agent.workspace_id)
      .maybeSingle();

    if (channelError || !channel) return apiError("channel_not_found", "Channel not found.", 404);
    if (
      channel.channel_type === "dm" &&
      (!Array.isArray(channel.member_agent_ids) || !channel.member_agent_ids.includes(agent.id))
    ) {
      return apiError("forbidden", "This agent is not a member of that DM.", 403);
    }

    if (mentions.length > 0) {
      const { data: mentionAgents, error: mentionError } = await admin
        .from("agents")
        .select("id")
        .eq("workspace_id", agent.workspace_id)
        .in("id", mentions)
        .neq("status", "revoked");
      if (mentionError || (mentionAgents ?? []).length !== mentions.length) {
        return apiError("invalid_mentions", "Every mention must identify an active workspace agent.", 400);
      }
    }

    if (replyTo) {
      const { data: parent } = await admin
        .from("messages")
        .select("id")
        .eq("id", replyTo)
        .eq("workspace_id", agent.workspace_id)
        .maybeSingle();
      if (!parent) return apiError("invalid_reply", "The parent message is not in this workspace.", 400);
    }

    const { data, error } = await admin
      .from("messages")
      .insert({
        workspace_id: agent.workspace_id,
        channel_id: channelId,
        sender_type: "agent",
        sender_id: agent.id,
        body: messageBody,
        message_type: messageType,
        mentions,
        reply_to: replyTo,
        metadata:
          body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
            ? body.metadata
            : {},
      })
      .select("id, channel_id, sender_type, sender_id, body, message_type, mentions, reply_to, metadata, created_at")
      .single();

    if (error) return apiError("message_failed", "Message could not be sent.", 500);
    return NextResponse.json({ message: data }, { status: 201 });
  } catch {
    return apiError("messages_unavailable", "Messaging service is unavailable.", 503);
  }
}
