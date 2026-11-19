import type { NextRequest } from "next/server";
import { bridgeConfigurationResponse, acknowledgeBridgeConfiguration } from "@/lib/server/bridge-configuration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  return bridgeConfigurationResponse(() => acknowledgeBridgeConfiguration(request));
}
