# Potential upstream contributions

No upstream pull request is created by this repository-preparation work. The following changes are
good candidates for separate, focused proposals to
[upstream OmniRoute](https://github.com/diegosouzapw/OmniRoute):

| Area                                    | Classification       | Upstream proposal shape                                                       |
| --------------------------------------- | -------------------- | ----------------------------------------------------------------------------- |
| Practical input limits                  | General upstreamable | Add an operator override and conservative dispatch gate.                      |
| Capability-aware eligibility            | General upstreamable | Propose the generic registry/gate without Quattro naming or benchmark policy. |
| Sanitized candidate snapshot            | General upstreamable | Versioned read-only projection with no connection/account identifiers.        |
| External routing requirements           | General upstreamable | Optional bounded schema, provider-stripped before dispatch.                   |
| Preferred candidate fallback            | General upstreamable | Ordered advisory preference after health/quota/capability validation.         |
| Bounded combo retry lifecycle           | Bugfix               | Submit independently with timer-cleanup regression coverage.                  |
| Queue/execution timeout separation      | Bugfix               | Submit independently with queue and execution timeout tests.                  |
| Gemini replayed tool aliases            | Bugfix               | Submit independently with Responses replay regression coverage.               |
| Disabled no-auth vision provider filter | Bugfix               | Submit independently with provider-disable regression coverage.               |

Generated agent guidance and fork release/branding documentation should remain fork-local unless
upstream explicitly requests them.
