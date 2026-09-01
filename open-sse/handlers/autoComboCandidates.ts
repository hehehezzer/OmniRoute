/**
 * #7819 (Level 1) — read-only candidate pool + reachability listing for an
 * `auto/*` channel.
 *
 * Builds the SAME candidate pool `virtualFactory.createVirtualAutoCombo` uses
 * for routing (via `createBuiltinAutoCombo`, unfiltered by any per-key
 * exclusion so the operator can see — and toggle — excluded candidates), then
 * decorates each candidate with live reachability derived from the existing
 * resilience reads (CLAUDE.md "Resilience Runtime State"):
 *   - provider circuit breaker: `getCircuitBreaker(provider).getStatus()` /
 *     `.canExecute()` — NEVER raw `state`, so an expired breaker (lazy
 *     recovery) doesn't show as permanently open.
 *   - connection cooldown: `rateLimitedUntil` / `testStatus` on the resolved
 *     provider_connections row (no-auth synthetic connections have no row —
 *     treated as always reachable on this axis).
 *   - model lockout: `isModelLocked(provider, connectionId, model)`.
 */
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
import { getCircuitBreaker } from "@/shared/utils/circuitBreaker";
import { isModelLocked } from "@omniroute/open-sse/services/accountFallback.ts";
import { getProviderConnectionById } from "@/lib/db/providers";
import { getExcludedConnectionIds } from "@/lib/db/autoCandidateOverrides";
import { getCanonicalModelMetadata } from "@/lib/modelMetadataRegistry";
import { getPricingForModel } from "@/shared/constants/pricing";
import { getProviderExecutionCapabilities } from "@omniroute/open-sse/services/autoCombo/capabilityRequirements.ts";

export const CANDIDATE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_METADATA_VERSION = "quattro-routing-metadata-1";
const MAX_CANDIDATE_ACCOUNT_PAIRS = 512;
const CANDIDATE_DECORATION_CONCURRENCY = 16;

export interface AutoComboCandidateView {
  provider: string;
  connectionId: string;
  model: string;
  modelStr: string;
  excluded: boolean;
  reachable: boolean;
  breakerState: string;
  connectionCooldown: boolean;
  modelLocked: boolean;
}

export interface AutoComboCandidatesResult {
  channel: string;
  candidates: AutoComboCandidateView[];
}

type PricingState = "known" | "free" | "unknown" | "not_applicable";

export interface SanitizedCandidateView {
  provider_id: string;
  model_id: string;
  route: string;
  capabilities: {
    reasoning: boolean;
    vision: boolean | null;
    tools: boolean;
    execution: ReturnType<typeof getProviderExecutionCapabilities>;
  };
  practical_context_limit: number | null;
  modalities: { input: string[]; output: string[] };
  tool_support: boolean;
  execution_support: boolean;
  pricing: {
    state: PricingState;
    input_cost: number | null;
    output_cost: number | null;
    cached_input_cost: number | null;
    currency: "USD";
    unit: "million_tokens";
  };
  health_state: "available" | "cooldown" | "unhealthy";
  quota_state: "available" | "unavailable" | "unknown";
  cooldown_state: boolean;
  latency_class: "unknown";
  rejection_reasons: string[];
}

export interface SanitizedCandidateSnapshot {
  schema_version: typeof CANDIDATE_SNAPSHOT_SCHEMA_VERSION;
  generated_at: string;
  metadata_version: string;
  channel: string;
  candidates: SanitizedCandidateView[];
}

export interface CandidateVisibilityPolicy {
  /** Empty/null preserves OmniRoute's allow-all connection semantics. */
  allowedConnectionIds?: readonly string[] | null;
  isModelAllowed?: (model: string) => Promise<boolean>;
}

function hasFutureRateLimit(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  const time = new Date(String(value)).getTime();
  return Number.isFinite(time) && time > Date.now();
}

async function decorateCandidate(candidate: {
  provider: string;
  connectionId: string;
  model: string;
  modelStr: string;
}): Promise<AutoComboCandidateView> {
  const breaker = getCircuitBreaker(candidate.provider);
  const breakerStatus = breaker.getStatus();
  const breakerReachable = breaker.canExecute();

  let connectionCooldown = false;
  if (candidate.connectionId && candidate.connectionId !== "noauth") {
    try {
      const connection = await getProviderConnectionById(candidate.connectionId);
      connectionCooldown =
        hasFutureRateLimit((connection as Record<string, unknown> | null)?.rateLimitedUntil) ||
        (connection as Record<string, unknown> | null)?.testStatus === "unavailable";
    } catch {
      // Fail-open: an unresolved connection lookup should not mark a
      // candidate unreachable — the panel is read-only transparency, not the
      // dispatch path.
      connectionCooldown = false;
    }
  }

  const modelLocked = isModelLocked(candidate.provider, candidate.connectionId, candidate.model);

  return {
    provider: candidate.provider,
    connectionId: candidate.connectionId,
    model: candidate.model,
    modelStr: candidate.modelStr,
    excluded: false,
    reachable: breakerReachable && !connectionCooldown && !modelLocked,
    breakerState: String(breakerStatus.state),
    connectionCooldown,
    modelLocked,
  };
}

