/**
 * Auto-Combo Scoring Function
 *
 * Calculates a weighted score for each provider candidate.
 */

import type { RoutingHint } from "../manifestAdapter";
import { clamp01 } from "../../utils/number";
import { classifyTier } from "../tierResolver";
import {
  getProviderExecutionCapabilities,
  missingRequiredCapabilities,
  type ExecutionCapability,
} from "./capabilityRequirements.ts";

export interface ScoringFactors {
  quota: number;
  health: number;
  costInv: number;
  latencyInv: number;
  taskFit: number;
  stability: number;
  tierPriority: number;
  tierAffinity: number;
  specificityMatch: number;
  contextAffinity: number;
  cacheAffinity?: number;
  sessionAvailability?: number;
  resetWindowAffinity: number;
  connectionDensity: number;
  /**
   * Feedback-driven quality signal [0,1] from the routing-event quality tracker
   * (open-sse/services/routing/quality.ts). Optional so cold candidates with no
   * observed events default to neutral (0.5) and are never penalized.
   */
  quality?: number;
}

export interface ScoringWeights {
  quota: number;
  health: number;
  costInv: number;
  latencyInv: number;
  taskFit: number;
  stability: number;
  tierPriority: number;
  tierAffinity: number;
  specificityMatch: number;
  contextAffinity: number;
  cacheAffinity?: number;
  sessionAvailability?: number;
  resetWindowAffinity: number;
  connectionDensity: number;
  /** Weight for the feedback-driven quality factor (#feedback-foundation). */
  quality?: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  quota: 0.1429,
  health: 0.1605,
  costInv: 0.1429,
  latencyInv: 0.1143,
  taskFit: 0.0762,
  stability: 0.0476,
  tierPriority: 0.0476,
  tierAffinity: 0.0476,
  specificityMatch: 0.0476,
  contextAffinity: 0.0476,
  cacheAffinity: 0,
  sessionAvailability: 0.0476,
  resetWindowAffinity: 0,
  connectionDensity: 0.0476,
  // Shifted from `health` (0.1905 → 0.1605): availability stays dominant, and
  // the new quality signal (observed output quality over time) gets a real,
  // if smaller, vote. Sum remains exactly 1.0.
  quality: 0.03,
};

/** Normalize independently configured UI weights into a scoring distribution. */
export function normalizeScoringWeights(
  weights: Partial<ScoringWeights> | null | undefined
): ScoringWeights {
  if (!weights) return { ...DEFAULT_WEIGHTS };
  const entries = Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoringWeights>;
  const sanitized = Object.fromEntries(
    entries.map((key) => {
      const value = Number(weights?.[key]);
      return [key, Number.isFinite(value) && value >= 0 ? value : 0];
    })
  ) as unknown as ScoringWeights;
  const total = entries.reduce((sum, key) => sum + Number(sanitized[key] ?? 0), 0);
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  return Object.fromEntries(
    entries.map((key) => [key, Number(sanitized[key] ?? 0) / total])
  ) as unknown as ScoringWeights;
}

