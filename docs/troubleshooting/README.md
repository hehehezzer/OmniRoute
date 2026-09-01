# Troubleshooting Guide

Start with the bounded, non-destructive checks below. Do not paste credentials,
full request payloads, or database dumps into public issues.

## Common references

- [General troubleshooting](../guides/TROUBLESHOOTING.md)
- [Relay troubleshooting](../reference/RELAY_TROUBLESHOOTING.md)
- [Resilience and routing behavior](../architecture/RESILIENCE_GUIDE.md)
- [Security policy](../../SECURITY.md)

## Diagnostic order

1. Confirm the configured model and provider connection are healthy.
2. Check the routing decision and bounded error diagnostics.
3. Reproduce with the smallest safe request.
4. Attach sanitized logs, exact version, and validation output when filing an
   issue.
