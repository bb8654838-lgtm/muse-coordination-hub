import { configurationResponse, readConfigurationBody, requireOwner as authorizeWorkspaceOwner, saveRole } from "@/lib/server/agent-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return configurationResponse(async () => {
    const body = await readConfigurationBody(request);
    const workspaceId = body.workspace_id;
    return saveRole(await authorizeWorkspaceOwner(workspaceId), body, (await context.params).id);
  });
}
