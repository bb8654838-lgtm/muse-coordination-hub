import { configurationResponse, listSkills, readConfigurationBody, requireOwner as authorizeWorkspaceOwner, saveSkill } from "@/lib/server/agent-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return configurationResponse(async () => {
    const workspaceId = new URL(request.url).searchParams.get("workspace_id");
    return listSkills(await authorizeWorkspaceOwner(workspaceId));
  });
}

export async function POST(request: Request) {
  return configurationResponse(async () => {
    const body = await readConfigurationBody(request);
    const workspaceId = body.workspace_id;
    return saveSkill(await authorizeWorkspaceOwner(workspaceId), body);
  }, 201);
}
