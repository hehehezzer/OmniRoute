import { createHash } from "node:crypto";
import { loadLockedTargetReceipt, saveLockedTargetReceipt } from "@/lib/db/lockedTargetReceipts";
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
  "GATEWAY_RESOURCE_PRESSURE",
  "TRANSPORT_FAILURE",
] as const;
export type LockedTargetFailure = (typeof LOCKED_TARGET_FAILURES)[number];
export type LockedRoutingTarget = {
  provider: string;
  account: string;
  model: string;
  route: string;
};
export type LockedRoutingRequest = {
  planId: string | null;
  receiptToken: string | null;
  sessionId: string | null;
  turnId: string | null;
  target: LockedRoutingTarget;
};
export type LockedExecutionTarget = LockedRoutingTarget & { connectionId: string };
export type LockedTargetReceipt = {
  plan_id: string;
  session_id: string | null;
  turn_id: string | null;
  success: boolean;
  selected_target: LockedRoutingTarget;
  routing_mode: OmniRouteRoutingMode;
  targetHonored: boolean;
  actual_provider: string | null;
  actual_account: string | null;
  actual_model: string | null;
  actual_route: string | null;
  connection_id: string | null;
  failure: { type: LockedTargetFailure; retryable: boolean; retry_after_ms: number | null } | null;
  usage: {
    input_tokens: number | null;
    cached_input_tokens: number | null;
    uncached_input_tokens: number | null;
    output_tokens: number | null;
    cache_metric_provenance: "provider_response" | null;
  } | null;
  received_at: string;
};
type RoutingBody = Record<string, unknown> & { routing?: Record<string, unknown> };
const requiredString = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null;

export const OMNIROUTE_ROUTING_MODE_ENV = "OMNIROUTE_ROUTING_MODE";
export const OMNIROUTE_ROUTING_MODES = ["passthrough", "legacy"] as const;
export type OmniRouteRoutingMode = (typeof OMNIROUTE_ROUTING_MODES)[number];

export function getLockedRoutingCapabilities() {
  const routingMode = resolveOmniRouteRoutingMode();
  return {
    routing_mode: routingMode,
    locked_target_supported: true,
    receipt_supported: true,
    target_rerouting: routingMode !== "passthrough",
  };
}

/**
 * The gateway defaults to the Quattro-authoritative path. Legacy routing is
 * still available for older clients, but a locked Quattro request is rejected
 * rather than silently being routed by the legacy engine.
 */
export function resolveOmniRouteRoutingMode(
  value: unknown = process.env[OMNIROUTE_ROUTING_MODE_ENV]
): OmniRouteRoutingMode | null {
  const mode =
    typeof value === "string" && value.trim() ? value.trim().toLowerCase() : "passthrough";
  return (OMNIROUTE_ROUTING_MODES as readonly string[]).includes(mode)
    ? (mode as OmniRouteRoutingMode)
    : null;
}

const receiptTokenHash = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** A legacy Quattro plan ID is accepted as a bearer capability only when it
 * contains a request-unique UUID. New clients may send a separate receiptToken.
 */
