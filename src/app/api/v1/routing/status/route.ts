import { NextResponse } from "next/server";

import { getLockedRoutingCapabilities } from "@omniroute/open-sse/services/lockedTarget.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(getLockedRoutingCapabilities(), {
    headers: { "Cache-Control": "no-store" },
  });
}
