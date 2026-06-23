# llm-cache-proxy

Local-only, **zero-dependency** caching reverse proxy for the Anthropic Messages API.
On an exact-match repeat it replays the byte-identical cached response with **no
upstream call** — 100% token save per hit. Built for rerun / eval / CI / dev-loop
workloads, where the same `/v1/messages` request recurs.

- One Node file, **no dependencies** (`proxy-a.mjs`).
- Starts in **<2s**, no database, no API key juggling (reads `.env`).
- Byte-exact SSE replay (streaming + `tool_use` preserved verbatim).
- **100%-covered** zero-dep unit suite (no network, no paid calls) + a live byte-exact fidelity proof.
- Realtime `/monitor` stream, **this-session + all-time** stats, log verbosity, a cache-explorer TUI.
- Loopback by default; opt-in network bind **gated by an auth token**. Optional boot service (systemd / launchd).

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

Install the `llm-cache-proxy` command via **Homebrew** (`brew tap mithudso/tap && brew install llm-cache-proxy`)
or **npm** (`npm install -g llm-cache-proxy`) — both put the self-contained proxy + CLI on your `PATH`.
For the full control surface (`on`/`off`/`monitor`/`explore`/service install), clone the repo:

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git && cd llm-cache-proxy
./cachectl-a.sh setup                                  # prompts for key + settings, writes .env (chmod 600)
./cachectl-a.sh on                                     # start on :4000 (<2s); auto-runs setup if no key
export ANTHROPIC_BASE_URL=http://localhost:4000        # point Claude Code / SDK at it
export ANTHROPIC_API_KEY=anything                      # client key ignored; .env key is used
```
Control: `./cachectl-a.sh on | off | stop | stats | status | monitor | explore | setup | run | install | uninstall`
(`off` = bypass: forwards, caches nothing).

`npm test` runs the **zero-dep unit suite** against a mock upstream (no network, no key, 100% line/function
coverage of `proxy-a.mjs`); `npm run test:fidelity` runs the **live, paid** byte-exact proof. `bench.py` needs
`anthropic` (`pip install anthropic`).

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

Running counters track **tokens and dollars saved** (cache hits) versus dollars spent (misses), priced **per model**. They seed from the metrics log on boot, so totals survive a restart. `/stats` reports **this-session** (since the process booted) *and* **all-time** (seeded + session) figures:

```bash
curl localhost:4000/stats      # JSON: top-level = all-time; nested .session = this run
curl localhost:4000/metrics    # Prometheus: llm_cache_{hits,misses,tokens_saved,usd_saved,...}_total
curl -N localhost:4000/monitor # realtime SSE: one event per served call (HIT/MISS/…)
./cachectl-a.sh stats          # pretty-prints this-session + all-time; offline, reads the ledger
./cachectl-a.sh status         # process up? accepting calls? cache on/off? last call? errors this run
./cachectl-a.sh monitor        # tails /monitor as readable lines
```

**Log verbosity:** `CACHE_LOG_LEVEL` = `silent` | `error` | `info` (default) | `debug` (`CACHE_QUIET=1` == silent).
Logs tee to stdout **and** a default file (`CACHE_LOG_FILE`, default `~/.llm-cache-a/proxy.log`; `none` disables).

`/metrics` drops straight into Prometheus/Grafana. Pricing is matched by model substring (haiku/sonnet/opus); override or extend it with `~/.llm-cache-a/prices.json` (`{"haiku":[0.8e-6,4e-6]}`).

## Network access & auth

The proxy injects the **real key for any client** that reaches it, so it **binds loopback (`127.0.0.1`) by default**. To expose it on a LAN, set `CACHE_HOST` to a reachable address — which then **requires** `CACHE_AUTH_TOKEN`: `start()` refuses a non-loopback bind without one, and once set, every route except `/health` requires header `x-cache-auth: <token>`. The `setup` wizard generates a token automatically when you pick a non-loopback host.

```bash
CACHE_HOST=0.0.0.0 CACHE_AUTH_TOKEN=$(openssl rand -hex 18) ./cachectl-a.sh on
curl -H "x-cache-auth: <token>" http://<host>:4000/v1/messages ...
```

## Run as a service (start on boot, restart on failure)

```bash
./cachectl-a.sh install      # systemd user unit (Linux) or launchd agent (macOS)
./cachectl-a.sh uninstall    # remove it
./cachectl-a.sh run          # foreground exec (what the service manager calls)
```
Linux gets a systemd **user** unit (`EnvironmentFile=.env`, `Restart=on-failure`, enabled at boot via linger);
macOS gets a launchd agent (`RunAtLoad` + restart-on-failure), which sources `.env` via a small wrapper.

## Cache explorer

```bash
./cachectl-a.sh explore                       # interactive TUI: ↑/↓ browse, enter view, d invalidate, q quit
node cache-explorer.mjs --list                # non-interactive: one row per entry
node cache-explorer.mjs --view <keyPrefix>    # dump an entry's meta + body head
node cache-explorer.mjs --invalidate <keyPrefix>   # delete matching entries
```

## CLI (callable / testable routines)

The proxy's core routines run from the shell (no args = start the server), and are exported for tests:

```bash
node proxy-a.mjs stats                 # print the stats JSON
node proxy-a.mjs price claude-opus-4-8 # [15e-6, 75e-6]
node proxy-a.mjs usage '<text>'        # extract {input_tokens, output_tokens}
node proxy-a.mjs key <model> <body>    # the exact-match cache key
```

## Guardrails

- Only complete `200` responses cached (streaming requires `message_stop`).
- TTL 7d (`CACHE_TTL_SEC`), LRU prune at `CACHE_MAX_ENTRIES` (5000).
- Fail-open: upstream/proxy errors forward to the client; never break a turn.
- Real key lives only in `.env` (gitignored, chmod 600) — never committed.
- **Loopback by default** (`CACHE_HOST=127.0.0.1`); exposing it needs `CACHE_AUTH_TOKEN`.

**Config (env, all optional):** `CACHE_PORT` · `CACHE_HOST` · `CACHE_AUTH_TOKEN` · `CACHE_TTL_SEC` · `CACHE_MAX_ENTRIES` · `CACHE_OFF` · `CACHE_LOG_LEVEL` · `CACHE_LOG_FILE`.

## Correctness & concurrency

Two test layers. **`npm test`** is a zero-dep `node:test` suite that drives the proxy against
a local mock upstream — no network, no key, no paid calls — and enforces **100% line + 100%
function** coverage of `proxy-a.mjs` (hit/miss/coalesce/bypass/expired/prune/seed/auth/monitor/
verbosity + byte-exact multi-chunk SSE replay + session-vs-all-time). **`npm run test:fidelity`**
is the live, **paid** proof: `test-fidelity.mjs` shows **byte-exact cold→warm replay** against the
real API for **streaming SSE**, **tool_use**, **streaming + tool_use**, and request **coalescing**
(a burst of N identical concurrent calls makes exactly **one** upstream call) — **23/23 pass**,
re-verified after the refactor.

Concurrency hardening in `proxy-a.mjs`:

- **Async I/O** — cache reads/writes/prune use `fs/promises`, off the event loop.
- **Request coalescing** — identical in-flight requests share one upstream fetch (no stampede); extras return `x-cache: HIT-COALESCED`.
- **Client-abort guard** — a disconnect tears down the upstream call and never crashes the process; all client writes are guarded.
- **Throttled prune** — entry count tracked in memory; the LRU sweep runs only when the cap is exceeded, not on every write.

A real `claude -p` agent loop was run through the proxy end to end: correct output,
streaming intact, zero proxy errors. The proxy is transparent to live Claude Code.

One caveat that the live loop made concrete: **interactive Claude Code sessions do not get
cross-run cache hits.** Claude Code's request bodies vary run to run (dynamic system prompt
and context), so two "identical" sessions hash to different keys. Cache wins come from
**deterministic, byte-identical repeats** (eval suites, CI, scripted SDK calls, `npm test`),
not from live agent sessions.

## Deprecated: the LiteLLM attempt

`config.yaml`, `config.nocache.yaml`, `callback.py`, `cachectl.sh`, `requirements.txt`
are an abandoned LiteLLM-based attempt, kept for history. LiteLLM was dropped: ~87s
import, >120s flaky startup, the `/v1/messages` passthrough route bypassed the cache
(0% hits), and `master_key`+wildcard routing required a Prisma DB. The hand-rolled
Node proxy (`proxy-a.mjs`) replaced it. Details in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#decision-record-why-hand-rolled-not-litellm).
