// tests/unit/combo/auto-status-penalty-4540.test.ts
// Regression for #4540: an exhausted provider connection (e.g. credits_exhausted /
// rate_limited with no numeric quota fetcher) used to score IDENTICALLY to a healthy
// one — quotaRemaining defaulted to 100 and testStatus never entered scoring — so auto
// routing kept picking dead providers. A score penalty is not enough: a connection
// explicitly marked unavailable must be excluded before ranking even when the optional
// quota-percentage cutoff is disabled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAutoTargets } from "../../../open-sse/services/combo/autoStrategy.ts";
import type {
  AutoProviderCandidate,
  ResolvedComboTarget,
} from "../../../open-sse/services/combo/types.ts";
import type { ScoringWeights } from "../../../open-sse/services/autoCombo/scoring.ts";

// Quota-weighted only so the two candidates would otherwise tie at quotaRemaining=100.
const quotaOnlyWeights: ScoringWeights = {
  quota: 1,
  health: 0,
  costInv: 0,
  latencyInv: 0,
  taskFit: 0,
  stability: 0,
  tierPriority: 0,
  tierAffinity: 0,
  specificityMatch: 0,
  contextAffinity: 0,
  resetWindowAffinity: 0,
  connectionDensity: 0,
};

function target(provider: string, model: string, connectionId: string): ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `${provider}-${model}-${connectionId}`,
    executionKey: `${provider}/${model}@${connectionId}`,
    modelStr: `${provider}/${model}`,
    provider,
    providerId: null,
    connectionId,
  } as ResolvedComboTarget;
}

function candidate(
  provider: string,
  model: string,
  connectionId: string,
  overrides: Partial<AutoProviderCandidate> = {}
): AutoProviderCandidate {
  return {
    provider,
    model,
    stepId: `${provider}-${model}-${connectionId}`,
    executionKey: `${provider}/${model}@${connectionId}`,
    modelStr: `${provider}/${model}`,
    connectionId,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: 1,
    p95LatencyMs: 1000,
    latencyStdDev: 10,
    errorRate: 0,
    resetWindowAffinity: 0.5,
    connectionPoolSize: 1,
    ...overrides,
  } as AutoProviderCandidate;
}

test("#4540: exhausted (statusPenalty) candidate is ineligible before ranking", () => {
  const targets = [target("dead", "m", "dead-conn"), target("healthy", "m", "healthy-conn")];
  const ranked = scoreAutoTargets(
    targets,
    [
      // Exhausted connection with no numeric quota fetcher: quotaRemaining stays 100,
      // but the connection terminal status is still a hard availability signal.
      candidate("dead", "m", "dead-conn", { statusPenalty: true }),
      candidate("healthy", "m", "healthy-conn"),
    ],
    "default",
    quotaOnlyWeights
  );

  assert.equal(ranked.length, 1, "unavailable candidates must not survive hard filtering");
  assert.equal(ranked[0]?.target.provider, "healthy");
});
