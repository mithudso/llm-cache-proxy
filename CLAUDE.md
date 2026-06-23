# CLAUDE.md — llm-cache-proxy

Local-only, zero-dependency caching reverse proxy for the Anthropic Messages API
(`/v1/messages`). On an exact-match repeat it replays the byte-identical cached
response with **no upstream call** → 100% token save per hit. Built for
rerun/eval/CI/dev-loop workloads (high full-call repeat rate).

## Canonical implementation
- `proxy-a.mjs` — the proxy (Node, **zero dependencies**: `node:http/https/crypto/fs`).
- `cachectl-a.sh` — control: `on` | `off` (bypass) | `stop` | `stats`.
- `bench.py` — measures savings (needs `pip install anthropic`; not required to run the proxy).

## Deprecated (do not extend)
`config.yaml`, `config.nocache.yaml`, `callback.py`, `cachectl.sh`, `requirements.txt`
are the abandoned LiteLLM attempt, kept for history. LiteLLM was dropped: ~87s import,
>120s flaky startup, the `/v1/messages` passthrough route bypassed the cache, and
master_key+wildcard routing required a Prisma DB. See docs/ARCHITECTURE.md.

## Run
```bash
./cachectl-a.sh setup          # first run: prompts for the key + settings, writes .env (chmod 600)
./cachectl-a.sh on             # `on` also auto-runs setup if the key is missing on a TTY
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Control surface (`cachectl-a.sh`)
`on` | `off` (bypass) | `stop` | `stats` | `status` | `monitor` | `explore` | `setup` | `run` | `install` | `uninstall`.
- `monitor` — realtime view: tails `GET /monitor` (SSE), one line per call (HIT/MISS/…).
- `explore` — cache explorer TUI (`node cache-explorer.mjs`): browse entries, view, invalidate; non-interactive `--list`/`--json`/`--view <key>`/`--invalidate <key>`.
- `run` — foreground exec for a service manager. `install`/`uninstall` — boot service with restart-on-failure (systemd user unit on Linux, launchd agent on macOS).

## CLI (callable/testable routines)
`node proxy-a.mjs <cmd>` (no args = start the server): `stats` | `price <model>` | `usage <text>` | `key <model> <body>`. The same routines are exported (`usageFrom`, `priceFor`, `usd`, `statsObj`).

## Config (env, all optional)
`CACHE_PORT` (4000) · `CACHE_HOST` (127.0.0.1; loopback-only by default) · `CACHE_AUTH_TOKEN` (required to bind a non-loopback host; then clients must send `x-cache-auth`) · `CACHE_TTL_SEC` (604800) · `CACHE_MAX_ENTRIES` (5000) · `CACHE_OFF` (1=bypass) · `CACHE_LOG_LEVEL` (silent|error|info|debug; `CACHE_QUIET=1`==silent) · `CACHE_LOG_FILE` (default `~/.llm-cache-a/proxy.log`; `none` disables).

## Secrets (hard rule)
The real Anthropic key lives ONLY in `.env` (gitignored, chmod 600). Never commit it; never
write it into any tracked file. `cachectl-a.sh` sources `.env` at start.

## Security
The proxy injects the real key for ANY client that reaches it, so it binds **loopback by default**.
Exposing it (`CACHE_HOST=0.0.0.0`) **requires** `CACHE_AUTH_TOKEN` — `start()` refuses otherwise — and
then enforces `x-cache-auth` on every route except `/health`.

## Monitoring
- Per-request structured logs (`HIT`/`MISS`/`ERROR`/`DEBUG`) to stdout + `CACHE_LOG_FILE`, gated by `CACHE_LOG_LEVEL`.
- Counters (tokens/dollars saved, per model) seed from `metrics.jsonl` on boot. `GET /stats` (JSON — **this-session + all-time**), `GET /metrics` (Prometheus), `GET /monitor` (live SSE), `cachectl-a.sh stats`. Pricing override: `~/.llm-cache-a/prices.json`.
- `cachectl-a.sh status` — operational snapshot: process up + start time, accepting-calls (via `/health`), cache on/off (via `/stats`), last call received (newest `metrics.jsonl` timestamp), and error count + recent `proxy.log` lines since this run started.

## Concurrency & tests
- Async I/O, in-flight request coalescing (no stampede), client-abort guard, throttled LRU prune.
- `npm test` runs the `proxy*.test.mjs` `node:test` suite against a local mock upstream (no network, no key) and enforces **100% line + 100% function** coverage of `proxy-a.mjs` (zero-dep, built-in coverage); branch is gated ≥99% (V8 block coverage is 100% — the ~1% gap is one logical `||`/`?:` sub-branch the runner's branch model can't attribute). Shared harness: `test-helpers.mjs`. Defensive I/O-error swallows and the production-only entrypoint are excluded via `node:coverage` comments. Coverage incl. byte-exact multi-chunk SSE replay + session/all-time stats. (Test suite needs **Node ≥22** for built-in coverage; the proxy itself still runs on **Node ≥18**.)
- `npm run test:fidelity` runs `test-fidelity.mjs` — byte-exact cold→warm replay for streaming, tool_use, streaming+tool_use, and coalescing. Live & **paid**: needs the proxy up + a real key.
- `proxy-a.mjs` exports `start`/`createServer`/`requestHandler` and auto-starts only as the process entry point; tests inject a mock upstream via `CACHE_UPSTREAM_HOST`/`CACHE_UPSTREAM_PORT`/`CACHE_UPSTREAM_PROTO`.

## Notes
- Cache store + metrics live in `~/.llm-cache-a/` (outside the repo).
- Exact-match key = `sha256(model + "\n" + raw request body)`. No semantic matching.
- Only complete 200 responses are cached (streaming requires `message_stop`). Fail-open.
- Dual-stack bind so both `localhost` (::1) and `127.0.0.1` work.
