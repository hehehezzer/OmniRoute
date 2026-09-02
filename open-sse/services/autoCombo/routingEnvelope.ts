import { z } from "zod";

import { type ExecutionCapability, isExecutionCapability } from "./capabilityRequirements.ts";

export const ROUTING_ENVELOPE_SCHEMA_VERSION = 1 as const;
export const QUATTRO_ROUTING_HEADER = "x-quattro-routing";
const MAX_ROUTING_HEADER_BYTES = 8_192;

export const ROUTING_PREFERENCE_MODES = ["balanced"] as const;
export type RoutingPreferenceMode = (typeof ROUTING_PREFERENCE_MODES)[number];

const candidateIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(160)
  .regex(
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/,
    "candidate ids must use provider/model format"
  );

const routingEnvelopeSchema = z
  .object({
    schema_version: z.literal(ROUTING_ENVELOPE_SCHEMA_VERSION),
    requirements: z
      .object({
        capabilities: z.array(z.string().trim().min(1).max(64)).max(16).default([]),
        minimum_context: z.number().int().min(1).max(2_000_000).optional(),
      })
      .strict()
      .default({ capabilities: [] }),
    preferred_candidates: z.array(candidateIdSchema).max(32).default([]),
    preference_mode: z.enum(ROUTING_PREFERENCE_MODES).default("balanced"),
    task_profile_id: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
      .optional(),
    routing_policy_version: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seenCapabilities = new Set<string>();
    value.requirements.capabilities.forEach((capability, index) => {
      if (!isExecutionCapability(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "unsupported routing capability",
          path: ["requirements", "capabilities", index],
        });
      } else if (seenCapabilities.has(capability)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate routing capability",
          path: ["requirements", "capabilities", index],
        });
      }
      seenCapabilities.add(capability);
    });

    const seenCandidates = new Set<string>();
    value.preferred_candidates.forEach((candidate, index) => {
      const normalized = candidate.toLowerCase();
      if (seenCandidates.has(normalized)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "duplicate preferred candidate",
          path: ["preferred_candidates", index],
        });
      }
      seenCandidates.add(normalized);
    });
  });

export interface RoutingPreferenceEnvelope {
  schemaVersion: typeof ROUTING_ENVELOPE_SCHEMA_VERSION;
  requiredCapabilities: readonly ExecutionCapability[];
  minimumContext: number | null;
  preferredCandidates: readonly string[];
  preferenceMode: RoutingPreferenceMode;
  taskProfileId: string | null;
  routingPolicyVersion: string | null;
}

export interface AdaptiveRoutingReceipt {
  task_profile_id: string;
  routing_policy_version: string | null;
  preferred_candidates: readonly string[];
  selected_candidate: string | null;
  decisions: readonly {
    target: string;
    decision: "dispatched" | "skipped_before_dispatch" | "not_reached";
    reason?: string;
  }[];
  received_at: string;
}

const MAX_ADAPTIVE_RECEIPTS = 500;
const adaptiveReceipts: AdaptiveRoutingReceipt[] = [];

export function recordAdaptiveRoutingReceipt(
  envelope: RoutingPreferenceEnvelope,
  decisions: AdaptiveRoutingReceipt["decisions"]
): void {
  if (!envelope.taskProfileId) return;
  const selected = decisions.find((entry) => entry.decision === "dispatched")?.target ?? null;
  adaptiveReceipts.push({
    task_profile_id: envelope.taskProfileId,
    routing_policy_version: envelope.routingPolicyVersion,
    preferred_candidates: [...envelope.preferredCandidates],
    selected_candidate: selected,
    decisions: decisions.map((entry) => ({ ...entry })),
    received_at: new Date().toISOString(),
  });
  if (adaptiveReceipts.length > MAX_ADAPTIVE_RECEIPTS) adaptiveReceipts.shift();
}

