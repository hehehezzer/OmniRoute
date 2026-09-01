import assert from "node:assert/strict";
import test from "node:test";

import {
  extractRoutingPreferenceEnvelope,
  orderEligibleCandidatesByPreference,
} from "../../../open-sse/services/autoCombo/routingEnvelope.ts";
import {
  evaluateCandidateEligibility,
  filterEligibleCapableCandidates,
  type ProviderCandidate,
} from "../../../open-sse/services/autoCombo/scoring.ts";

function candidate(
  provider: string,
  model: string,
  availability: ProviderCandidate["availability"]
) {
  return {
    provider,
    model,
    availability,
    quotaRemaining: availability === "quota_exhausted" ? 0 : 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED" as const,
    costPer1MTokens: 1,
    p95LatencyMs: 100,
    latencyStdDev: 1,
    errorRate: 0,
    sessionAvailability: 1,
    maxInputTokens: 128_000,
  };
}

test("ordinary OmniRoute request remains unchanged without routing metadata", () => {
  const body = { model: "auto", messages: [{ role: "user", content: "hello" }] };
  const result = extractRoutingPreferenceEnvelope(body);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.body, body);
    assert.equal(result.envelope, null);
  }
});

test("enhanced routing envelope is validated, normalized, and stripped from provider body", () => {
  const result = extractRoutingPreferenceEnvelope({
    model: "auto",
    routing: {
      schema_version: 1,
      requirements: {
        capabilities: ["repository_access", "code_execution"],
        minimum_context: 120_000,
      },
      preferred_candidates: ["codex/gpt-5.6-luna", "codex/gpt-5.6-sol"],
      preference_mode: "balanced",
      task_profile_id: "repo-change-42",
      routing_policy_version: "2026-09-02",
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.equal("routing" in result.body, false);
    assert.deepEqual(result.envelope?.requiredCapabilities, [
      "repository_access",
      "code_execution",
    ]);
    assert.equal(result.envelope?.minimumContext, 120_000);
  }
});

test("routing envelope rejects unsupported schema and malformed candidate ids", () => {
  const badSchema = extractRoutingPreferenceEnvelope({
    routing: { schema_version: 2, requirements: {}, preferred_candidates: [] },
  });
  assert.equal(badSchema.success, false);

  const badCandidate = extractRoutingPreferenceEnvelope({
    routing: {
      schema_version: 1,
      requirements: {},
      preferred_candidates: ["not-a-route"],
    },
  });
  assert.equal(badCandidate.success, false);

  const unsupportedMode = extractRoutingPreferenceEnvelope({
    routing: {
      schema_version: 1,
      requirements: {},
      preferred_candidates: [],
      preference_mode: "quality",
    },
  });
  assert.equal(unsupportedMode.success, false);
});

test("routing envelope rejects unknown capabilities and bounded-array abuse", () => {
  const unknownCapability = extractRoutingPreferenceEnvelope({
    routing: {
      schema_version: 1,
      requirements: { capabilities: ["benchmark_magic"] },
      preferred_candidates: [],
    },
  });
  assert.equal(unknownCapability.success, false);

  const tooManyCandidates = extractRoutingPreferenceEnvelope({
    routing: {
      schema_version: 1,
      requirements: {},
      preferred_candidates: Array.from({ length: 33 }, (_, index) => `p/model-${index}`),
    },
  });
  assert.equal(tooManyCandidates.success, false);
});

test("preferred candidates reorder only the already eligible pool", () => {
  const eligible = [
    { provider: "codex", model: "sol" },
    { provider: "codex", model: "luna" },
  ];
  assert.deepEqual(orderEligibleCandidatesByPreference(eligible, ["missing/model", "codex/luna"]), [
    eligible[1],
    eligible[0],
  ]);
});

test("quota-exhausted preference is skipped before preference ordering", () => {
  const luna = candidate("codex", "luna", "quota_exhausted");
  const deepseek = candidate("deepseek", "v4", "available");
  const sol = candidate("codex", "sol", "available");
  const eligible = filterEligibleCapableCandidates(
    [luna, deepseek, sol],
    { taskType: "default" },
    () => 0.9
  );
  const ordered = orderEligibleCandidatesByPreference(eligible, [
    "codex/luna",
    "deepseek/v4",
    "codex/sol",
  ]);
  assert.deepEqual(
    ordered.map((entry) => `${entry.provider}/${entry.model}`),
    ["deepseek/v4", "codex/sol"]
  );
});

test("explicit practical context requirement fails closed for unknown or small limits", () => {
  const unknown = { ...candidate("codex", "unknown", "available"), maxInputTokens: null };
  const small = { ...candidate("codex", "small", "available"), maxInputTokens: 64_000 };
  const enough = candidate("codex", "enough", "available");
  const requirements = { taskType: "default", minimumContextTokens: 120_000 };
  assert.equal(
    evaluateCandidateEligibility(unknown, requirements, () => 0.9).reason,
    "context_limit"
  );
  assert.equal(
    evaluateCandidateEligibility(small, requirements, () => 0.9).reason,
    "context_limit"
  );
  assert.equal(evaluateCandidateEligibility(enough, requirements, () => 0.9).eligible, true);
});
