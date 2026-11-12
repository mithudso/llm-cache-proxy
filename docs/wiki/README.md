# Project wiki

This wiki is versioned with the implementation and checked in PRs. It links to the
maintained references instead of duplicating commands in a separate wiki repository.

| Need | Reference |
|---|---|
| Start or install | [Installation](../INSTALLATION.md) |
| Commands and endpoints | [Usage](../../USAGE.md) |
| Develop and validate | [Development](../DEVELOPMENT.md), [testing](../TESTING.md) |
| Modules and helper APIs | [Components](../COMPONENTS.md), [file map](../codebase-overview.md) |
| Cache identity and performance | [Architecture](../ARCHITECTURE.md), [caching](../caching-and-optimization.md) |
| Secrets, exposure and incidents | [Security](../SECURITY.md), [runbooks](../runbooks/operations.md) |
| External calls | [Operations](../external-calls.md), [generated registry](../operations-registry.json) |
| Constraints and strategy | [Requirements](../requirements.md), [known limits](../known-issues.md) |
| Maintenance evidence | [Bootstrap audit](../repo-bootstrap-audit-2026-11-12.md), [optimizer](../code-deep-optimizer-2026-11-12.md) |

Project strategy: retain a small, local, zero-dependency replay tool for deterministic
workloads. Preserve exact bytes, safe local control, and explicit paid-call boundaries.
Prefer behavioral regressions and current source over historical performance claims.
