import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateCandidateEligibility,
  rankCheapestCapable,
  type ProviderCandidate,
} from "../../../open-sse/services/autoCombo/scoring.ts";

function candidate(
  provider: string,
  cost: number,
  overrides: Partial<ProviderCandidate> = {}
): ProviderCandidate {
  return {
    provider,
    model: `${provider}-model`,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens: cost,
    p95LatencyMs: 500,
    latencyStdDev: 25,
    errorRate: 0.01,
    sessionAvailability: 1,
    ...overrides,
  };
}

const fitness = (model: string): number => {
  if (model.includes("incapable")) return 0.4;
  if (model.includes("reasoning")) return 0.85;
  return 0.75;
};

test("cheapest capable candidate wins over a stronger expensive candidate", () => {
  const ranked = rankCheapestCapable(
    [
      candidate("cheap", 1, { model: "cheap-capable" }),
      candidate("premium", 20, { model: "premium-reasoning" }),
    ],
    { taskType: "coding" },
    undefined,
    fitness
  );

  assert.equal(ranked[0]?.provider, "cheap");
});

test("capability floor beats price when the cheapest model is incapable", () => {
  const ranked = rankCheapestCapable(
    [
      candidate("cheap", 1, { model: "cheap-incapable" }),
      candidate("capable", 8, { model: "capable-coding" }),
    ],
    { taskType: "coding" },
    undefined,
    fitness
  );

  assert.deepEqual(ranked.map((entry) => entry.provider), ["capable"]);
});

test("rate-limited cheap candidate is removed before cost ranking", () => {
  const ranked = rankCheapestCapable(
    [
      candidate("limited", 0, {
        model: "limited-capable",
        statusPenalty: true,
        statusPenaltyReason: "rate_limited",
      }),
      candidate("healthy", 5, { model: "healthy-capable" }),
    ],
    { taskType: "coding" },
    undefined,
    fitness
  );

  assert.equal(ranked[0]?.provider, "healthy");
  assert.equal(ranked.length, 1);
});

test("large input skips a cheap small-context candidate", () => {
  const ranked = rankCheapestCapable(
    [
      candidate("small", 1, { model: "small-capable", maxInputTokens: 8_000 }),
      candidate("large", 9, { model: "large-capable", maxInputTokens: 128_000 }),
    ],
    { taskType: "coding", estimatedInputTokens: 90_000 },
    undefined,
    fitness
  );

  assert.deepEqual(ranked.map((entry) => entry.provider), ["large"]);
});

test("candidate becomes eligible again after cooldown state clears", () => {
  const cooledDown = candidate("free", 0, {
    model: "free-capable",
    statusPenalty: true,
    statusPenaltyReason: "cooldown",
  });
  assert.equal(
    evaluateCandidateEligibility(cooledDown, { taskType: "coding" }, fitness).eligible,
    false
  );

  const recovered = { ...cooledDown, statusPenalty: false, statusPenaltyReason: undefined };
  assert.equal(
    evaluateCandidateEligibility(recovered, { taskType: "coding" }, fitness).eligible,
    true
  );
});

test("open circuit is rejected while explicit half-open retry remains eligible", () => {
  const open = candidate("open", 0, {
    model: "open-capable",
    circuitBreakerState: "OPEN",
  });
  const halfOpen = candidate("retry", 1, {
    model: "retry-capable",
    circuitBreakerState: "HALF_OPEN",
    availability: "retry",
    retryEligible: true,
  });

  const ranked = rankCheapestCapable(
    [open, halfOpen],
    { taskType: "coding" },
    undefined,
    fitness
  );
  assert.deepEqual(ranked.map((entry) => entry.provider), ["retry"]);
});
