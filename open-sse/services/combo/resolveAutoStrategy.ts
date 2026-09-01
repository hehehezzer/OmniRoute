import {
  errorResponse,
  unavailableResponse,
  errorResponseWithComboDiagnostics,
} from "../../utils/error.ts";
import {
  BudgetExceededError,
  NoEligibleCandidateError,
  selectProvider as selectAutoProvider,
} from "../autoCombo/engine.ts";
import {
  resolveRequestModePack,
  parseRequestBudgetCap,
  parseRequestBudgetFallback,
} from "../autoCombo/requestControls.ts";
import { selectWithStrategy } from "../autoCombo/routerStrategy.ts";
import {
  evaluateCandidateEligibility,
  filterEligibleCapableCandidates,
  type CandidateRequirements,
} from "../autoCombo/scoring.ts";
import {
  classifyRequestCapabilities,
  isExecutionRequest,
} from "../autoCombo/capabilityRequirements.ts";
import { orderEligibleCandidatesByPreference } from "../autoCombo/routingEnvelope.ts";
import { getTaskFitness } from "../autoCombo/taskFitness.ts";
import { buildComplexityRoutingHint } from "../autoCombo/complexityRouter";
import { getModePack } from "../autoCombo/modePacks.ts";
import { recordComboIntent } from "../comboMetrics.ts";
import { estimateTokens } from "../contextManager.ts";
import { classifyWithConfig } from "../intentClassifier.ts";
import type { RoutingHint } from "../manifestAdapter";
import { parseModel } from "../model.ts";
import { supportsToolCalling } from "../modelCapabilities.ts";
import type { ResilienceSettings } from "../../../src/lib/resilience/settings";
import { parseAutoConfig } from "./autoConfig.ts";
import { dedupeTargetsByExecutionKey } from "./comboData.ts";
import {
  getModelContextLimitForModelString,
  providerSupportsEmulatedToolCalling,
} from "./comboStructure.ts";
import {
  calculatePromptCacheAffinityScores,
  promptCacheTargetIdentity,
} from "./promptCacheAffinity.ts";
import type { ResetWindowConfig } from "./quotaScoring.ts";
import {
  _registerExecutionCandidates,
  expandAutoComboCandidatePool,
  extractPromptForIntent,
  getIntentConfig,
  mapIntentToTaskType,
  scoreAutoTargets,
} from "./autoStrategy.ts";
import type {
  AutoProviderCandidate,
  ComboLike,
  ComboLogger,
  ResolvedComboTarget,
} from "./types.ts";

/**
 * Dependency-injected `buildAutoCandidates` — it lives in `combo.ts` (the host of
 * this leaf), so importing it directly would create an import cycle. Passing it
 * through `deps` keeps this module acyclic (same pattern as `buildTargetTimeoutRunner`).
 */
type BuildAutoCandidates = (
  targets: ResolvedComboTarget[],
  comboName: string,
  sessionId?: string | null,
  resetWindowConfig?: ResetWindowConfig,
  resilienceSettings?: ResilienceSettings | null
) => Promise<AutoProviderCandidate[]>;

export interface ResolveAutoStrategyDeps {
  orderedTargets: ResolvedComboTarget[];
  body: Record<string, unknown>;
  combo: ComboLike;
  settings: Record<string, unknown> | null | undefined;
  config: { complexityAwareRouting?: boolean; compatFilterFailOpen?: boolean };
  relayOptions?: {
    bypassProviderQuotaPolicy?: boolean;
    sessionId?: string | null;
    /** Per-request X-OmniRoute-Mode value (#6024/#6025). */
    mode?: string | null;
    /** Per-request X-OmniRoute-Budget value in USD (#6023). */
    budgetCap?: number | null;
    /** Per-request X-OmniRoute-Budget-Fallback value ("cheapest" | "strict") — #3470. */
    budgetFallback?: "cheapest" | "strict" | null;
    routingEnvelope?: import("../autoCombo/routingEnvelope.ts").RoutingPreferenceEnvelope | null;
  } | null;
  resilienceSettings: ResilienceSettings;
  log: ComboLogger;
  buildAutoCandidates: BuildAutoCandidates;
}

export type ResolveAutoStrategyResult =
  | { earlyResponse: Response }
  | { orderedTargets: ResolvedComboTarget[]; autoUsedExplicitRouter: boolean };

