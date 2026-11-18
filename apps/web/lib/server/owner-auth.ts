import "server-only";

import { createAdminSupabaseClient } from "@/lib/supabase/admin";
import { createServerSupabaseClient } from "@/lib/supabase/server";

export type OwnerAuthorization =
  | {
      ok: true;
      user: { id: string; email?: string };
      workspace: { id: string; name: string; owner_id: string; agent_limit: number };
    }
  | { ok: false; status: 401 | 403 };

export async function authorizeWorkspaceOwner(
  workspaceId: string,
): Promise<OwnerAuthorization> {
  const supabase = await createServerSupabaseClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) return { ok: false, status: 401 };

  const admin = createAdminSupabaseClient();
  const { data: workspace } = await admin
    .from("workspaces")
    .select("id, name, owner_id, agent_limit")
    .eq("id", workspaceId)
    .eq("owner_id", user.id)
    .maybeSingle();

  if (!workspace) return { ok: false, status: 403 };

  return {
    ok: true,
    user: { id: user.id, email: user.email },
    workspace,
  };
}