export interface ProviderCandidate {
  provider: string;
  model: string;
  quotaRemaining: number; // percentage 0..100
  quotaTotal: number;
  circuitBreakerState: "CLOSED" | "HALF_OPEN" | "OPEN";
  costPer1MTokens: number;
  p95LatencyMs: number;
  /** Average time-to-first-token in ms, when stream telemetry is available. */
  avgTtftMs?: number;
  /** Average end-to-end request latency in ms, when usage telemetry is available. */
  avgE2ELatencyMs?: number;
  /** Average generation throughput in output tokens/sec, when token telemetry is available. */
  avgTokensPerSecond?: number;
  latencyStdDev: number;
  errorRate: number;
  /** Optional provider/model observed failure rate. Falls back to errorRate. */
  failureRate?: number;
  /** T10: Optional account tier for priority boosting (Ultra > Pro > Free) */
  accountTier?: "ultra" | "pro" | "standard" | "free";
  /** T10: Optional quota reset interval in seconds (shorter = higher priority when same quota) */
  quotaResetIntervalSecs?: number;
  /** Score [0..1] for staying on the current session's provider/account/model path. */
  contextAffinity?: number;
  /** Score [0..1] for the account selected by the stable prompt-cache key. */
  cacheAffinity?: number;
  sessionAvailability?: number;
  /** Score [0..1] for quota reset-window preference; sooner selected reset windows score higher. */
  resetWindowAffinity?: number;
  /**
   * Feedback-driven quality score [0..1] for this provider/model from the
   * routing-event quality tracker (open-sse/services/routing). Omitted/undefined
   * candidates default to a neutral 0.5 in calculateFactors.
   */
  quality?: number;
  connectionPoolSize?: number;
  connectionId?: string;
  /**
   * Runtime availability supplied by the connection/health layer. `retry` is
   * the only non-healthy state that may remain eligible, and only when
   * retryEligible is explicitly true (for example a half-open breaker probe).
   */
  availability?:
    | "available"
    | "retry"
    | "unavailable"
    | "rate_limited"
    | "quota_exhausted"
    | "cooldown"
    | "unhealthy";
  retryEligible?: boolean;
  /** Auto-combo connection status/quota gates populated by buildAutoCandidates. */
  statusPenalty?: boolean;
  statusPenaltyReason?: string;
  quotaCutoffBlocked?: boolean;
  quotaCutoffReason?: string;
  /** Optional practical input ceiling for direct scorer consumers. */
  maxInputTokens?: number | null;
}

export interface ScoredProvider {
  provider: string;
  model: string;
  score: number;
  factors: ScoringFactors;
  connectionId?: string;
}

export interface CandidateRequirements {
  taskType: string;
  estimatedInputTokens?: number;
  /** Explicit client requirement. Unknown practical limits fail closed when set. */
  minimumContextTokens?: number;
  minTaskFitness?: number;
  /** Hard execution capability requirements derived from the request before ranking. */
  requiredCapabilities?: readonly ExecutionCapability[];
}

export interface CandidateEligibility {
  eligible: boolean;
  reason: string | null;
  taskFitness: number;
}

const DEFAULT_CAPABILITY_FLOORS: Readonly<Record<string, number>> = {
  simple: 0.45,
  default: 0.45,
  general: 0.45,
  documentation: 0.45,
  coding: 0.65,
  code: 0.65,
  analysis: 0.7,
  reasoning: 0.7,
  planning: 0.7,
  review: 0.7,
  debugging: 0.7,
};

/** Capability is a requirement floor, not a reason to pick the strongest model. */
export function capabilityFloorForTask(taskType: string): number {
  return DEFAULT_CAPABILITY_FLOORS[taskType.toLowerCase()] ?? 0.5;
}

/**
 * Hard eligibility gate shared by every auto-combo selector.
 *
 * A weighted score must never resurrect an unavailable connection. HALF_OPEN
 * remains eligible because the circuit breaker explicitly selected it for a
 * recovery probe; OPEN, cooldown, exhausted quota, terminal connection status,
 * missing OAuth session capacity, and sustained majority failure are rejected.
 */
