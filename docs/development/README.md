# Development Guide

Use the repositorys documented development workflow rather than relying on
local state from another contributors machine.

## Start here

- [Developer environment](../DEVELOPER-ENVIRONMENT.md)
- [Contribution golden path](../ops/CONTRIBUTION_GOLDEN_PATH.md)
- [Contributing guide](../../CONTRIBUTING.md)
- [Architecture overview](../architecture/ARCHITECTURE.md)

## Quality baseline

Before opening a pull request, run the focused tests for changed code, then the
relevant lint, type-check, and documentation checks. Keep commits focused and
use conventional commit messages. Never include generated build output, local
provider configuration, or credentials in a commit.
