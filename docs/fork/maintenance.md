# Fork maintenance and upstream sync

## Identity and release numbering

This project is derived from [OmniRoute](https://github.com/diegosouzapw/OmniRoute). The upstream
license, notices, contributor history, and attribution are retained. Fork releases use the upstream
version plus a Quattro suffix:

```text
upstream base: v3.8.51
fork release:  v3.8.51-quattro.1
```

A fork tag must never be presented as an upstream release. Release notes record both the upstream
base commit/tag and the fork release number. Tags are created only after explicit maintainer
approval.

## Remotes

```bash
git remote -v
# origin   https://github.com/hehehezzer/OmniRoute.git
# upstream https://github.com/diegosouzapw/OmniRoute.git
```

## Sync workflow

1. Start from a clean fork maintenance branch.
2. `git fetch --prune upstream origin`.
3. Review `git log --left-right --cherry-pick --oneline upstream/<branch>...HEAD`.
4. Merge the selected upstream release branch or tag. Do not rewrite published upstream history.
5. Resolve conflicts while keeping fork additions isolated and additive.
6. Run lint, typecheck, unit, integration, build, Docker, and security/secret checks.
7. Update the recorded upstream base and increment only the `-quattro.N` suffix.
8. Push to `origin`; never push to `upstream` from this workflow.

Rebasing is acceptable only for unpublished local topic commits. Published fork release branches
use merges so attribution and sync history remain auditable.

## Architecture boundary

Fork additions expose runtime/model facts and accept bounded routing requirements. Quattro-specific
benchmark intelligence, local outcome history, private prompts, and business policy stay outside
OmniRoute. Standard clients remain supported when no enhanced metadata is supplied.