export function resolveReceiptCapability(planId: string | null, token: unknown): string | null {
  const explicit = requiredString(token);
  if (explicit && explicit.length >= 32) return explicit;
  if (
    planId &&
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(planId)
  )
    return planId;
  return null;
}

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
  if (resolveOmniRouteRoutingMode() !== "passthrough")
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
  const planId = requiredString(routing.planId) ?? requiredString(routing.plan_id);
  return {
    body: providerBody,
    locked: {
      planId,
      receiptToken: resolveReceiptCapability(planId, routing.receiptToken ?? routing.receipt_token),
      sessionId: requiredString(routing.sessionId) ?? requiredString(routing.session_id),
      turnId: requiredString(routing.turnId) ?? requiredString(routing.turn_id),
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
  if (/resource_pressure|gateway_resource_pressure|resource pressure/.test(value))
    return "GATEWAY_RESOURCE_PRESSURE";
  if (status === 401 || /authentication failed|invalid.*(?:token|credential)/.test(value))
    return "AUTHENTICATION_FAILED";
  if (/credit|billing|insufficient balance/.test(value)) return "CREDITS_EXHAUSTED";
  if (/quota|usage limit|resource_exhausted/.test(value)) return "QUOTA_EXHAUSTED";
  if (status === 429) return "RATE_LIMITED";
  if (/context|token limit|too many tokens|prompt is too long/.test(value)) return "CONTEXT_LIMIT";
  if (/unsupported|capability|does not support|fidelity violation|locked target/.test(value))
    return "CAPABILITY_UNSUPPORTED";
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
  actual: LockedExecutionTarget | null = null,
  requested: LockedRoutingTarget | null = null
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (actual) addEvidence(headers, actual);
  const identity = actual ?? requested;
  return new Response(
    JSON.stringify({
      error: {
        type,
        code: type,
        retryable,
        retry_after_ms: retryAfter,
        message: "Locked target could not execute",
        provider: identity?.provider ?? null,
        account: identity?.account ?? null,
        model: identity?.model ?? null,
        route: identity?.route ?? null,
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
    [
      "RATE_LIMITED",
      "GATEWAY_RESOURCE_PRESSURE",
      "TRANSPORT_FAILURE",
      "PROVIDER_UNAVAILABLE",
    ].includes(type),
    retryAfterMs(response.headers.get("retry-after")),
    response.status,
    actual
  );
}

export function normalizeLockedException(
  error: unknown,
  actual: LockedExecutionTarget | null = null,
  requested: LockedRoutingTarget | null = null
): Response {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  const statusCandidate = record.status ?? record.statusCode;
  const status =
    typeof statusCandidate === "number" && Number.isInteger(statusCandidate)
      ? statusCandidate
      : 503;
  const message = error instanceof Error ? error.message : String(error ?? "");
  const type = classifyLockedFailure(status, message);
  const headers = record.headers instanceof Headers ? record.headers : null;
  return lockedFailureResponse(
    type,
    [
      "RATE_LIMITED",
      "GATEWAY_RESOURCE_PRESSURE",
      "TRANSPORT_FAILURE",
      "PROVIDER_UNAVAILABLE",
    ].includes(type),
    retryAfterMs(headers?.get("retry-after") ?? null),
    status >= 400 && status <= 599 ? status : 503,
    actual,
    requested
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
  if (!request.planId || !request.receiptToken) return;
  let failure: LockedTargetReceipt["failure"] = null;
  if (!response.ok) {
    try {
      const payload = await response.clone().json();
      const error = payload?.error;
      if (error && LOCKED_TARGET_FAILURES.includes(error.type)) {
        failure = {
          type: error.type,
          retryable: error.retryable === true,
          retry_after_ms: typeof error.retry_after_ms === "number" ? error.retry_after_ms : null,
        };
      }
    } catch {}
  }
  const usage = await extractReceiptUsage(response);
  const targetHonored = Boolean(
    actual &&
    actual.provider === request.target.provider &&
    actual.account === request.target.account &&
    actual.model === request.target.model &&
    actual.route === request.target.route
  );
  const receivedAt = new Date();
  const receipt: LockedTargetReceipt = {
    plan_id: request.planId,
    session_id: request.sessionId,
    turn_id: request.turnId,
    success: response.ok,
    selected_target: { ...request.target },
    routing_mode: "passthrough",
    targetHonored,
    actual_provider: actual?.provider ?? null,
    actual_account: actual?.account ?? null,
    actual_model: actual?.model ?? null,
    actual_route: actual?.route ?? null,
    connection_id: actual?.connectionId ?? null,
    failure,
    usage,
    received_at: receivedAt.toISOString(),
  };
  saveLockedTargetReceipt({
    planKey: receiptTokenHash(request.planId),
    capabilityHash: receiptTokenHash(request.receiptToken),
    receipt: JSON.stringify(receipt),
    receivedAtMs: receivedAt.getTime(),
  });
}

export function getLockedTargetReceipt(
  planId: string,
  receiptToken: string
): LockedTargetReceipt | null {
  const value = loadLockedTargetReceipt(receiptTokenHash(planId), receiptTokenHash(receiptToken));
  if (!value) return null;
  try {
    return JSON.parse(value) as LockedTargetReceipt;
  } catch {
    return null;
  }
}

const optionalTokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

async function extractReceiptUsage(response: Response): Promise<LockedTargetReceipt["usage"]> {
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json")) {
    return null;
  }
  try {
    const payload = (await response.clone().json()) as Record<string, unknown>;
    const raw = payload.usage;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const usage = raw as Record<string, unknown>;
    const details = (
      usage.input_tokens_details && typeof usage.input_tokens_details === "object"
        ? usage.input_tokens_details
        : usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
          ? usage.prompt_tokens_details
          : null
    ) as Record<string, unknown> | null;
    const input = optionalTokenCount(
      usage.input_tokens ?? usage.prompt_tokens ?? usage.input ?? usage.promptTokens
    );
    const output = optionalTokenCount(
      usage.output_tokens ?? usage.completion_tokens ?? usage.output ?? usage.completionTokens
    );
    const cached = optionalTokenCount(
      details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens
    );
    if (input === null && output === null && cached === null) return null;
    return {
      input_tokens: input,
      cached_input_tokens: cached,
      uncached_input_tokens:
        input !== null && cached !== null && cached <= input ? input - cached : null,
      output_tokens: output,
      cache_metric_provenance: cached === null ? null : "provider_response",
    };
  } catch {
    return null;
  }
}