export function recentAdaptiveRoutingReceipts(limit = 50): AdaptiveRoutingReceipt[] {
  return adaptiveReceipts.slice(-Math.max(1, Math.min(limit, MAX_ADAPTIVE_RECEIPTS))).reverse();
}

export function resetAdaptiveRoutingReceipts(): void {
  adaptiveReceipts.length = 0;
}

export type RoutingEnvelopeExtraction =
  | {
      success: true;
      body: Record<string, unknown>;
      envelope: RoutingPreferenceEnvelope | null;
    }
  | { success: false; message: string };

/**
 * Validate and remove the optional public routing extension before any provider
 * translator sees the body. The envelope is request-scoped routing metadata,
 * never provider input.
 */
export function extractRoutingPreferenceEnvelope(
  input: Record<string, unknown>
): RoutingEnvelopeExtraction {
  if (!Object.prototype.hasOwnProperty.call(input, "routing")) {
    return { success: true, body: input, envelope: null };
  }

  const parsed = routingEnvelopeSchema.safeParse(input.routing);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path?.length ? `routing.${issue.path.join(".")}` : "routing";
    return { success: false, message: `${field}: ${issue?.message || "Invalid value"}` };
  }

  const body = { ...input };
  delete body.routing;
  const routing = parsed.data;
  return {
    success: true,
    body,
    envelope: {
      schemaVersion: routing.schema_version,
      requiredCapabilities: routing.requirements.capabilities as ExecutionCapability[],
      minimumContext: routing.requirements.minimum_context ?? null,
      preferredCandidates: routing.preferred_candidates,
      preferenceMode: routing.preference_mode,
      taskProfileId: routing.task_profile_id ?? null,
      routingPolicyVersion: routing.routing_policy_version ?? null,
    },
  };
}

/**
 * Codex supports dynamic custom-provider headers but does not expose arbitrary
 * body extensions. This bounded transport converts its request-scoped header
 * into the same validated body envelope before normal extraction. A body and
 * header may never compete for authority.
 */
export function applyRoutingPreferenceHeader(
  input: Record<string, unknown>,
  headers: Headers
): { success: true; body: Record<string, unknown> } | { success: false; message: string } {
  const value = headers.get(QUATTRO_ROUTING_HEADER);
  if (value === null) return { success: true, body: input };
  if (Object.prototype.hasOwnProperty.call(input, "routing")) {
    return { success: false, message: "routing: duplicate body and header transport" };
  }
  if (new TextEncoder().encode(value).byteLength > MAX_ROUTING_HEADER_BYTES) {
    return { success: false, message: "routing header exceeds the size limit" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { success: false, message: "routing header is not valid JSON" };
  }
  return { success: true, body: { ...input, routing: parsed } };
}

export function expandEnhancedAutoRoute(
  input: Record<string, unknown>,
  envelope: RoutingPreferenceEnvelope | null
): Record<string, unknown> {
  return envelope && typeof input.model === "string" && input.model.startsWith("auto/")
    ? { ...input, model: "auto" }
    : input;
}

function candidateIdentity(candidate: { provider: string; model: string }): string {
  return `${candidate.provider}/${candidate.model}`.toLowerCase();
}

/** Ordered preferences only reorder candidates that already passed hard gates. */
export function orderEligibleCandidatesByPreference<T extends { provider: string; model: string }>(
  candidates: readonly T[],
  preferredCandidates: readonly string[]
): T[] {
  if (preferredCandidates.length === 0) return [...candidates];
  const ranks = new Map(preferredCandidates.map((id, index) => [id.toLowerCase(), index]));
  return candidates
    .map((candidate, index) => ({
      candidate,
      index,
      rank: ranks.get(candidateIdentity(candidate)),
    }))
    .sort((left, right) => {
      const leftRank = left.rank ?? Number.POSITIVE_INFINITY;
      const rightRank = right.rank ?? Number.POSITIVE_INFINITY;
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ candidate }) => candidate);
}
