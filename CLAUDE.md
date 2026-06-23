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
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-...\n' > .env   # real key; gitignored
./cachectl-a.sh on
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Secrets (hard rule)
The real Anthropic key lives ONLY in `.env` (gitignored). Never commit it; never
write it into any tracked file. `cachectl-a.sh` sources `.env` at start.

## Monitoring
- Per-request structured logs (`HIT`/`MISS`/`ERROR`) to stdout/`proxy.log`; `CACHE_QUIET=1` silences.
- Counters (tokens/dollars saved, per model) seed from `metrics.jsonl` on boot. `GET /stats` (JSON), `GET /metrics` (Prometheus), `cachectl-a.sh stats`. Pricing override: `~/.llm-cache-a/prices.json`.
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
