import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyRequestCapabilities,
  getProviderExecutionCapabilities,
  missingRequiredCapabilities,
} from "../../../open-sse/services/autoCombo/capabilityRequirements.ts";
import {
  filterEligibleCapableCandidates,
  rankCheapestCapable,
  type ProviderCandidate,
} from "../../../open-sse/services/autoCombo/scoring.ts";
import { resolveAutoStrategyOrder } from "../../../open-sse/services/combo/resolveAutoStrategy.ts";

function candidate(provider: string, model: string, costPer1MTokens: number): ProviderCandidate {
  return {
    provider,
    model,
    quotaRemaining: 100,
    quotaTotal: 100,
    circuitBreakerState: "CLOSED",
    costPer1MTokens,
    p95LatencyMs: 500,
    latencyStdDev: 25,
    errorRate: 0.01,
    sessionAvailability: 1,
  };
}

const codingFitness = (): number => 0.9;

test("repository execution rejects chatgpt-web and selects an execution-capable route", () => {
  const decision = classifyRequestCapabilities("Refactor this repository and update README");
  assert.equal(decision.requestType, "repository_execution");
  assert.deepEqual(decision.requiredCapabilities, [
    "filesystem",
    "shell",
    "git",
    "code_editing",
    "code_execution",
    "repository_access",
    "sandbox_write",
  ]);

  const requirements = {
    taskType: "coding",
    requiredCapabilities: decision.requiredCapabilities,
  };
  const web = candidate("chatgpt-web", "gpt-5.6-sol-xhigh", 0);
  const codex = candidate("codex", "gpt-5.6-sol", 4);
  const ranked = rankCheapestCapable([web, codex], requirements, undefined, codingFitness);

  assert.deepEqual(
    ranked.map((entry) => entry.provider),
    ["codex"]
  );
  assert.equal(
    missingRequiredCapabilities(
      getProviderExecutionCapabilities(web.provider, web.model),
      decision.requiredCapabilities
    )[0],
    "filesystem"
  );
});

test("unverified code-oriented providers remain fail-closed for repository execution", () => {
  const decision = classifyRequestCapabilities("Refactor this repository and update README");
  const missing = missingRequiredCapabilities(
    getProviderExecutionCapabilities("cursor", "gpt-5.3-codex"),
    decision.requiredCapabilities
  );
  assert.ok(missing.includes("filesystem"));
  assert.ok(missing.includes("sandbox_write"));
});

test("conversation permits web-only providers", () => {
  const decision = classifyRequestCapabilities("Explain this architecture");
  assert.equal(decision.requestType, "conversation");
  assert.deepEqual(decision.requiredCapabilities, []);

  const allowed = filterEligibleCapableCandidates(
    [candidate("chatgpt-web", "gpt-5.6-sol-xhigh", 0)],
    { taskType: "default", requiredCapabilities: decision.requiredCapabilities },
    codingFitness
  );
  assert.equal(allowed.length, 1);
});

test("security audit requires repository analysis capabilities", () => {
  const decision = classifyRequestCapabilities("Run security audit on this codebase");
  assert.equal(decision.requestType, "security");
  assert.deepEqual(decision.requiredCapabilities, [
    "filesystem",
    "code_analysis",
    "repository_access",
  ]);

  const eligible = filterEligibleCapableCandidates(
    [candidate("chatgpt-web", "gpt-5.6-sol-xhigh", 0), candidate("codex", "gpt-5.6-sol", 4)],
    { taskType: "analysis", requiredCapabilities: decision.requiredCapabilities },
    codingFitness
  );
  assert.deepEqual(
    eligible.map((entry) => entry.provider),
    ["codex"]
  );
});

