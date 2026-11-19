import { configurationResponse, getAgentConfiguration, readConfigurationBody, requireOwner as authorizeWorkspaceOwner, saveAgentConfiguration } from "@/lib/server/agent-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return configurationResponse(async () => {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    return getAgentConfiguration(await authorizeWorkspaceOwner(workspaceId), (await context.params).id);
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return configurationResponse(async () => {
    const body = await readConfigurationBody(request);
    const workspaceId = body.workspace_id;
    // The atomic base_revision check is mapped to HTTP 409 by configurationResponse.
    return saveAgentConfiguration(await authorizeWorkspaceOwner(workspaceId), (await context.params).id, body);
  });
}
