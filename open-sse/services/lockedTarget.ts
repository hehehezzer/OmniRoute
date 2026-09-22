import { parseModel } from "./model.ts";
import type { ComboCollectionLike, ComboLike, ResolvedComboTarget } from "./combo/types.ts";
import { resolveComboTargets } from "./combo/comboStructure.ts";

export const LOCKED_TARGET_FAILURES = [
  "RATE_LIMITED",
  "QUOTA_EXHAUSTED",
  "CREDITS_EXHAUSTED",
  "MODEL_UNAVAILABLE",
  "ACCOUNT_UNAVAILABLE",
  "PROVIDER_UNAVAILABLE",
  "AUTHENTICATION_FAILED",
  "CONTEXT_LIMIT",
  "CAPABILITY_UNSUPPORTED",
  "TRANSPORT_FAILURE",
] as const;
export type LockedTargetFailure = (typeof LOCKED_TARGET_FAILURES)[number];
export type LockedRoutingTarget = {
  provider: string;
  account: string;
  model: string;
  route: string;
};
export type LockedRoutingRequest = { planId: string | null; target: LockedRoutingTarget };
export type LockedExecutionTarget = LockedRoutingTarget & { connectionId: string };
export type LockedTargetReceipt = {
  plan_id: string;
  success: boolean;
  actual_provider: string | null;
  actual_account: string | null;
  actual_model: string | null;
  actual_route: string | null;
  connection_id: string | null;
  failure: { type: LockedTargetFailure; retryable: boolean; retry_after_ms: number | null } | null;
  received_at: string;
};
const lockedReceipts: LockedTargetReceipt[] = [];
type RoutingBody = Record<string, unknown> & { routing?: Record<string, unknown> };
const requiredString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

function parseRoutingHeader(headers?: Headers | null): Record<string, unknown> | null {
  const value = headers?.get("x-quattro-routing")?.trim();
  if (!value || value.length > 12_000) return null;
  const candidates = [value];
  try {
    candidates.push(Buffer.from(value, "base64url").toString("utf8"));
  } catch {}
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return null;
}

export function extractLockedRoutingRequest(
  body: RoutingBody,
  headers?: Headers | null
): { body: RoutingBody; locked: LockedRoutingRequest | null } | { response: Response } {
  const rawHeader = headers?.get("x-quattro-routing")?.trim();
  const headerRouting = parseRoutingHeader(headers);
  if (rawHeader && !headerRouting)
    return { response: lockedFailureResponse("CAPABILITY_UNSUPPORTED", false) };
  const routing = headerRouting ?? body.routing;
  if (!routing) return { body, locked: null };
  const passthrough = routing.preference_mode === "passthrough";
  const locked = routing.routingLocked === true || routing.routing_locked === true;
  if (!passthrough && !locked) return { body, locked: null };
  if (!passthrough || !locked)
    return { response: lockedFailureResponse("CAPABILITY_UNSUPPORTED", false) };
  const raw = routing.target;
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { response: lockedFailureResponse("CAPABILITY_UNSUPPORTED", false) };
  const value = raw as Record<string, unknown>;
  const target = {
    provider: requiredString(value.provider),
    account: requiredString(value.account),
    model: requiredString(value.model),
    route: requiredString(value.route),
  };
  if (!target.provider || !target.account || !target.model || !target.route)
    return { response: lockedFailureResponse("CAPABILITY_UNSUPPORTED", false) };
  const { routing: _routing, ...providerBody } = body;
  return {
    body: providerBody,
    locked: {
      planId: requiredString(routing.planId) ?? requiredString(routing.plan_id),
      target: target as LockedRoutingTarget,
    },
  };
}

export function resolveLockedComboTarget(
  combo: ComboLike,
  allCombos: ComboCollectionLike,
  request: LockedRoutingRequest
): ResolvedComboTarget | null {
  if (combo.name !== request.target.route) return null;
  const targets = resolveComboTargets(combo, allCombos);
  if (targets.length !== 1 || !targets[0]?.connectionId) return null;
  const target = targets[0];
  const parsed = parseModel(target.modelStr);
  if (
    (target.provider || parsed.provider) !== request.target.provider ||
    (parsed.model || target.modelStr) !== request.target.model
  )
    return null;
  return target;
}

