# Architecture — llm-cache-proxy

## Purpose
Cut Anthropic API token spend on repeated identical calls (reruns, evals, CI, dev
loops). A local reverse proxy in front of `api.anthropic.com` that replays cached
responses with zero upstream calls on exact-match repeats.

## Flow
```
Client (Claude Code / SDK) ──/v1/messages──▶ proxy-a.mjs (localhost:4000)
                                              │  ▲ HIT: replay stored bytes, no upstream call (~0.001s)
                                              │  └── ~/.llm-cache-a/entries/<hash>.{bin,json}
                                              └──MISS──▶ api.anthropic.com (real key from .env)
                                                         tee response → client + cache (200s only)
```

## Cache key
`sha256(model + "\n" + raw request body)`. Exact match only — deterministic, no
semantic/fuzzy matching. Identical request body ⇒ identical key ⇒ replay.

## Store
- `~/.llm-cache-a/entries/<hash>.bin` — raw response bytes (SSE stream verbatim).
- `~/.llm-cache-a/entries/<hash>.json` — meta: timestamp, content-type, usage.
- `~/.llm-cache-a/metrics.jsonl` — one line per call (hit/miss/error) for `stats`.
All outside the repo.

## Guardrails
- **Bypass:** `cachectl-a.sh off` (`CACHE_OFF=1`) forwards everything, caches nothing.
- **TTL:** 7d (`CACHE_TTL_SEC`). **LRU prune** at `CACHE_MAX_ENTRIES` (5000).
- **Only complete 200s cached** (streaming requires `message_stop`).
- **Fail-open:** upstream/proxy errors forward to the client; never break a turn.
- **Plaintext** key in `.env` (gitignored) and plaintext local cache.
- **Dual-stack bind** (`::` ⇒ both `localhost`/::1 and 127.0.0.1).

## Logging & monitoring

- **Per-request log line** on stdout (`HIT`/`MISS`/`ERROR`) with model, tokens, dollars, latency, and the running cumulative-savings tail. `CACHE_QUIET=1` silences it.
- **In-memory counters**: calls, hits, misses, errors, tokens/dollars saved (hits), tokens/dollars spent (misses). Seeded from `metrics.jsonl` at boot so totals survive restarts.
- **Endpoints** (read-only, no auth): `GET /stats` (JSON) and `GET /metrics` (Prometheus text — `llm_cache_*_total`). `/health` unchanged.
- **Per-model pricing**: `$ per token` matched by substring on the model id (haiku/sonnet/opus, default = opus). Override via `~/.llm-cache-a/prices.json`. Dollars are computed at read time, so a price change re-values history.

## Decision record (why hand-rolled, not LiteLLM)
LiteLLM was tried first ("caching built-in") and abandoned:
- `import litellm` ≈ 87s (blocking model-cost-map fetch); full proxy startup >120s, variable.
- `/v1/messages` *passthrough* route bypassed the cache → 0% hits.
- Removing passthrough surfaced `master_key`+wildcard routing requiring a Prisma DB.
- `localhost` (IPv6 ::1) vs uvicorn IPv4 bind caused connection-refused.

Hand-rolled Option A: <2s start, no deps, no DB, byte-exact SSE replay, dual-stack.

## Not yet verified
Streaming + `tool_use` fidelity through a **real Claude Code session** (the bench
covers non-streaming). Byte-exact replay should preserve it; confirm before trusting
on live agent traffic.