export function evaluateCandidateEligibility(
  candidate: ProviderCandidate,
  requirements: CandidateRequirements,
  getTaskFitness: (model: string, taskType: string) => number
): CandidateEligibility {
  const taskType = requirements.taskType || "default";
  const taskFitness = clamp01(getTaskFitness(candidate.model, taskType));
  const requiredCapabilities = requirements.requiredCapabilities || [];
  const missingCapabilities = missingRequiredCapabilities(
    getProviderExecutionCapabilities(candidate.provider, candidate.model),
    requiredCapabilities
  );
  const reject = (reason: string): CandidateEligibility => ({
    eligible: false,
    reason,
    taskFitness,
  });

  if (missingCapabilities.length > 0) {
    return reject(`missing_${missingCapabilities[0]}`);
  }
  if (candidate.quotaCutoffBlocked === true) {
    return reject(candidate.quotaCutoffReason || "quota_cutoff");
  }
  if (candidate.statusPenalty === true) {
    return reject(candidate.statusPenaltyReason || "connection_unavailable");
  }
  if (candidate.circuitBreakerState === "OPEN") return reject("circuit_open");
  if (
    candidate.availability &&
    candidate.availability !== "available" &&
    !(candidate.availability === "retry" && candidate.retryEligible === true)
  ) {
    return reject(candidate.availability);
  }
  if (candidate.quotaTotal > 0 && candidate.quotaRemaining <= 0) {
    return reject("quota_exhausted");
  }
  if ((candidate.sessionAvailability ?? 1) <= 0) {
    return reject("session_unavailable");
  }
  const failureRate = clamp01(candidate.failureRate ?? candidate.errorRate);
  if (failureRate >= 0.5) return reject("recent_failures");

  const estimatedInputTokens = Number(requirements.estimatedInputTokens ?? 0);
  const minimumContextTokens = Number(requirements.minimumContextTokens ?? 0);
  if (Number.isFinite(minimumContextTokens) && minimumContextTokens > 0) {
    if (
      typeof candidate.maxInputTokens !== "number" ||
      candidate.maxInputTokens <= 0 ||
      candidate.maxInputTokens < minimumContextTokens
    ) {
      return reject("context_limit");
    }
  }
  if (
    Number.isFinite(estimatedInputTokens) &&
    estimatedInputTokens > 0 &&
    typeof candidate.maxInputTokens === "number" &&
    candidate.maxInputTokens > 0 &&
    estimatedInputTokens > candidate.maxInputTokens
  ) {
    return reject("context_window");
  }

  // A neutral fitness score means no evidence, not an incompatibility. Callers
  // that have a verified task-capability floor opt in explicitly; provider
  // execution requirements remain hard regardless of score availability.
  if (requirements.minTaskFitness !== undefined && taskFitness < requirements.minTaskFitness) {
    return reject("capability_mismatch");
  }
  return { eligible: true, reason: null, taskFitness };
}

export function filterEligibleCapableCandidates<T extends ProviderCandidate>(
  pool: T[],
  requirements: CandidateRequirements,
  getTaskFitness: (model: string, taskType: string) => number
): T[] {
  return pool.filter(
    (candidate) => evaluateCandidateEligibility(candidate, requirements, getTaskFitness).eligible
  );
}

function finiteCost(candidate: ProviderCandidate): number {
  return Number.isFinite(candidate.costPer1MTokens) && candidate.costPer1MTokens >= 0
    ? candidate.costPer1MTokens
    : Number.POSITIVE_INFINITY;
}

function finiteLatency(candidate: ProviderCandidate): number {
  return Number.isFinite(candidate.p95LatencyMs) && candidate.p95LatencyMs >= 0
    ? candidate.p95LatencyMs
    : Number.POSITIVE_INFINITY;
}

/**
 * Rank the cheapest candidate that clears the hard availability and capability
 * gates. Cost is intentionally lexicographic; latency, observed reliability,
 * and the existing weighted score only break equal-cost ties.
 */
export function rankCheapestCapable(
  pool: ProviderCandidate[],
  requirements: CandidateRequirements,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  getTaskFitness: (model: string, taskType: string) => number = () => 0.5,
  manifestHint?: RoutingHint | null
): ScoredProvider[] {
  const eligible = filterEligibleCapableCandidates(pool, requirements, getTaskFitness);
  if (eligible.length === 0) return [];
  const maxima = computePoolMaxima(eligible);
  return eligible
    .map((candidate, index) => {
      const factors = calculateFactors(
        candidate,
        eligible,
        requirements.taskType,
        getTaskFitness,
        manifestHint,
        maxima
      );
      return {
        candidate,
        index,
        scored: {
          provider: candidate.provider,
          model: candidate.model,
          score: calculateScore(factors, weights),
          factors,
          connectionId: candidate.connectionId,
        } satisfies ScoredProvider,
      };
    })
    .sort((left, right) => {
      const cost = finiteCost(left.candidate) - finiteCost(right.candidate);
      if (cost !== 0) return cost;
      const latency = finiteLatency(left.candidate) - finiteLatency(right.candidate);
      if (latency !== 0) return latency;
      const reliability =
        clamp01(left.candidate.failureRate ?? left.candidate.errorRate) -
        clamp01(right.candidate.failureRate ?? right.candidate.errorRate);
      if (reliability !== 0) return reliability;
      if (right.scored.score !== left.scored.score) return right.scored.score - left.scored.score;
      return left.index - right.index;
    })
    .map((entry) => entry.scored);
}

