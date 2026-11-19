import { configurationResponse, listRoles, readConfigurationBody, requireOwner as authorizeWorkspaceOwner, saveRole } from "@/lib/server/agent-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return configurationResponse(async () => {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    return listRoles(await authorizeWorkspaceOwner(workspaceId));
  });
}

export async function POST(request: Request) {
  return configurationResponse(async () => {
    const body = await readConfigurationBody(request);
    const workspaceId = body.workspace_id;
    return saveRole(await authorizeWorkspaceOwner(workspaceId), body);
  }, 201);
}
