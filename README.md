# llm-cache-proxy

Local-only, **zero-dependency** caching reverse proxy for the Anthropic Messages API.
On an exact-match repeat it replays the byte-identical cached response with **no
upstream call** — 100% token save per hit. Built for rerun / eval / CI / dev-loop
workloads, where the same `/v1/messages` request recurs.

- One Node file, **no dependencies** (`proxy-a.mjs`).
- Starts in **<2s**, no database, no API key juggling (reads `.env`).
- Byte-exact SSE replay (streaming + `tool_use` preserved verbatim).

## Measured token savings

Side-by-side, 5 identical `/v1/messages` calls (Haiku) through the proxy, cache ON
vs bypass (`cachectl-a.sh off`). Measured via `bench.py` + the proxy ledger:

| Metric | Cache **OFF** (bypass) | Cache **ON** |
|---|---|---|
| Hit rate | 0% | **80%** |
| Upstream calls (for 5 identical) | 5 | **1** |
| Tokens billed | all 5 calls | **1 call** (4 served free) |
| Tokens saved (ledger) | 0 | **296** |
| Warm-call latency | **1.141 s** | **0.001 s** (~1000× faster) |

**Savings ≈ your full-call repeat rate.** With N identical calls the cache eliminates
(N−1) of them — here 4/5 = 80%. On a rerun/eval/CI suite that re-issues the same
prompts, that is a direct ~80%+ cut in tokens *and* latency on the repeated portion.

Caveat: only **exact full-call repeats** hit. Novel calls (different messages) are
never cached — so interactive, always-different traffic sees little benefit. This is a
rerun/eval/CI optimizer, not a general speedup. (`bench.py`'s own "saved %" line is a
client-side artifact — a cached response still carries usage numbers, so the SDK can't
tell it was free; the proxy ledger and the 0.001 s latency are ground truth.)

Reproduce:
```bash
./cachectl-a.sh on
.venv/bin/python bench.py --identical 5 --varied 0 --model claude-haiku-4-5-20251001 \
  --base-url http://localhost:4000
./cachectl-a.sh stats          # hit rate + tokens/$ saved
```

## Setup

Needs Node ≥ 18 and a real Anthropic key. No build step, no `npm install`.

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git && cd llm-cache-proxy
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-...\n' > .env   # your real key; gitignored
./cachectl-a.sh on                                    # start on :4000 (<2s)
export ANTHROPIC_BASE_URL=http://localhost:4000        # point Claude Code / SDK at it
export ANTHROPIC_API_KEY=anything                      # client key ignored; .env key is used
```
Control: `./cachectl-a.sh on | off | stop | stats` (`off` = bypass: forwards, caches nothing).
`npm test` runs the fidelity proof; `bench.py` needs `anthropic` (`pip install anthropic`).

**Full guide:** [docs/INSTALL.md](docs/INSTALL.md) — prerequisites, configuration (env vars, per-model pricing), client setup, monitoring, troubleshooting, uninstall.

## How it works

Reverse proxy in front of `api.anthropic.com`. Exact-match key =
`sha256(model + raw request body)`. HIT → replay stored bytes, zero upstream call.
MISS → forward with the real key, tee the response to client + cache (complete 200s only).
Cache + metrics live in `~/.llm-cache-a/` (outside the repo). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Logging & monitoring

Every request emits one structured log line on stdout (captured in `~/.llm-cache-a/proxy.log`):

```
HIT  claude-haiku-4-5-20251001  +76tok $0.00025  | saved $0.0007 / 228tok  hit-rate 33.3%
MISS claude-haiku-4-5-20251001  200  274tok $0.00104  3951ms [cached]  | spend $0.0013
```

Running counters track **tokens and dollars saved** (cache hits) versus dollars spent (misses), priced **per model**. They seed from the metrics log on boot, so totals survive a restart. Two read-only endpoints expose them:

```bash
curl localhost:4000/stats      # JSON: calls, hits, hit_rate_pct, tokens_saved, usd_saved, usd_spent, savings_pct
curl localhost:4000/metrics    # Prometheus: llm_cache_{hits,misses,tokens_saved,usd_saved,...}_total
./cachectl-a.sh stats          # pretty-prints /stats when the proxy is up; else reads the log
```

`/metrics` drops straight into Prometheus/Grafana. Pricing is matched by model substring (haiku/sonnet/opus); override or extend it with `~/.llm-cache-a/prices.json` (`{"haiku":[0.8e-6,4e-6]}`). Set `CACHE_QUIET=1` to silence per-request logs (endpoints still work).

## Guardrails

- Only complete `200` responses cached (streaming requires `message_stop`).
- TTL 7d (`CACHE_TTL_SEC`), LRU prune at `CACHE_MAX_ENTRIES` (5000).
- Fail-open: upstream/proxy errors forward to the client; never break a turn.
- Real key lives only in `.env` (gitignored) — never committed.
- Dual-stack bind: both `localhost` (::1) and `127.0.0.1` work.

## Correctness & concurrency

`test-fidelity.mjs` (`npm test`, with the proxy up + a real key) proves **byte-exact
cold→warm replay** against the live API for **streaming SSE**, **tool_use**, and
**streaming + tool_use**, and proves request **coalescing**: a burst of N identical
concurrent calls makes exactly **one** upstream call. Latest run: **23/23 pass**.

Concurrency hardening in `proxy-a.mjs`:

- **Async I/O** — cache reads/writes/prune use `fs/promises`, off the event loop.
- **Request coalescing** — identical in-flight requests share one upstream fetch (no stampede); extras return `x-cache: HIT-COALESCED`.
- **Client-abort guard** — a disconnect tears down the upstream call and never crashes the process; all client writes are guarded.
- **Throttled prune** — entry count tracked in memory; the LRU sweep runs only when the cap is exceeded, not on every write.

The only check left is a full live Claude Code agent loop end to end; the protocol-level
fidelity it relies on is proven above.

## Deprecated: the LiteLLM attempt

`config.yaml`, `config.nocache.yaml`, `callback.py`, `cachectl.sh`, `requirements.txt`
are an abandoned LiteLLM-based attempt, kept for history. LiteLLM was dropped: ~87s
import, >120s flaky startup, the `/v1/messages` passthrough route bypassed the cache
(0% hits), and `master_key`+wildcard routing required a Prisma DB. The hand-rolled
Node proxy (`proxy-a.mjs`) replaced it. Details in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#decision-record-why-hand-rolled-not-litellm).