/**
 * Calculate weighted score from factors.
 * Supports tierAffinity + specificityMatch weights when manifest routing is enabled.
 */
export function calculateScore(factors: ScoringFactors, weights: ScoringWeights): number {
  // clamp01 bounds the result to [0,1] and maps a non-finite sum (a NaN factor)
  // to 0, so a single bad input can't yield NaN (which sorts nondeterministically)
  // or a score >1 from float drift in weights that nominally sum to 1.
  return clamp01(
    weights.quota * factors.quota +
      weights.health * factors.health +
      weights.costInv * factors.costInv +
      weights.latencyInv * factors.latencyInv +
      weights.taskFit * factors.taskFit +
      weights.stability * factors.stability +
      weights.tierPriority * factors.tierPriority +
      (weights.tierAffinity ?? 0) * factors.tierAffinity +
      (weights.specificityMatch ?? 0) * factors.specificityMatch +
      (weights.contextAffinity ?? 0) * factors.contextAffinity +
      (weights.cacheAffinity ?? 0) * (factors.cacheAffinity ?? 0) +
      (weights.sessionAvailability ?? 0) * (factors.sessionAvailability ?? 1) +
      (weights.resetWindowAffinity ?? 0) * factors.resetWindowAffinity +
      (weights.connectionDensity ?? 0) * factors.connectionDensity +
      // Missing quality factor → neutral 0.5: a cold candidate is neither boosted
      // (which would let optimistic initialization dominate) nor penalized.
      (weights.quality ?? 0) * (factors.quality ?? 0.5)
  );
}

/**
 * T10: Convert account tier string to a normalized score [0..1].
 */
export function calculateTierScore(
  tier: string | undefined,
  quotaResetIntervalSecs: number | undefined
): number {
  const BASE_TIER_SCORES: Record<string, number> = {
    ultra: 1.0,
    pro: 0.67,
    standard: 0.33,
    free: 0.0,
  };
  const baseScore = BASE_TIER_SCORES[tier?.toLowerCase() ?? ""] ?? 0.33;

  const resetBonus =
    quotaResetIntervalSecs != null && quotaResetIntervalSecs > 0
      ? Math.max(0, 1 - quotaResetIntervalSecs / 2_592_000)
      : 0;

  return Math.min(1, baseScore * 0.8 + resetBonus * 0.2);
}

function calculateTierAffinity(
  candidate: ProviderCandidate,
  hint: RoutingHint | undefined | null
): number {
  if (!hint) return 0.5;
  try {
    const assignment = classifyTier(candidate.provider, candidate.model);
    const tierOrder = ["free", "cheap", "premium"];
    const providerTierIdx = tierOrder.indexOf(assignment.tier);
    const minTierIdx = tierOrder.indexOf(hint.recommendedMinTier);

    if (providerTierIdx === minTierIdx) return 1.0;
    if (Math.abs(providerTierIdx - minTierIdx) === 1) return 0.7;
    return 0.3;
  } catch {
    return 0.5;
  }
}

function calculateSpecificityMatch(
  candidate: ProviderCandidate,
  hint: RoutingHint | undefined | null
): number {
  if (!hint) return 0.5;
  try {
    const assignment = classifyTier(candidate.provider, candidate.model);
    const specificityScore = hint.specificity.score;

    if (assignment.tier === "free") return specificityScore <= 15 ? 0.9 : 0.2;
    if (assignment.tier === "cheap")
      return specificityScore > 15 && specificityScore <= 50 ? 0.9 : 0.4;
    if (assignment.tier === "premium") return specificityScore > 50 ? 0.9 : 0.3;
    return 0.5;
  } catch {
    return 0.5;
  }
}

