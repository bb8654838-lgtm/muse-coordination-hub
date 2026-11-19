import Link from "next/link";
import { redirect } from "next/navigation";
import { AgentConfigurationPanel } from "@/components/admin/agent-configuration-panel";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import { isConfigurationSetupError } from "@/lib/server/agent-configuration";
import "./admin.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: workspace, error: workspaceError } = await supabase.from("workspaces")
    .select("id, name, agent_limit").eq("owner_id", user.id)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (workspaceError || !workspace) redirect("/login?error=not-owner");
  const [agents, setup] = await Promise.all([
    supabase.from("agents").select("id, display_name, status").eq("workspace_id", workspace.id)
      .neq("status", "revoked").order("created_at", { ascending: true }),
    supabase.from("agent_config_state").select("agent_id").eq("workspace_id", workspace.id).limit(0),
  ]);
  if (agents.error) throw new Error("The workspace agent list could not be loaded.");
  if (setup.error && !isConfigurationSetupError(setup.error)) throw new Error("Configuration setup could not be verified.");
  const params = await searchParams;
  return <main className="admin-shell min-w-0 w-full">
    <header className="admin-header"><div className="min-w-0"><span className="admin-eyebrow">Workspace configuration</span><h1>Roles &amp; Skills</h1><p>{workspace.name} · Owner-managed desired state</p></div><Link className="admin-button" href="/">Back to Fleet</Link></header>
    <AgentConfigurationPanel workspaceId={workspace.id} agentLimit={workspace.agent_limit} agents={agents.data ?? []} initialAgentId={params.agent} setupRequired={!!setup.error} />
  </main>;
}
