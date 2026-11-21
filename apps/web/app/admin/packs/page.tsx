import Link from "next/link";
import { redirect } from "next/navigation";
import { PackManagementPanel } from "@/components/admin/pack-management-panel";
import { createServerSupabaseClient } from "@/lib/supabase/server";
import "../admin.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PacksPage() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: workspace, error } = await supabase.from("workspaces")
    .select("id, name").eq("owner_id", user.id)
    .order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (error || !workspace) redirect("/login?error=not-owner");

  return <main className="admin-shell min-w-0 w-full">
    <header className="admin-header">
      <div className="min-w-0"><span className="admin-eyebrow">Workspace configuration</span><h1>Pack Library</h1><p>{workspace.name} · Licensed role and workflow bundles</p></div>
      <nav className="admin-header-actions" aria-label="Admin navigation"><Link className="admin-button" href="/admin">Roles &amp; Skills</Link><Link className="admin-button" href="/">Back to Fleet</Link></nav>
    </header>
    <PackManagementPanel workspaceId={workspace.id} />
  </main>;
}