/**
 * Pool-wide maxima used to normalize cost/latency/stability factors. These are
 * identical for every candidate in a given pool, so callers scoring many
 * candidates against the same pool should compute this ONCE via
 * computePoolMaxima() and pass it to calculateFactors — recomputing it inside
 * a per-candidate loop turns an O(n) scoring pass into O(n^2) (#OOM incident:
 * a zero-config "auto" combo with no explicit candidatePool can expand the
 * pool to 1000s of provider/model targets, at which point the repeated
 * `pool.map()` + spread here dominates heap churn and can OOM the process).
 */
export interface PoolMaxima {
  maxCost: number;
  maxLatency: number;
  maxStdDev: number;
}

export function computePoolMaxima(pool: ProviderCandidate[]): PoolMaxima {
  let maxCost = 0.001;
  let maxLatency = 1;
  let maxStdDev = 0.001;
  for (const p of pool) {
    if (p.costPer1MTokens > maxCost) maxCost = p.costPer1MTokens;
    if (p.p95LatencyMs > maxLatency) maxLatency = p.p95LatencyMs;
    if (p.latencyStdDev > maxStdDev) maxStdDev = p.latencyStdDev;
  }
  return { maxCost, maxLatency, maxStdDev };
}

export function calculateFactors(
  candidate: ProviderCandidate,
  pool: ProviderCandidate[],
  taskType: string,
  getTaskFitness: (model: string, taskType: string) => number,
  manifestHint?: RoutingHint | null,
  precomputedMaxima?: PoolMaxima
): ScoringFactors {
  const { maxCost, maxLatency, maxStdDev } = precomputedMaxima ?? computePoolMaxima(pool);

  // Every factor is contractually [0,1]. clamp01 guards against bad telemetry
  // (negative quota / cost / latency, NaN, out-of-range candidate-supplied
  // affinities) so a single bad input can't produce a negative or >1 factor
  // that distorts the weighted score.
  return {
    quota: clamp01(candidate.quotaRemaining / 100),
    health:
      candidate.circuitBreakerState === "CLOSED"
        ? 1.0
        : candidate.circuitBreakerState === "HALF_OPEN"
          ? 0.5
          : 0.0,
    costInv: clamp01(1 - candidate.costPer1MTokens / maxCost),
    latencyInv: clamp01(1 - candidate.p95LatencyMs / maxLatency),
    taskFit: clamp01(getTaskFitness(candidate.model, taskType)),
    stability: clamp01(1 - candidate.latencyStdDev / maxStdDev),
    tierPriority: calculateTierScore(candidate.accountTier, candidate.quotaResetIntervalSecs),
    tierAffinity: calculateTierAffinity(candidate, manifestHint),
    specificityMatch: calculateSpecificityMatch(candidate, manifestHint),
    contextAffinity: clamp01(candidate.contextAffinity ?? 0.5),
    cacheAffinity: clamp01(candidate.cacheAffinity ?? 0),
    sessionAvailability: clamp01(candidate.sessionAvailability ?? 1),
    resetWindowAffinity: clamp01(candidate.resetWindowAffinity ?? 0.5),
    connectionDensity: clamp01(((candidate.connectionPoolSize ?? 1) - 1) / 10),
    // Feedback quality signal; neutral 0.5 when the tracker has no data yet
    // (cold providers are neither boosted nor unfairly penalized).
    quality: clamp01(candidate.quality ?? 0.5),
  };
}

export function scorePool(
  pool: ProviderCandidate[],
  taskType: string,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
  getTaskFitness: (model: string, taskType: string) => number = () => 0.5,
  manifestHint?: RoutingHint | null
): ScoredProvider[] {
  const poolMaxima = computePoolMaxima(pool);
  return pool
    .map((candidate) => {
      const factors = calculateFactors(
        candidate,
        pool,
        taskType,
        getTaskFitness,
        manifestHint,
        poolMaxima
      );
      return {
        provider: candidate.provider,
        model: candidate.model,
        score: calculateScore(factors, weights),
        factors,
        connectionId: candidate.connectionId,
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Validate that weights sum to 1.0 (±0.01 tolerance).
 */
export function validateWeights(weights: ScoringWeights): boolean {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  return Math.abs(sum - 1.0) < 0.01;
}