/**
 * Builds the candidate pool for `channel` (the suffix after "auto/", or the
 * literal "auto" for the base channel) and decorates it with reachability +
 * this API key's exclusion state. Read-only — never mutates routing state.
 */
export async function getAutoComboCandidates(
  channel: string,
  apiKeyId: string | null,
  visibility: CandidateVisibilityPolicy = {}
): Promise<AutoComboCandidatesResult> {
  const modelStr = channel === "auto" ? "auto" : `auto/${channel}`;

  // The bare "auto" channel (no variant/spec overlay) is handled directly by
  // virtualFactory — createBuiltinAutoCombo() only recognizes `auto/<suffix>`
  // ids (matches classifyAutoModel()'s special-casing of the literal "auto"
  // model string in src/sse/handlers/autoRouting.ts).
  let virtualCombo;
  if (channel === "auto") {
    const { createVirtualAutoCombo } =
      await import("@omniroute/open-sse/services/autoCombo/virtualFactory.ts");
    virtualCombo = await createVirtualAutoCombo(undefined);
  } else {
    const { createBuiltinAutoCombo } =
      await import("@omniroute/open-sse/services/autoCombo/builtinCatalog.ts");
    virtualCombo = await createBuiltinAutoCombo(modelStr, channel);
  }

  const excludedConnectionIds = apiKeyId
    ? await getExcludedConnectionIds(apiKeyId, modelStr).catch(() => new Set<string>())
    : new Set<string>();

  const models: Array<{
    providerId: string;
    connectionId: string | null;
    allowedConnectionIds?: string[];
    model: string;
  }> = Array.isArray(virtualCombo?.models) ? virtualCombo.models : [];
  // Routing keeps one logical provider/model candidate, but the management API
  // remains account-oriented so operators can inspect and toggle each fallback.
  let accountCandidates = models.flatMap((candidate) => {
    if (candidate.connectionId) return [{ ...candidate, connectionId: candidate.connectionId }];
    return (candidate.allowedConnectionIds ?? []).map((connectionId) => ({
      ...candidate,
      connectionId,
    }));
  });

  if (visibility.allowedConnectionIds?.length) {
    const allowed = new Set(visibility.allowedConnectionIds);
    accountCandidates = accountCandidates.filter((candidate) =>
      allowed.has(candidate.connectionId)
    );
  }

  if (accountCandidates.length > MAX_CANDIDATE_ACCOUNT_PAIRS) {
    throw new Error("Candidate snapshot exceeds the configured safe size");
  }

  if (visibility.isModelAllowed) {
    const checks: boolean[] = [];
    for (
      let offset = 0;
      offset < accountCandidates.length;
      offset += CANDIDATE_DECORATION_CONCURRENCY
    ) {
      const batch = accountCandidates.slice(offset, offset + CANDIDATE_DECORATION_CONCURRENCY);
      checks.push(
        ...(
          await Promise.all(
            batch.map((candidate) =>
              visibility.isModelAllowed?.(`${candidate.providerId}/${candidate.model}`)
            )
          )
        ).then((values) => values.map((value) => value === true))
      );
    }
    accountCandidates = accountCandidates.filter((_candidate, index) => checks[index] === true);
  }

  const candidates: AutoComboCandidateView[] = [];
  for (
    let offset = 0;
    offset < accountCandidates.length;
    offset += CANDIDATE_DECORATION_CONCURRENCY
  ) {
    const batch = accountCandidates.slice(offset, offset + CANDIDATE_DECORATION_CONCURRENCY);
    candidates.push(
      ...(await Promise.all(
        batch.map(async (candidate) => {
          const decorated = await decorateCandidate({
            provider: candidate.providerId,
            connectionId: candidate.connectionId,
            model: candidate.model,
            modelStr: candidate.model,
          });
          return { ...decorated, excluded: excludedConnectionIds.has(candidate.connectionId) };
        })
      ))
    );
  }

  return { channel: modelStr, candidates };
}

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function sanitizedPricing(provider: string, model: string): SanitizedCandidateView["pricing"] {
  const raw = getPricingForModel(provider, model);
  const input = finitePrice(raw?.input);
  const output = finitePrice(raw?.output);
  const cached = finitePrice(raw?.cached ?? raw?.cached_input);
  const state: PricingState =
    input === null && output === null ? "unknown" : input === 0 && output === 0 ? "free" : "known";
  return {
    state,
    input_cost: input,
    output_cost: output,
    cached_input_cost: cached,
    currency: "USD",
    unit: "million_tokens",
  };
}

