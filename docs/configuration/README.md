# Configuration Guide

OmniRoute configuration is intentionally split between version-controlled
application defaults, environment variables, and authenticated dashboard
settings. Do not commit local `.env` files or provider credentials.

## Start here

- [Environment variable reference](../reference/ENVIRONMENT.md)
- [Auto-combo routing guide](../routing/AUTO-COMBO.md)
- [Resilience settings](../architecture/RESILIENCE_GUIDE.md)
- [Provider reference](../reference/PROVIDER_REFERENCE.md)

## Safe configuration workflow

1. Copy `.env.example` to a local, ignored `.env` file.
2. Set only the secrets and endpoint settings required for your deployment.
3. Validate configuration with the dashboard or repository-native checks before
   exposing the service to clients.
4. Keep provider credentials, API keys, OAuth tokens, and database snapshots out
   of issue reports, pull requests, logs, and Git history.
