# Quattro integration

Quattro works with standard OmniRoute. This maintained fork adds an optional routing-intelligence
contract; it is not required for basic Quattro operation.

## Standard mode

Quattro can use upstream or standard OmniRoute through the existing OpenAI-compatible endpoints.
It receives:

- FAST, STANDARD, and REASONING route labels;
- normal OmniRoute dispatch, retry, and fallback;
- Quattro orchestration outside the gateway.

Standard mode does not provide a stable candidate-level observability or preference contract.

## Enhanced mode

With this fork, Quattro can first request `GET /api/v1/capabilities`. A response with
`schema_version: 1` and the relevant flags enables:

- candidate observability;
- model and execution capability metadata;
- practical context metadata;
- sanitized current availability, quota, cooldown, and rejection state;
- ordered candidate preferences;
- capability-first cheapest-capable routing;
- routing explainability.

Read the current candidate set from:

```http
GET /api/v1/routing/candidates?channel=auto
```

The snapshot contains `schema_version`, `generated_at`, and `metadata_version`. Clients must reject
unknown major schema versions instead of guessing. It never includes API keys, OAuth state,
cookies, raw provider errors, private configuration, or account/connection identifiers.

## Optional routing envelope

Codex clients that cannot add a Responses body extension may send the exact
same schema as bounded JSON in `X-Quattro-Routing`. Codex supports this without
a patch through custom-provider `env_http_headers`; OmniRoute rejects duplicate
body/header envelopes, validates the header identically, and strips it before
provider translation. `GET /api/v1/capabilities` advertises this as
`routing_header_transport`.

For validated enhanced envelopes on an `auto/...` tier alias, OmniRoute expands
the request to the complete base auto inventory before applying the envelope's
hard requirements and ordered preferences. Ordinary clients without an
envelope retain the original tier-route behavior.

Chat Completions and Responses requests may include a top-level `routing` object:

```json
{
  "model": "auto",
  "routing": {
    "schema_version": 1,
    "requirements": {
      "capabilities": ["repository_access", "code_execution"],
      "minimum_context": 120000
    },
    "preferred_candidates": ["codex/gpt-5.6-luna", "deepseek/deepseek-v4", "codex/gpt-5.6-sol"],
    "preference_mode": "balanced",
    "task_profile_id": "repository-change",
    "routing_policy_version": "2026-09-02"
  },
  "input": "Update this repository"
}
```

The envelope is validated, removed before provider translation, and never sent upstream. It is
bounded to routing facts; do not include prompts, benchmark results, local outcome history,
reasoning traces, ambiguity scores, or Quattro's complete task profile.

Supported capability names are `browser`, `filesystem`, `shell`, `git`, `code_editing`,
`code_execution`, `code_analysis`, `repository_access`, `sandbox_write`, `reasoning`, and
`long_context`. Schema version 1 supports the `balanced` preference mode. Other modes are rejected
until their selection semantics are implemented and independently versioned.

## Dispatch semantics

Required capabilities and explicit minimum context are hard gates. Preferred candidates are an
ordered preference, never a forced route. OmniRoute revalidates every candidate against current
capability, health, provider breaker, connection cooldown, model lockout, quota, rate limit, and
runtime availability. If a preferred candidate is exhausted or unavailable, it is skipped and the
next eligible preference is tried. Remaining eligible candidates retain normal OmniRoute fallback.

OmniRoute remains authoritative for runtime health and dispatch. Quattro remains authoritative for
benchmark interpretation and model-quality policy.
