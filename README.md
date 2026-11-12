# llm-cache-proxy

A local, zero-dependency reverse proxy for the Anthropic Messages API. Repeated
requests replay the stored response bytes without another upstream call. It fits
reruns, evaluations, CI and scripted development loops. New prompts still cost a
normal API call; normalization and suffix matching are explicit opt-ins.

## Quick start

Use Node 18 or newer to run the tools; use Node 22 or newer for coverage checks.

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git
cd llm-cache-proxy
./cachectl-a.sh setup
./cachectl-a.sh on
export ANTHROPIC_BASE_URL=http://127.0.0.1:4000
export ANTHROPIC_API_KEY=anything
```

Setup stores your real key in the ignored `.env`. For an installed npm or Homebrew
package, use `llm-cache-proxy setup` and `llm-cache-proxy on`; its config lives in
`~/.llm-cache-a/.env`. See [installation](docs/INSTALLATION.md).

## Behavior

- Byte-exact JSON and SSE replay, including tool-use responses.
- Complete successful responses only; interrupted streams never become hits.
- Request coalescing, async cache I/O, TTL and LRU eviction.
- Loopback by default; a non-loopback bind requires `CACHE_AUTH_TOKEN`.
- Session and all-time statistics, Prometheus metrics and a live SSE monitor.
- Optional normalized and suffix keys; suffix mode can return out-of-context data.
- An installed Node CLI, source Bash controller and cache explorer.

The proxy (`proxy-a.mjs`) forwards a cache miss to `api.anthropic.com`, streams the
response to the client and writes a private local cache entry. Exact cache identity
includes the body and relevant HTTP context. [Architecture](docs/ARCHITECTURE.md)
explains identity, coalescing and storage.

## Operate and develop

```bash
./cachectl-a.sh validate
./cachectl-a.sh status
./cachectl-a.sh stats
./cachectl-a.sh monitor
./cachectl-a.sh explore --list
./cachectl-a.sh off       # bypass mode; still forwards paid requests
./cachectl-a.sh stop
npm run validate         # offline mock tests, syntax and documentation checks
```

`npm run test:fidelity` and `python3 bench.py` make live, paid requests. Run them
only deliberately. Built-in dollar rates are estimates; check the provider invoice.

Start with the maintained [project wiki](docs/wiki/README.md), [usage guide](USAGE.md),
[development guide](docs/DEVELOPMENT.md), [test strategy](docs/TESTING.md),
[security model](docs/SECURITY.md) and [contributing guide](CONTRIBUTING.md).
The [bootstrap audit](docs/repo-bootstrap-audit-2026-11-12.md) records adaptations
and the [optimizer report](docs/code-deep-optimizer-2026-11-12.md) records verification.
Licensed under [MIT](LICENSE).
