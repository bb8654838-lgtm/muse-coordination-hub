import { proxyCommerceRequest } from "@/lib/server/commerce-proxy";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const workspaceId = new URL(request.url).searchParams.get("workspace_id") ?? "";
  return proxyCommerceRequest(request, { workspaceId, method: "GET", path: "/api/pro/packs" });
}
