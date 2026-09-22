import { NextResponse } from "next/server";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { HTTP_STATUS } from "@omniroute/open-sse/config/constants.ts";
import { getLockedTargetReceipt } from "@omniroute/open-sse/services/lockedTarget.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const planId = params.get("plan_id")?.trim() || "";
  if (!planId) return errorResponse(HTTP_STATUS.BAD_REQUEST, "plan_id is required");
  // The plan-scoped capability is supplied by Quattro on dispatch. Existing
  // Quattro releases use their UUID-bearing plan ID as that bearer capability;
  // newer callers can use a separate receipt_token without repository secrets.
  const receiptToken = params.get("receipt_token")?.trim() || planId;
  const receipt = getLockedTargetReceipt(planId, receiptToken);
  if (!receipt) return errorResponse(HTTP_STATUS.NOT_FOUND, "Locked target receipt not found");
  return NextResponse.json(receipt, { headers: { "Cache-Control": "no-store" } });
}
