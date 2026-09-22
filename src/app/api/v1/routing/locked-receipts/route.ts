import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { extractApiKey, isValidApiKey } from "@/sse/services/auth";
import { isDashboardSessionAuthenticated } from "@/shared/utils/apiAuth";
import { isRequireApiKeyEnabled } from "@/shared/utils/featureFlags";
import { getLockedTargetReceipt } from "@omniroute/open-sse/services/lockedTarget.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const apiKey = extractApiKey(request);
  const apiKeyOk = apiKey ? await isValidApiKey(apiKey) : false;
  const dashboardOk = !apiKeyOk ? await isDashboardSessionAuthenticated(request) : false;
  if (!apiKeyOk && !dashboardOk && isRequireApiKeyEnabled()) {
    return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Authentication required");
  }
  const planId = new URL(request.url).searchParams.get("plan_id")?.trim() || "";
  if (!planId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "plan_id is required");
  const receipt = getLockedTargetReceipt(planId);
  if (!receipt) return errorResponse(HTTP_STATUS.NOT_FOUND, "Locked target receipt not found");
  return NextResponse.json(receipt, { headers: { "Cache-Control": "no-store" } });
}