/**
 * Resolve target ordering for the `auto` combo strategy.
 *
 * Extracted verbatim from `handleComboChat`'s `if (strategy === "auto")` branch:
 * tool-calling + context-window pre-filters, intent classification, candidate
 * building (quota cutoff), explicit-router vs rules selection, complexity-aware
 * scoring and final dedup ordering. Behavior is byte-identical to the previous
 * inline block; the two `return unavailableResponse(...)` exits become
 * `{ earlyResponse }` so the host can decide to return them, and the mutated
 * `orderedTargets` / `autoUsedExplicitRouter` are returned instead of closed over.
 */
export async function resolveAutoStrategyOrder(
  deps: ResolveAutoStrategyDeps
): Promise<ResolveAutoStrategyResult> {
  const {
    body,
    combo,
    settings,
    config,
    relayOptions,
    resilienceSettings,
    log,
    buildAutoCandidates,
  } = deps;
  let orderedTargets = deps.orderedTargets;
  let autoUsedExplicitRouter = false;

  const requestHasTools = Array.isArray(body?.tools) && body.tools.length > 0;
  let eligibleTargets = [...orderedTargets];
  const compatFilterFailOpen =
    config?.compatFilterFailOpen === true ||
    (settings as { compatFilterFailOpen?: unknown } | null | undefined)?.compatFilterFailOpen ===
      true;

  if (requestHasTools) {
    // Keep #5240 prompt-emulation providers (toolCalling:"emulated") even when
    // registry/capability rows honestly report toolCalling:false.
    const filtered = eligibleTargets.filter(
      (target) =>
        supportsToolCalling(target.modelStr) || providerSupportsEmulatedToolCalling(target.provider)
    );
    if (filtered.length > 0) {
      eligibleTargets = filtered;
    } else if (compatFilterFailOpen) {
      log.warn(
        "COMBO",
        "Auto strategy: all candidates filtered by tool-calling policy, falling back to full pool (compatFilterFailOpen)"
      );
    } else {
      // #8488: fail closed with an explicit compatibility error instead of
      // re-admitting tool-incapable targets.
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      return {
        earlyResponse: errorResponseWithComboDiagnostics(
          400,
          `No target in combo ${combo.name} supports tool calling; request carried ${toolCount} tools`,
          {
            poolSize: eligibleTargets.length,
            attempted: 0,
            excluded: eligibleTargets.map((target) => ({
              provider: target.provider,
              model: target.modelStr,
              reason: "tools",
            })),
            attemptOrder: [],
            terminalReason: "capability_mismatch",
          },
          { code: "capability_mismatch", type: "invalid_request_error" }
        ),
      };
    }
  }

  eligibleTargets = await expandAutoComboCandidatePool(eligibleTargets, combo);

  // Context-window pre-filter (#1808)
  // Estimate input tokens once; exclude candidates whose known context limit is too small.
  // Uses the same 4-chars-per-token heuristic as contextManager.ts::compressContext().
  // Null/unknown limits are treated as "include" to avoid incorrectly dropping valid targets.
  const requestMessages = body.messages;
  const estimatedInputTokens = estimateTokens(
    typeof requestMessages === "string" ||
      (requestMessages !== null && typeof requestMessages === "object")
      ? requestMessages
      : []
  );
  if (estimatedInputTokens > 0) {
    const filteredByContext = eligibleTargets.filter((target) => {
      const limit = getModelContextLimitForModelString(target.modelStr);
      if (limit === null || limit === undefined) return true; // unknown — include to be safe
      return limit >= estimatedInputTokens;
    });
    if (filteredByContext.length > 0) {
      log.debug?.(
        "COMBO",
        `Auto strategy: context-window filter kept ${filteredByContext.length}/${eligibleTargets.length} candidates (est. ${estimatedInputTokens} tokens)`
      );
      eligibleTargets = filteredByContext;
    } else {
      // Static context metadata is advisory at this early routing stage. The
      // compression/final budget pipeline is authoritative after dispatch.
      log.warn(
        "COMBO",
        `Auto strategy: all candidates exceed the approximate context estimate (${estimatedInputTokens} tokens); preserving the eligible pool`
      );
    }
  }

  const prompt = extractPromptForIntent(body);
  const systemPrompt = typeof combo?.system_message === "string" ? combo.system_message : undefined;
  const intentConfig = getIntentConfig(settings, combo);
  const intent = classifyWithConfig(prompt, intentConfig, systemPrompt);
  recordComboIntent(combo.name, intent);
  const taskType = mapIntentToTaskType(intent);
  const capabilityDecision = classifyRequestCapabilities(prompt);
  const externalRouting = relayOptions?.routingEnvelope ?? null;
  const requiredCapabilities = [
    ...new Set([
      ...capabilityDecision.requiredCapabilities,
      ...(externalRouting?.requiredCapabilities ?? []),
    ]),
  ];
  const candidateRequirements: CandidateRequirements = {
    taskType,
    estimatedInputTokens,
    minimumContextTokens: externalRouting?.minimumContext ?? undefined,
    requiredCapabilities,
  };

  const {
    routingStrategy,
    candidatePool,
    weights: configWeights,
    explorationRate,
    budgetCap: configBudgetCap,
    budgetFallback: configBudgetFallback,
    modePack: configModePack,
    resetWindowConfig,
    slaPolicy,
  } = parseAutoConfig(combo, eligibleTargets);

  // Per-request overrides (#6023 / #6024 / #6025 / #3470): X-OmniRoute-Budget,
  // X-OmniRoute-Budget-Fallback and X-OmniRoute-Mode headers (threaded via
  // relayOptions) take precedence over the combo's stored config for this single
  // request. Unknown/garbage header values are ignored so the saved config is
  // preserved.
  const requestBudgetCap = parseRequestBudgetCap(relayOptions?.budgetCap);
  const budgetCap = requestBudgetCap ?? configBudgetCap;
  const requestBudgetFallback = parseRequestBudgetFallback(relayOptions?.budgetFallback);
  const budgetFallback = requestBudgetFallback ?? configBudgetFallback;
  const requestModePack = resolveRequestModePack(relayOptions?.mode);
  const modePack = requestModePack.override ? requestModePack.modePack : configModePack;
  // #7008: `weights` must track the *effective* (post-override) modePack, not just
  // the combo's stored one. `selectAutoProvider()` (engine.ts) already re-derives
  // weights internally from the `modePack` it's given, so it correctly reacts to a
  // per-request X-OmniRoute-Mode override — but `scoreAutoTargets()` (the fallback
  // ranking below) has no such re-derivation and only ever sees whatever `weights`
  // it's handed. Without this recompute, a request overriding e.g. `quality-first`
  // to `ship-fast` would select its primary target under ship-fast weights but rank
  // every fallback under the stale quality-first weights — the same
  // select-under-one-policy/rank-under-another bug this module's original fix
  // (parseAutoConfig honoring the combo's own stored modePack) set out to close.
  const weights = modePack ? getModePack(modePack) || configWeights : configWeights;
  if (
    requestModePack.override ||
    requestBudgetCap !== undefined ||
    requestBudgetFallback !== undefined
  ) {
    log.debug?.(
      "COMBO",
      `Auto strategy: per-request controls applied (mode=${
        requestModePack.override ? (requestModePack.modePack ?? "balanced") : "—"
      }, budgetCap=${requestBudgetCap ?? "—"}, budgetFallback=${requestBudgetFallback ?? "—"})`
    );
  }

  let lastKnownGoodProvider: string | undefined;
  try {
    const { getLKGP } = await import("../../../src/lib/localDb");
    const lkgp = await getLKGP(combo.name, combo.id || combo.name);
    if (lkgp) lastKnownGoodProvider = lkgp.provider;
  } catch (err) {
    log.warn("COMBO", "Failed to retrieve Last Known Good Provider. This is non-fatal.", { err });
  }

  const autoCandidateResilienceSettings =
    relayOptions?.bypassProviderQuotaPolicy === true
      ? {
          ...resilienceSettings,
          quotaPreflight: {
            ...resilienceSettings.quotaPreflight,
            enabled: false,
          },
        }
      : resilienceSettings;
  const candidates = await buildAutoCandidates(
    eligibleTargets,
    combo.name,
    relayOptions?.sessionId,
    resetWindowConfig,
    autoCandidateResilienceSettings
  );
  const cacheAffinityScores = calculatePromptCacheAffinityScores(
    candidates,
    body,
    relayOptions?.sessionId
  );
  for (const candidate of candidates) {
    candidate.cacheAffinity = cacheAffinityScores.get(promptCacheTargetIdentity(candidate)) ?? 0;
  }
  const eligibleCandidates = filterEligibleCapableCandidates(
    candidates,
    candidateRequirements,
    getTaskFitness
  );
  const routableCandidates = orderEligibleCandidatesByPreference(
    eligibleCandidates,
    externalRouting?.preferredCandidates ?? []
  );
  const blockedCount = candidates.length - routableCandidates.length;
  if (blockedCount > 0) {
    log.info(
      "COMBO",
      `Auto strategy: eligibility/capability gates skipped ${blockedCount}/${candidates.length} account candidates`
    );
  }
  // G2: Register candidates so chatCore can mark quotaSoftPenalty via setCandidateQuotaSoftPenalty.
  _registerExecutionCandidates(routableCandidates);
  if (routableCandidates.length === 0) {
    const allQuotaBlocked =
      candidates.length > 0 &&
      candidates.every((candidate) => candidate.quotaCutoffBlocked === true);
    const exclusions = candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      reason:
        evaluateCandidateEligibility(candidate, candidateRequirements, getTaskFitness).reason ||
        "ineligible",
    }));
    const capabilityBlocked = exclusions.some((entry) => entry.reason.startsWith("missing_"));
    if (
      isExecutionRequest(capabilityDecision.requestType) &&
      (candidates.length === 0 || capabilityBlocked)
    ) {
      return {
        earlyResponse: errorResponseWithComboDiagnostics(
          503,
          "No compatible execution provider available",
          {
            poolSize: candidates.length,
            attempted: 0,
            excluded: exclusions,
            attemptOrder: [],
            terminalReason: "capability_mismatch",
          },
          { code: "capability_mismatch", type: "service_unavailable_error" }
        ),
      };
    }
    return {
      earlyResponse: unavailableResponse(
        allQuotaBlocked ? 429 : 503,
        allQuotaBlocked
          ? "All auto strategy candidates are below configured quota cutoffs"
          : "No healthy auto strategy candidate satisfies the request requirements"
      ),
    };
  }
  if (routableCandidates.length > 0) {
    let selectedProvider: string | null = null;
    let selectedModel: string | null = null;
    let selectedConnectionId: string | null = null;
    let selectionReason = "";

    const preferredCandidate = routableCandidates.find((candidate) =>
      (externalRouting?.preferredCandidates ?? [])
        .map((entry) => entry.toLowerCase())
        .includes(`${candidate.provider}/${candidate.model}`.toLowerCase())
    );

    if (preferredCandidate) {
      selectedProvider = preferredCandidate.provider;
      selectedModel = preferredCandidate.model;
      selectedConnectionId = preferredCandidate.connectionId ?? null;
      selectionReason = "first eligible external preference";
    }

    if (!selectedProvider && routingStrategy !== "rules") {
      try {
        const decision = selectWithStrategy(
          routableCandidates,
          {
            taskType,
            requestHasTools,
            lastKnownGoodProvider,
            // #11181: the Routing tab persists an LKGP on/off toggle and
            // LKGPStrategy guards on `context.lkgpEnabled === false`, but the
            // field was never forwarded into this context, so the guard never
            // saw the setting and the off-switch was unreachable.
            lkgpEnabled: (settings as { lkgpEnabled?: unknown } | null | undefined)?.lkgpEnabled as
              boolean | undefined,
            estimatedInputTokens,
            capabilityRequirements: candidateRequirements,
            sla: slaPolicy,
          },
          routingStrategy
        );
        selectedProvider = decision.provider;
        selectedModel = decision.model;
        selectedConnectionId = decision.connectionId ?? null;
        selectionReason = decision.reason;
        autoUsedExplicitRouter = true;
      } catch (err) {
        log.warn(
          "COMBO",
          `Auto strategy '${routingStrategy}' failed (${err?.message || "unknown"}), falling back to rules`
        );
      }
    }

    if (!selectedProvider || !selectedModel) {
      let selection;
      try {
        selection = selectAutoProvider(
          {
            id: combo.id || combo.name,
            name: combo.name,
            type: "auto",
            candidatePool,
            weights,
            modePack,
            budgetCap,
            budgetFallback,
            explorationRate,
          },
          routableCandidates,
          taskType,
          undefined,
          candidateRequirements
        );
      } catch (err) {
        // #3470: `budgetFallback: "strict"` refuses to select when every candidate
        // exceeds `budgetCap` — surface a clear cost-exceeds-budget response
        // instead of letting it propagate as an unhandled 500.
        if (err instanceof BudgetExceededError) {
          return { earlyResponse: errorResponse(402, err.message) };
        }
        if (err instanceof NoEligibleCandidateError) {
          return { earlyResponse: unavailableResponse(503, err.message) };
        }
        throw err;
      }
      selectedProvider = selection.provider;
      selectedModel = selection.model;
      selectedConnectionId = selection.connectionId ?? null;
      selectionReason = `score=${selection.score.toFixed(3)}${selection.isExploration ? " (exploration)" : ""}`;
    }

    // Complexity-aware routing (2026, opt-in): classify the request's
    // difficulty and feed a tier hint into scoring so tierAffinity /
    // specificityMatch favor candidates whose tier matches the request.
    const autoManifestHint: RoutingHint | null =
      config.complexityAwareRouting === true
        ? buildComplexityRoutingHint(
            eligibleTargets.filter((t) => t.kind === "model"),
            body,
            log
          )
        : null;

    const scoredTargets = scoreAutoTargets(
      eligibleTargets,
      routableCandidates,
      taskType,
      weights,
      autoManifestHint,
      candidateRequirements
    );
    const rankedTargets = scoredTargets.map((entry) => entry.target);
    const preferredTargetOrder = new Map(
      (externalRouting?.preferredCandidates ?? []).map((candidate, index) => [
        candidate.toLowerCase(),
        index,
      ])
    );
    rankedTargets.sort((left, right) => {
      const leftParsed = parseModel(left.modelStr);
      const rightParsed = parseModel(right.modelStr);
      const leftId = `${left.provider}/${leftParsed.model || left.modelStr}`.toLowerCase();
      const rightId = `${right.provider}/${rightParsed.model || right.modelStr}`.toLowerCase();
      return (
        (preferredTargetOrder.get(leftId) ?? Number.POSITIVE_INFINITY) -
        (preferredTargetOrder.get(rightId) ?? Number.POSITIVE_INFINITY)
      );
    });
    const selectedTarget =
      scoredTargets.find((entry) => {
        const parsed = parseModel(entry.target.modelStr);
        const modelId = parsed.model || entry.target.modelStr;
        return (
          entry.target.provider === selectedProvider &&
          modelId === selectedModel &&
          (!selectedConnectionId || entry.target.connectionId === selectedConnectionId)
        );
      })?.target || rankedTargets[0];
    if (!selectedTarget) {
      return {
        earlyResponse: unavailableResponse(
          429,
          "No auto strategy targets remained after quota cutoff filtering"
        ),
      };
    }

    // Fallbacks must remain inside the same hard eligibility/capability pool.
    // Re-appending eligibleTargets here used to resurrect rate-limited, quota-
    // exhausted, circuit-open, and capability-mismatched candidates.
    orderedTargets = dedupeTargetsByExecutionKey(
      [selectedTarget, ...rankedTargets].filter(
        (entry): entry is ResolvedComboTarget => entry !== undefined && entry !== null
      )
    );

    const rejected = candidates
      .map((candidate) => ({
        candidate,
        reason: evaluateCandidateEligibility(candidate, candidateRequirements, getTaskFitness)
          .reason,
      }))
      .filter((entry) => entry.reason)
      .map((entry) => `${entry.candidate.provider}/${entry.candidate.model}:${entry.reason}`)
      .join(", ");
    log.info(
      "COMBO",
      `Auto selection: ${selectedTarget?.modelStr || `${selectedProvider}/${selectedModel}`} | intent=${intent} task=${taskType} | strategy=${routingStrategy} | ${selectionReason} | routingTask=${capabilityDecision.requestType} | required=${requiredCapabilities.join(",") || "none"} | rejected=${rejected || "none"}`
    );
  } else {
    return {
      earlyResponse: unavailableResponse(
        503,
        "No healthy auto strategy candidate satisfies the request requirements"
      ),
    };
  }

  return { orderedTargets, autoUsedExplicitRouter };
}
