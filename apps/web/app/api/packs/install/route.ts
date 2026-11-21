import { proxyCommerceRequest, readCommerceAction } from "@/lib/server/commerce-proxy";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const input = await readCommerceAction(request, { licenseRequired: false });
  if (input instanceof Response) return input;
  return proxyCommerceRequest(request, {
    workspaceId: input.workspace_id,
    method: "POST",
    path: `/api/owner/packs/${input.pack_id}/install`,
    body: { pack_id: input.pack_id },
  });
}
