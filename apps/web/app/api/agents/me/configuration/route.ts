import type { NextRequest } from "next/server";
import { bridgeConfigurationResponse, pullBridgeConfiguration } from "@/lib/server/bridge-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return bridgeConfigurationResponse(() => pullBridgeConfiguration(request));
}
