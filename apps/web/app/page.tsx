import { redirect } from "next/navigation";

import { OwnerDashboard } from "@/components/owner-dashboard";
import type {
  Agent,
  Channel,
  DashboardSnapshot,
  HandoffFile,
  Message,
  Task,
  Workspace,
} from "@/lib/dashboard-types";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardPage() {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: workspace, error: workspaceError } = await supabase
    .from("workspaces")
    .select("id, name, owner_id, agent_limit, created_at")
    .eq("owner_id", user.id)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (workspaceError || !workspace) redirect("/login?error=not-owner");

  const workspaceId = workspace.id;
  const [agentsResult, channelsResult, messagesResult, tasksResult, filesResult] =
    await Promise.all([
      supabase
        .from("agents")
        .select("id, workspace_id, display_name, role, status, last_seen_at, created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true }),
      supabase
        .from("channels")
        .select("id, workspace_id, name, channel_type, member_agent_ids, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: true }),
      supabase
        .from("messages")
        .select("id, workspace_id, channel_id, sender_type, sender_id, body, message_type, mentions, reply_to, metadata, created_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false })
        .limit(200),
      supabase
        .from("tasks")
        .select("id, workspace_id, channel_id, title, detail, assigned_to, created_by, created_by_type, status, due_at, result_link, blocked_reason, locked_by, locked_at, completed_at, created_at, updated_at")
        .eq("workspace_id", workspaceId)
        .order("created_at", { ascending: false }),
      supabase
        .from("files")
        .select("id, workspace_id, task_id, name, content_type, size_bytes, uploaded_by, uploaded_by_type, state, created_at")
        .eq("workspace_id", workspaceId)
        .neq("state", "deleted")
        .order("created_at", { ascending: false }),
    ]);

  const firstError = [agentsResult, channelsResult, messagesResult, tasksResult, filesResult]
    .map((result) => result.error)
    .find(Boolean);
  if (firstError) throw new Error("The owner dashboard could not be loaded.");

  const snapshot: DashboardSnapshot = {
    workspace: workspace as Workspace,
    agents: (agentsResult.data ?? []) as Agent[],
    channels: (channelsResult.data ?? []) as Channel[],
    messages: ((messagesResult.data ?? []) as Message[]).reverse(),
    tasks: (tasksResult.data ?? []) as Task[],
    files: (filesResult.data ?? []) as HandoffFile[],
  };

  return (
    <OwnerDashboard
      initial={snapshot}
      user={{ id: user.id, email: user.email ?? "Owner" }}
    />
  );
}
