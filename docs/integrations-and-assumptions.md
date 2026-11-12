# Integrations and assumptions

| Integration | Auth / data flow | Owner |
|---|---|---|
| Anthropic HTTPS Messages API | Real server key; request body out, response bytes in | proxy-a.mjs |
| Local HTTP proxy | Optional x-cache-auth; usage, monitor and paid message routes | controllers, bench.py, fidelity |
| Local filesystem | Operator permissions; config, cache, logs and ledger | runtime modules |
| Node child process / ps | Exact owned proxy process control | lib/controller.mjs, cli.mjs |
| systemd / launchd | Explicit user service installation | cachectl-a.sh |
| GitHub Actions, npm, Homebrew tap | Repository release secrets; tag/release only | .github/workflows |

Default upstream uses TLS on port443. HTTP override is for trusted local test mocks.
The listening proxy itself is HTTP. Shared-token exposure is not multi-tenant auth.
Environment and config are captured at startup; config changes need deliberate restart.
The store lives in the operator home, so separate processes sharing a home share data.
Only one controller-managed instance per home is supported. Pricing defaults are
illustrative historical rates, not current billing guarantees. No external model,
provider or client compatibility claims were refreshed by this offline audit.
