# Technical Review: llm-cache-proxy

This review evaluates **llm-cache-proxy**, a zero-dependency local caching proxy for the Anthropic Messages API. It is written for an engineer deciding whether to adopt the tool, extend it, or trust it on live agent traffic. It covers design, the implementation in `proxy-a.mjs`, the measured benchmark, observability, security posture, and the boundaries of where the tool earns its keep. It is not a usage guide (the README covers that) or a security audit.

_Updated 2026-06-23: logging & monitoring (PR #2), then concurrency hardening and a streaming/tool_use fidelity proof (PR #3). Code references use function names, since line numbers move across rewrites._

## Verdict

The proxy is an excellent fit for the job it claims: cutting Anthropic token spend on repeated identical calls in rerun, eval, CI, and dev-loop work. It does one thing, does it correctly by construction, and stays small enough to read in five minutes. The benchmark backs the claim: 80% of a five-call identical workload was served from disk with no upstream request and roughly 1000× lower latency.

The same minimalism caps its range: it saves nothing on traffic that never repeats. The earlier robustness and fidelity gaps are now closed. Streaming and `tool_use` replay are proven byte-exact against the live API, and a burst of identical concurrent calls makes exactly one upstream call. Adopt it for batch and rerun workloads. A live Claude Code agent loop confirms the proxy is transparent and correct end to end. It also shows that interactive agent sessions rarely cache, because Claude Code's request bodies vary run to run, so the savings live in deterministic reruns rather than live sessions.

## What it solves

Anthropic bills every call. When the same `/v1/messages` request runs again, that spend repeats. A local reverse proxy can short-circuit the repeat: hash the request, store the first response, and replay it byte for byte on the next identical call with no upstream request at all. That is a 100% saving on the repeated call, not the ~90% input discount that server-side prompt caching gives.

The design is honest about the catch. The win equals the full-call repeat rate. Reruns, evals, and CI repeat constantly; interactive chat almost never does. The tool is scoped to the former and says so.

## Architecture and design

The shape is correct for the problem. One Node process sits in front of `api.anthropic.com`. Claude Code points `ANTHROPIC_BASE_URL` at it. The cache key is `sha256(model + raw request body)`: exact match only, no semantic or fuzzy matching, which keeps replay deterministic and removes a whole class of "close but wrong" failures.

Two decisions stand out as good engineering:

- **Byte-exact replay.** The proxy stores the raw upstream bytes and re-sends them unchanged. It never re-serializes the response. That is why streaming and `tool_use` framing are preserved in principle. It is also the decisive advantage over the abandoned LiteLLM approach, which normalized through an OpenAI-shaped core and dropped cache hits on the passthrough route.
- **Stripping `accept-encoding` before forwarding** (in `fetchUpstream`). This forces plaintext SSE from upstream, so stored bytes never carry a gzip encoding that a later replay would fail to declare. A subtle correctness fix that prevents a nasty class of replay bug. The cost is lost wire compression, which is the right trade for a localhost-to-cache hop.

Storage is plain files under `~/.llm-cache-a/`: one `.bin` per response, one `.json` of metadata, plus an append-only `metrics.jsonl` that doubles as the seed for the in-memory savings counters at startup. Request bodies are hashed, never written, so prompts do not land on disk in plaintext. Responses do.

## Implementation review

The code is clean, flat, and auditable: about 230 lines (up from 125; logging, monitoring, and concurrency hardening landed since), still no dependencies beyond Node built-ins. The control surface (`cachectl-a.sh`), the benchmark (`bench.py`), and the fidelity test (`test-fidelity.mjs`) are equally direct.

Strengths worth naming:

- **Fail-open** (`fetchUpstream` error handler). Any upstream error returns a 502 and never caches the failure. The cache cannot corrupt a turn or wedge the client.
- **Cache only complete 200s** (the `complete` check in `fetchUpstream`). Streaming responses must contain `message_stop` before they are stored, so a truncated stream is never replayed as if whole.
- **Dual-stack bind** (`server.listen`). Listening on `::` accepts both `localhost` (IPv6 `::1`) and `127.0.0.1`. This directly fixes the connection-refused trap that sank the LiteLLM attempt, where uvicorn bound IPv4 only.
- **Request coalescing** (the `inflight` map across `handle`/`fetchUpstream`). Identical concurrent requests share one upstream fetch; the burst test proves six simultaneous identical calls make exactly one upstream call. Entries stay until the cache write lands, so a follow-up never re-fetches.
- **Client-abort guard** (the `safe()` write wrapper plus `res 'close'` → `up.destroy()`). A mid-stream disconnect tears down the upstream call and cannot crash the process.
- **Async I/O** (`fs/promises` throughout the hot path) so disk reads, writes, and the prune never block the event loop.
- **Observability built in** (the `/stats` and `/metrics` handlers). Per-request logs (`HIT`/`MISS`/`ERROR`) carry model, tokens, dollars, and latency with a running savings tail. `GET /stats` (JSON) and `GET /metrics` (Prometheus) expose cumulative tokens- and dollars-saved counters, priced per model and seeded from the metrics log on boot so totals survive a restart.
- **Clear guardrails.** A global bypass (`CACHE_OFF`) and a per-request `x-cache-bypass` header, a 7-day TTL, and a throttled LRU prune.

Gaps, by severity. The two Majors and three concurrency Minors from earlier drafts are resolved (see Recommendations); what remains are two nits that do not affect correctness:

| Severity | Issue | Detail |
|---|---|---|
| Nit | Age-based eviction missing | TTL is checked on read; expired files are not collected until the count cap forces an LRU pass. Stale files linger. |
| Nit | Unbounded `metrics.jsonl` | Append-only with no rotation; read in full on every boot to seed the counters, so a very large log slows startup. |

Neither nit matters for the single-user target.

## Performance

The side-by-side is convincing because it compares against the right baseline (cache bypass, not "nothing"):

| Metric | Cache OFF | Cache ON |
|---|---|---|
| Hit rate | 0% | 80% |
| Upstream calls (5 identical) | 5 | 1 |
| Warm-call latency | 1.141 s | 0.001 s |
| Tokens saved | 0 | 296 |

Read it correctly: savings track the repeat rate, and the 80% here is simply (N−1)/N for five identical calls. The latency delta is the more durable result. A served hit costs a disk read and returns in about a millisecond, which makes the proxy useful as a fast local replay layer for eval suites even where the token saving is secondary. One honest footnote, already in the README: `bench.py`'s own "saved %" line reads 0% because a cached response still carries usage numbers, so the client SDK cannot tell the call was free. The proxy ledger and the latency are the ground truth, and that ledger is now a live endpoint: `/stats` reports cumulative tokens and dollars saved, priced per model.

## Live-agent loop

A real `claude -p` session was run twice through the proxy with an identical prompt. Both runs returned the correct answer with streaming intact and zero proxy errors, so the proxy is transparent to a live Claude Code agent loop. Both responses were stored (complete 200s), yet the second run was a MISS, not a hit. Claude Code's request bodies are not byte-identical across runs (dynamic system prompt and context), so the two turns hashed to different keys.

That sharpens the tool's scope. Exact-match caching hits deterministic, byte-identical repeats: eval suites, CI, scripted SDK calls, the fidelity test. It does not hit interactive or agent sessions, where each turn's context differs. This matches the design's stated scope; the live test makes the boundary concrete and is worth stating plainly in the README so users do not expect savings from live sessions.

## Security posture

Acceptable for localhost single-user, and the README does not overclaim. Three properties to keep in view:

- **No client authentication.** Any process that can reach `localhost:4000` can spend the real key, which `fetchUpstream` injects from `.env`. Fine on a personal machine, not on a shared host.
- **Unauthenticated monitoring endpoints.** `/stats` and `/metrics` are open. They expose usage counters and dollar figures but no secrets and no prompt or response content. Acceptable on localhost; gate them behind auth or a private bind address before exposing the proxy on a network.
- **Plaintext at rest.** The key lives in `.env` (gitignored), and cached responses sit unencrypted under `~/.llm-cache-a/`. Prompts are not persisted, which softens the exposure, but response bodies can still be sensitive.
- **Secret hygiene in the repo is sound.** Every commit in this project was gated against staging `.env` or a real key, and the history is clean.

## Engineering judgment: the LiteLLM pivot

The decision record deserves credit independent of the code. The project first reached for LiteLLM on the reasonable theory that built-in caching beats hand-rolled. It then hit a wall of compounding problems: an 87-second import, flaky 120-second-plus startup, a passthrough route that bypassed the cache, a wildcard-routing path that demanded a database, and the IPv4 `localhost` mismatch. Rather than keep patching, the author measured, called it, and rewrote the whole thing as 125 dependency-free lines that start in under two seconds. Choosing the heavy tool first was defensible; abandoning it on evidence was the right call. The README preserves the reasoning instead of hiding it, which is exactly how a decision record should work.

## Recommendations

In priority order:

1. **Bound the metrics log and add age-based eviction** so an always-on instance stays tidy. This matters more now that boot reads the whole log to seed the counters.
2. **Authenticate `/metrics` and `/stats`** (or bind them to loopback only) before the proxy is ever exposed beyond localhost.
3. **State the agent-session caching limit in the README.** The live loop confirmed transparency, but interactive Claude Code sessions do not get cross-run cache hits (request bodies vary run to run). Say so plainly so users expect savings only from deterministic reruns.

**Resolved since the first draft:**

- **Streaming + `tool_use` fidelity (was Major):** `test-fidelity.mjs` proves byte-identical cold→warm replay against the live API for streaming SSE, tool_use, and streaming+tool_use (23/23 pass).
- **Live-agent loop (was the last open item):** a real `claude -p` session runs correctly through the proxy with streaming intact and zero errors; end-to-end transparency confirmed. (It also surfaced the agent-session caching limit above.)
- **Client-abort crash (was Major):** guarded writes plus upstream teardown on disconnect.
- **Concurrency (was three Minors):** async `fs/promises` I/O, request coalescing (a 6-way identical burst makes exactly one upstream call, proven), and a throttled prune.
- **Earlier (PR #2):** per-model pricing for `usd_saved`, structured logging, and the `/stats` + `/metrics` endpoints.

## Scorecard

| Dimension | Rating | Note |
|---|---|---|
| Fit for stated purpose | Excellent | Exact-match rerun/eval/CI caching, done right |
| Code clarity | Excellent | ~230 lines, zero deps, readable in one sitting |
| Correctness (non-streaming) | Strong | Complete-200-only, fail-open, byte-exact |
| Correctness (streaming/tool_use) | Proven | Byte-exact replay verified live (23/23): streaming, tool_use, streaming+tool_use |
| Robustness under concurrency | Strong | Async I/O, coalescing (1 upstream call per burst, proven), abort guard, throttled prune |
| Observability | Strong | Structured logs, `/stats` + `/metrics`, per-model tokens/dollars-saved counters, restart-seeded |
| Security (single-user) | Adequate | No client auth, unauth metrics endpoints, plaintext at rest, clean secret hygiene |
| Documentation | Strong | Honest scope, measured numbers, preserved decision record |

## Appendix: install & use

Single user, macOS or Linux. Needs **Node ≥ 18** and a real Anthropic key. No build step, no `npm install`. Full guide: `docs/INSTALL.md`.

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git && cd llm-cache-proxy
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-your-key\n' > .env   # gitignored; never commit
./cachectl-a.sh on                                          # start on :4000 (<2s)
export ANTHROPIC_BASE_URL=http://localhost:4000             # point Claude Code / SDK at it
export ANTHROPIC_API_KEY=anything                           # client key ignored; .env key is used
```

Operate: `./cachectl-a.sh on | off | stop | stats` (`off` = bypass). Verify with `npm test`
(fidelity proof, expects 23/23) and `curl localhost:4000/stats` (live tokens/dollars saved).
Configuration is via env vars (`CACHE_PORT`, `CACHE_TTL_SEC`, `CACHE_MAX_ENTRIES`, `CACHE_QUIET`)
and `~/.llm-cache-a/prices.json` for per-model pricing; data lives under `~/.llm-cache-a/`.

**Bottom line.** A sharp, well-scoped utility that does the hard part (faithful replay) correctly and provably, tracks its own token and dollar savings, and tells the truth about its limits. Both prior blockers are cleared: streaming and `tool_use` replay are verified byte-exact, and concurrency is hardened (coalescing, async I/O, abort guard). Ship it for batch and rerun workloads. The live agent loop confirms end-to-end transparency; just do not expect interactive sessions to cache, since their request bodies vary run to run.