test("public-open-source repository hardening stays on an execution-capable route", () => {
  const decision = classifyRequestCapabilities(
    "Modify /workspace/project and prepare it for public open source"
  );
  assert.equal(decision.requestType, "repository_execution");

  const ranked = rankCheapestCapable(
    [candidate("chatgpt-web", "gpt-5.6-sol-xhigh", 0), candidate("codex", "gpt-5.6-sol", 4)],
    { taskType: "coding", requiredCapabilities: decision.requiredCapabilities },
    undefined,
    codingFitness
  );
  assert.equal(ranked[0]?.provider, "codex");
});

test("repository execution fails with sanitized capability diagnostics when no route can execute", async () => {
  const web = {
    ...candidate("chatgpt-web", "gpt-5.6-sol-xhigh", 0),
    stepId: "web",
    executionKey: "web-key",
    modelStr: "chatgpt-web/gpt-5.6-sol-xhigh",
  };
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [
      {
        stepId: "web",
        executionKey: "web-key",
        kind: "model",
        provider: "chatgpt-web",
        modelStr: "chatgpt-web/gpt-5.6-sol-xhigh",
      },
    ] as never,
    body: {
      messages: [{ role: "user", content: "Refactor this repository and update README" }],
    },
    combo: { id: "capability-test", name: "capability-test", config: {} } as never,
    settings: null,
    config: {},
    relayOptions: null,
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: { info() {}, warn() {}, debug() {} } as never,
    buildAutoCandidates: (async () => [web]) as never,
  });

  assert.ok("earlyResponse" in result);
  if ("earlyResponse" in result) {
    assert.equal(result.earlyResponse.status, 503);
    const body = await result.earlyResponse.json();
    assert.equal(body?.error?.message, "No compatible execution provider available");
    assert.equal(body?.error?.code, "capability_mismatch");
    assert.equal(body?.diagnostics?.terminalReason, "capability_mismatch");
    assert.equal(body?.diagnostics?.excluded?.[0]?.reason, "missing_filesystem");
  }
});

test("enhanced preferred ordering skips exhausted candidates and dispatches the next eligible preference", async () => {
  const luna = {
    ...candidate("codex", "luna", 1),
    availability: "quota_exhausted" as const,
    quotaRemaining: 0,
    stepId: "luna",
    executionKey: "luna-key",
    modelStr: "codex/luna",
    maxInputTokens: 128_000,
  };
  const sol = {
    ...candidate("codex", "sol", 5),
    availability: "available" as const,
    stepId: "sol",
    executionKey: "sol-key",
    modelStr: "codex/sol",
    maxInputTokens: 128_000,
  };
  const result = await resolveAutoStrategyOrder({
    orderedTargets: [
      {
        stepId: "luna",
        executionKey: "luna-key",
        kind: "model",
        provider: "codex",
        modelStr: "codex/luna",
      },
      {
        stepId: "sol",
        executionKey: "sol-key",
        kind: "model",
        provider: "codex",
        modelStr: "codex/sol",
      },
    ] as never,
    body: { messages: [{ role: "user", content: "Explain this change" }] },
    combo: {
      id: "preference-test",
      name: "preference-test",
      config: { candidatePool: ["codex"] },
    } as never,
    settings: null,
    config: {},
    relayOptions: {
      routingEnvelope: {
        schemaVersion: 1,
        requiredCapabilities: [],
        minimumContext: 120_000,
        preferredCandidates: ["codex/luna", "codex/sol"],
        preferenceMode: "balanced",
        taskProfileId: null,
        routingPolicyVersion: null,
      },
    },
    resilienceSettings: { quotaPreflight: { enabled: false } } as never,
    log: { info() {}, warn() {}, debug() {} } as never,
    buildAutoCandidates: (async () => [luna, sol]) as never,
  });

  assert.ok("orderedTargets" in result);
  if ("orderedTargets" in result) {
    assert.equal(result.orderedTargets[0]?.modelStr, "codex/sol");
    assert.equal(
      result.orderedTargets.some((target) => target.modelStr === "codex/luna"),
      false
    );
  }
});