export function resolveConnectionAccountIdentity(connection: Record<string, unknown>): string {
  const data =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? (connection.providerSpecificData as Record<string, unknown>)
      : {};
  return (
    requiredString(connection.name) ??
    requiredString(connection.email) ??
    requiredString(data.accountId) ??
    requiredString(data.chatgptAccountId) ??
    requiredString(data.workspaceId) ??
    requiredString(connection.id) ??
    "unknown"
  );
}
export function connectionMatchesLockedAccount(
  connection: Record<string, unknown>,
  expected: string
): boolean {
  const data =
    connection.providerSpecificData && typeof connection.providerSpecificData === "object"
      ? (connection.providerSpecificData as Record<string, unknown>)
      : {};
  return [
    connection.id,
    connection.name,
    connection.email,
    data.accountId,
    data.chatgptAccountId,
    data.workspaceId,
  ].some((v) => requiredString(v) === expected);
}

export function classifyLockedFailure(status: number, text: string): LockedTargetFailure {
  const value = text.toLowerCase();
  if (status === 401 || /authentication failed|invalid.*(?:token|credential)/.test(value))
    return "AUTHENTICATION_FAILED";
  if (/credit|billing|insufficient balance/.test(value)) return "CREDITS_EXHAUSTED";
  if (/quota|usage limit|resource_exhausted/.test(value)) return "QUOTA_EXHAUSTED";
  if (status === 429) return "RATE_LIMITED";
  if (/context|token limit|too many tokens|prompt is too long/.test(value)) return "CONTEXT_LIMIT";
  if (/unsupported|capability|does not support/.test(value)) return "CAPABILITY_UNSUPPORTED";
  if (status === 404 || /model.*(?:unavailable|not found)/.test(value)) return "MODEL_UNAVAILABLE";
  if (/account|credential/.test(value)) return "ACCOUNT_UNAVAILABLE";
  if (/econnreset|socket hang up|early eof|proxy_unreachable|transport/.test(value))
    return "TRANSPORT_FAILURE";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "TRANSPORT_FAILURE";
}
const retryAfterMs = (value: string | null): number | null => {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
};
function addEvidence(headers: Headers, actual: LockedExecutionTarget) {
  headers.set("X-OmniRoute-Provider", actual.provider);
  headers.set("X-OmniRoute-Account", actual.account);
  headers.set("X-OmniRoute-Model", actual.model);
  headers.set("X-OmniRoute-Route", actual.route);
  headers.set("X-OmniRoute-Selected-Connection-Id", actual.connectionId);
}
export function lockedFailureResponse(
  type: LockedTargetFailure,
  retryable: boolean,
  retryAfter: number | null = null,
  status = 503,
  actual: LockedExecutionTarget | null = null
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (actual) addEvidence(headers, actual);
  return new Response(
    JSON.stringify({
      error: {
        type,
        code: type,
        retryable,
        retry_after_ms: retryAfter,
        message: "Locked target could not execute",
      },
    }),
    { status, headers }
  );
}
export async function normalizeLockedFailure(
  response: Response,
  actual: LockedExecutionTarget | null = null
): Promise<Response> {
  if (response.ok) return response;
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  const type = classifyLockedFailure(response.status, text);
  return lockedFailureResponse(
    type,
    ["RATE_LIMITED", "TRANSPORT_FAILURE", "PROVIDER_UNAVAILABLE"].includes(type),
    retryAfterMs(response.headers.get("retry-after")),
    response.status,
    actual
  );
}
export function withLockedTargetEvidence(
  response: Response,
  actual: LockedExecutionTarget
): Response {
  const headers = new Headers(response.headers);
  addEvidence(headers, actual);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function recordLockedTargetReceipt(
  request: LockedRoutingRequest,
  response: Response,
  actual: LockedExecutionTarget | null
): Promise<void> {
  if (!request.planId) return;
  let failure: LockedTargetReceipt["failure"] = null;
  if (!response.ok) {
    try {
      const payload = await response.clone().json();
      const error = payload?.error;
      if (error && LOCKED_TARGET_FAILURES.includes(error.type)) {
        failure = {
          type: error.type,
          retryable: error.retryable === true,
          retry_after_ms:
            typeof error.retry_after_ms === "number" ? error.retry_after_ms : null,
        };
      }
    } catch {}
  }
  lockedReceipts.push({
    plan_id: request.planId,
    success: response.ok,
    actual_provider: actual?.provider ?? null,
    actual_account: actual?.account ?? null,
    actual_model: actual?.model ?? null,
    actual_route: actual?.route ?? null,
    connection_id: actual?.connectionId ?? null,
    failure,
    received_at: new Date().toISOString(),
  });
  if (lockedReceipts.length > 500) lockedReceipts.splice(0, lockedReceipts.length - 500);
}

export function getLockedTargetReceipt(planId: string): LockedTargetReceipt | null {
  for (let index = lockedReceipts.length - 1; index >= 0; index -= 1) {
    if (lockedReceipts[index]?.plan_id === planId) return { ...lockedReceipts[index]! };
  }
  return null;
}