function rejectionReasons(candidate: AutoComboCandidateView): string[] {
  const reasons: string[] = [];
  if (candidate.breakerState === "OPEN") reasons.push("unhealthy");
  if (candidate.connectionCooldown) reasons.push("cooldown");
  if (candidate.modelLocked) reasons.push("rate_limited");
  if (candidate.excluded) reasons.push("manual_policy_rejection");
  return reasons;
}

/**
 * Public inference-facing candidate projection. Account/connection identifiers,
 * timestamps, provider errors, credentials, and raw configuration never cross
 * this boundary.
 */
export async function getSanitizedAutoComboCandidateSnapshot(
  channel: string,
  apiKeyId: string | null,
  visibility: CandidateVisibilityPolicy = {}
): Promise<SanitizedCandidateSnapshot> {
  const raw = await getAutoComboCandidates(channel, apiKeyId, visibility);
  const grouped = new Map<string, AutoComboCandidateView[]>();
  for (const candidate of raw.candidates) {
    const key = `${candidate.provider}\0${candidate.model}`;
    const entries = grouped.get(key) ?? [];
    entries.push(candidate);
    grouped.set(key, entries);
  }

  const candidates = [...grouped.values()]
    .filter((entries) => isPublicCandidateIdentifier(entries[0].provider, entries[0].model))
    .map((entries): SanitizedCandidateView => {
      const first = entries[0];
      const metadata = getCanonicalModelMetadata({ provider: first.provider, model: first.model });
      const execution = getProviderExecutionCapabilities(first.provider, first.model);
      const anyAvailable = entries.some((entry) => entry.reachable && !entry.excluded);
      const anyCooldown = entries.some((entry) => entry.connectionCooldown || entry.modelLocked);
      const reasons = [...new Set(entries.flatMap(rejectionReasons))];
      const executionSupport =
        execution.filesystem ||
        execution.shell ||
        execution.git ||
        execution.codeEditing ||
        execution.codeExecution ||
        execution.repositoryAccess;
      return {
        provider_id: first.provider,
        model_id: first.model,
        route: `${first.provider}/${first.model}`,
        capabilities: {
          reasoning: metadata?.capabilities.reasoning ?? execution.reasoning,
          vision: metadata?.capabilities.vision ?? null,
          tools: metadata?.capabilities.toolCalling ?? false,
          execution,
        },
        practical_context_limit:
          metadata?.limits.maxInputTokens ?? metadata?.limits.contextWindow ?? null,
        modalities: {
          input: metadata?.modalities.input ?? ["text"],
          output: metadata?.modalities.output ?? ["text"],
        },
        tool_support: metadata?.capabilities.toolCalling ?? false,
        execution_support: executionSupport,
        pricing: sanitizedPricing(first.provider, first.model),
        health_state: anyAvailable ? "available" : anyCooldown ? "cooldown" : "unhealthy",
        quota_state: anyAvailable ? "available" : anyCooldown ? "unavailable" : "unknown",
        cooldown_state: anyCooldown,
        latency_class: "unknown",
        rejection_reasons: anyAvailable ? [] : reasons,
      };
    });

  return {
    schema_version: CANDIDATE_SNAPSHOT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    metadata_version: CANDIDATE_METADATA_VERSION,
    channel: raw.channel,
    candidates,
  };
}

export function isPublicCandidateIdentifier(provider: string, model: string): boolean {
  return (
    provider.length <= 64 &&
    model.length <= 128 &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(provider) &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)
  );
}

/** Thrown by `getAutoComboCandidates` (via `createBuiltinAutoCombo`) when the
 * channel is not a recognized built-in `auto/*` id — mapped to a 404 by the
 * route handler. */
export function isUnknownAutoChannelError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith("Unknown built-in auto combo");
}

export function buildCandidatesErrorBody(statusCode: number, message: string) {
  return buildErrorBody(statusCode, message);
}
