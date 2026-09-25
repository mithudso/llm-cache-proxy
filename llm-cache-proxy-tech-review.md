# Technical Review: llm-cache-proxy

This review evaluates **llm-cache-proxy**, a zero-dependency local caching proxy for the Anthropic Messages API. It is written for an engineer deciding whether to adopt the tool, extend it, or trust it on live agent traffic. It covers design, the implementation in `proxy-a.mjs`, the measured benchmark, observability, security posture, and the boundaries of where the tool earns its keep. It is not a usage guide (the README covers that) or a security audit.

_Updated 2026-06-24 (v2.0.2): logging & monitoring (PR #2), concurrency hardening + a streaming/tool_use fidelity proof (PR #3), npm/CLI install packaging (PR #5), then a major feature pass (PR #6) shipped as **v2.0.0** (PR #8) — refactored the proxy into an importable, **100%-unit-tested** module with loopback-default bind + token auth, log verbosity, a realtime `/monitor` SSE stream, this-session vs all-time stats, a first-run setup wizard, boot-service install (systemd/launchd), a cache-explorer TUI, and a CLI for the core routines; installs via npm (`npm i -g llm-cache-proxy`) or Homebrew (`brew tap mithudso/tap`). **v2.0.1** (PRs #10–12) added a USAGE.md quick-reference guide (surfaced by `cachectl-a.sh -h/--help`), fixed a macOS bash 3.2 crash in `cachectl-a.sh` when `CACHE_AUTH_TOKEN` is unset (`AUTH_HDR[@]: unbound variable` under `set -u`), and formally deleted the deprecated LiteLLM stack files (cachectl.sh, callback.py, config.yaml, requirements.txt), leaving only the decision record in docs/ARCHITECTURE.md. **v2.0.2** (PR #13) fixed three launchd reliability bugs surfaced by a real system reboot: `_stop()` now unloads the plist before killing (eliminating the `EADDRINUSE` race from `KeepAlive` restarting too fast), `status` falls back to `pgrep` and auto-heals the pidfile when launchd restarts give the process a new PID, and the plist writes `$$` before `exec node` so the pidfile stays correct across reboots; also added a monotonic `seq` call counter and 80-char response `snippet` to every `/monitor` broadcast. The live fidelity proof was re-run against the real API (23/23) to confirm no behavior drift. **v2.0.3** (PR #15) adds optional partial caching: a `normalizeBody()` function strips configurable regex patterns from the system prompt and message content before hashing, producing a normalized key (tier 2, `HIT-NORM`); with `suffix_only: true`, a third key tier (`HIT-SUFFIX`) is built from only the last N messages, ignoring conversation history. Both tiers write alias files on MISS so future normalized-equivalent requests hit. The test suite grew from 29 to 43 tests across three new files (proxy-normalize, proxy-normalize-defaults, proxy-suffix). **v2.0.4** (PRs #18–19) added a first-run interactive setup wizard to `cli.mjs` (auto-invoked on `on` when the key is missing, writes `~/.llm-cache-a/.env`) and documented hard `.env` paths for each install method. **v2.0.5** (PR #20) adds `restart` (stop-then-start) and `validate` (config syntax + runtime liveness) to both `cli.mjs` and `cachectl-a.sh`. **v2.0.6** adds `normalize.json.example` — a recommended partial-cache config covering current-date lines, UUID, Session-ID, and `<tool_result>` patterns common in Claude Code sessions — and `test-normalize-example.mjs`, a 12-case mock-upstream test suite that verifies all example patterns produce `HIT-NORM` without false positives. Code references use function names, since line numbers move across rewrites._

## Verdict

The proxy is an excellent fit for the job it claims: cutting Anthropic token spend on repeated identical calls in rerun, eval, CI, and dev-loop work. It does one thing, does it correctly by construction, and stays small enough to read in one sitting. The benchmark backs the claim: 80% of a five-call identical workload was served from disk with no upstream request and roughly 1000× lower latency.

The same minimalism caps its range: it saves nothing on traffic that never repeats. The earlier robustness and fidelity gaps are closed and now **regression-proofed by a 100%-covered unit suite** that needs no network or key. Streaming and `tool_use` replay are proven byte-exact against the live API, and a burst of identical concurrent calls makes exactly one upstream call. The latest pass also matured the operational surface (auth, service install, realtime monitor, cache explorer) without touching the byte-exact core. Adopt it for batch and rerun workloads. A live Claude Code agent loop confirms the proxy is transparent and correct end to end. It also shows that interactive agent sessions rarely cache, because Claude Code's request bodies vary run to run, so the savings live in deterministic reruns rather than live sessions.

## What it solves

Anthropic bills every call. When the same `/v1/messages` request runs again, that spend repeats. A local reverse proxy can short-circuit the repeat: hash the request, store the first response, and replay it byte for byte on the next identical call with no upstream request at all. That is a 100% saving on the repeated call, not the ~90% input discount that server-side prompt caching gives.

The design is honest about the catch. The win equals the full-call repeat rate. Reruns, evals, and CI repeat constantly; interactive chat almost never does. The tool is scoped to the former and says so.

## Architecture and design

The shape is correct for the problem. One Node process sits in front of `api.anthropic.com`. Claude Code points `ANTHROPIC_BASE_URL` at it. Cache lookup now uses three key tiers attempted in order:

| Tier | Key | Label | Active when |
|---|---|---|---|
| 1 — exact | `sha256(model + raw body)` | `HIT` | always |
| 2 — normalized | `sha256(model + normalize(body))` | `HIT-NORM` | `normalize.json` present |
| 3 — suffix | `sha256(model + system_norm + messages[-N:])` | `HIT-SUFFIX` | `suffix_only: true` |

Tier 1 is exact match: no semantic or fuzzy matching, deterministic replay, no "close but wrong" failures. Tiers 2–3 trade some replay confidence for higher hit rates on structured, partially-dynamic workloads. A MISS writes cache files under all active alias keys so subsequent requests at tiers 2–3 can hit without a second upstream call.

Two decisions stand out as good engineering:

- **Byte-exact replay.** The proxy stores the raw upstream bytes and re-sends them unchanged. It never re-serializes the response. That is why streaming and `tool_use` framing are preserved in principle. It is also the decisive advantage over the abandoned LiteLLM approach, which normalized through an OpenAI-shaped core and dropped cache hits on the passthrough route.
- **Stripping `accept-encoding` before forwarding** (in `fetchUpstream`). This forces plaintext SSE from upstream, so stored bytes never carry a gzip encoding that a later replay would fail to declare. A subtle correctness fix that prevents a nasty class of replay bug. The cost is lost wire compression, which is the right trade for a localhost-to-cache hop.

Storage is plain files under `~/.llm-cache-a/`: one `.bin` per response, one `.json` of metadata, plus an append-only `metrics.jsonl` that doubles as the seed for the in-memory savings counters at startup. Request bodies are hashed, never written, so prompts do not land on disk in plaintext. Responses do.

The latest refactor made the module **importable without side effects**: `start`/`createServer`/`requestHandler` are exported, the listen/seed/key-check run only behind a portable entry-point guard (a `realpath(argv[1])` check that works on Node ≥18, where `import.meta.main` would not), and the upstream target is injectable via `CACHE_UPSTREAM_*`. This is what lets the unit suite drive the real code paths against a local mock with no network and no key — the testability change carries no production cost because every default is unchanged.

## Implementation review

The code is clean, flat, and auditable: about 450 lines (the bind/auth gate, verbosity, default log file, the `/monitor` broadcaster, session-vs-all-time stats, the CLI dispatch, and inline docs all landed with v2.0.0; v2.0.3 added `normalizeBody()`, alias-key computation in `handle()`, and alias writes in `fetchUpstream()`), still no dependencies beyond Node built-ins. `cli.mjs` grew proportionally with the first-run setup wizard (`v2.0.4`) and the `restart`/`validate` commands (`v2.0.5`). The control surface (`cachectl-a.sh`), the cache explorer (`cache-explorer.mjs`), the benchmark (`bench.py`), the fidelity test (`test-fidelity.mjs`), and the new USAGE.md quick-reference guide are equally direct.

Strengths worth naming:

- **Fail-open** (`fetchUpstream` error handler). Any upstream error returns a 502 and never caches the failure. The cache cannot corrupt a turn or wedge the client.
- **Cache only complete 200s** (the `complete` check in `fetchUpstream`). Streaming responses must contain `message_stop` before they are stored, so a truncated stream is never replayed as if whole. The unit suite covers the incomplete-stream path explicitly.
- **Loopback by default, auth to expose** (`start` + the `requestHandler` gate). The proxy injects the real key for any client, so it binds `127.0.0.1` by default and *refuses* to bind a non-loopback host without `CACHE_AUTH_TOKEN`; with a token, every route but `/health` requires `x-cache-auth`. This is a security tightening over the previous all-interfaces `listen(port)`.
- **Request coalescing** (the `inflight` map across `handle`/`fetchUpstream`). Identical concurrent requests share one upstream fetch; the burst test proves six simultaneous identical calls make exactly one upstream call. Entries stay until the cache write lands, so a follow-up never re-fetches.
- **Client-abort guard** (the `safe()` write wrapper plus `res 'close'` → `up.destroy()`). A mid-stream disconnect tears down the upstream call and cannot crash the process.
- **Async I/O** (`fs/promises` throughout the hot path) so disk reads, writes, and the prune never block the event loop.
- **Observability built in.** Per-request logs (`HIT`/`MISS`/`ERROR`/`DEBUG`) carry model, tokens, dollars, and latency, gated by `CACHE_LOG_LEVEL` and tee'd to a default log file. `GET /stats` reports **this-session and all-time** counters (priced per model, seeded from the metrics log on boot), `GET /metrics` exposes Prometheus, and `GET /monitor` is a realtime SSE feed of every served call — each event now includes a monotonic `seq` counter and an 80-char response `snippet` so the monitor confirms both call order and content at a glance. `cachectl-a.sh status` adds an operational snapshot (process, liveness, last call, errors this run) with pgrep fallback when the pidfile is stale.
- **Operability.** A first-run `setup` wizard writes a chmod-600 `.env`; `on` auto-prompts for the key on first run (v2.0.4, TTY only) so no separate setup step is required. `restart` stops then starts cleanly. `install`/`uninstall` register a boot service with restart-on-failure (systemd user unit on Linux, launchd agent on macOS); a `cache-explorer.mjs` TUI browses and invalidates entries (with scriptable `--list`/`--json`/`--view`/`--invalidate`). On macOS, three launchd reliability bugs were found on a real system reboot and fixed in v2.0.2: the `EADDRINUSE` race (`KeepAlive` restarting before the port freed), stale pidfile after reboot (launchd assigns a new PID that the file doesn't reflect), and `stop` failing to prevent an immediate launchd restart.
- **Config + runtime validation.** `validate` (`llm-cache-proxy validate` or `./cachectl-a.sh validate`) checks all config files for syntax errors — `ANTHROPIC_API_KEY_REAL` present and well-formed, `CACHE_PORT` in range, `normalize.json` valid JSON with compiling regex patterns, `prices.json` valid schema — then, if the proxy is running, hits `/health`, `/stats`, and `/metrics` and reports the outcome. Exits 0 on all-pass, 1 on any error. Safe to use in CI or boot scripts to catch misconfigurations before they surface as runtime failures.
- **Callable/testable routines.** `node proxy-a.mjs stats|price|usage|key` runs the core functions from the shell; the same functions are exported for import.
- **Clear guardrails.** A global bypass (`CACHE_OFF`) and a per-request `x-cache-bypass` header, a 7-day TTL, and a throttled LRU prune.
- **Optional partial caching.** `normalizeBody()` strips configurable regex patterns from system prompt and message content, producing a normalized key (tier 2). With `suffix_only: true`, a tier-3 key uses only the last N messages, enabling hits across sessions that share a recent context. Both tiers are disabled by default (no `normalize.json`); tier 3 is gated behind an explicit flag because ignoring conversation history risks replaying a response out of context. Alias files written on MISS keep the fast path intact: tier-1 hits are unaffected, and tiers 2–3 add at most two extra `readFile` calls on tier-1 miss before falling through to upstream.

Gaps, by severity. The two Majors and three concurrency Minors from earlier drafts are resolved, and the earlier auth/exposure recommendation is now addressed by the loopback-default + token gate. What remains are two nits that do not affect correctness:

| Severity | Issue | Detail |
|---|---|---|
| Nit | Age-based eviction missing | TTL is checked on read; expired files are not collected until the count cap forces an LRU pass. Stale files linger. |
| Nit | Unbounded `metrics.jsonl` | Append-only with no rotation; read in full on every boot to seed the counters, so a very large log slows startup. |

Neither nit matters for the single-user target.

## Testing

Two layers, deliberately separated by cost. **`npm test`** is a zero-dependency `node:test` suite (**43 tests** across 12 files) that drives the *real* proxy code against a local HTTP mock upstream (via the `CACHE_UPSTREAM_*` hooks) — no network, no key, no spend — and is gated at **100% line and 100% function coverage** of `proxy-a.mjs` (branch ≥99%; V8 block coverage is 100%, with only defensive I/O-error swallows and the entrypoint excluded via `node:coverage` comments). It exercises hit/miss/coalesce/bypass/expired/prune/seed/error/client-abort, **byte-exact multi-chunk SSE replay** (deliberately split mid-token so a concatenation bug would fail it), auth enforcement, the bind refusal, verbosity + the file sink, the `/monitor` stream, session-vs-all-time accounting, and (via three new test files) all branches of the normalized and suffix key tiers — including HIT-NORM, HIT-SUFFIX, the alias-write path, and the dedup guards. The suite splits scenarios across files so coverage merges across child processes.

**`npm run test:fidelity`** is the live, **paid** counterpart: `test-fidelity.mjs` proves byte-identical cold→warm replay against the real API for streaming, tool_use, and streaming+tool_use, plus coalescing — **23/23**, re-run after the refactor to confirm no behavior drift. Keeping the free suite as the default `npm test` makes the project CI-friendly while preserving the live proof as an opt-in.

**`npm run test:normalize-example`** (`test-normalize-example.mjs`) is a third free-tier suite — no key, no network — that validates all patterns in `normalize.json.example` against a mock upstream. 12 cases cover date lines, UUID, Session-ID, `<tool_result>` strips, no-interference assertions, a combined Claude Code style prompt, array block message content, and byte-exact replay fidelity. It serves as both a regression guard for the example file and a demonstration that the partial-cache tiers work correctly end-to-end.

## Performance

The side-by-side is convincing because it compares against the right baseline (cache bypass, not "nothing"):

| Metric | Cache OFF | Cache ON |
|---|---|---|
| Hit rate | 0% | 80% |
| Upstream calls (5 identical) | 5 | 1 |
| Warm-call latency | 1.141 s | 0.001 s |
| Tokens saved | 0 | 296 |

Read it correctly: savings track the repeat rate, and the 80% here is simply (N−1)/N for five identical calls. The latency delta is the more durable result. A served hit costs a disk read and returns in about a millisecond, which makes the proxy useful as a fast local replay layer for eval suites even where the token saving is secondary. One honest footnote, already in the README: `bench.py`'s own "saved %" line reads 0% because a cached response still carries usage numbers, so the client SDK cannot tell the call was free. The proxy ledger and the latency are the ground truth, and that ledger is now a live endpoint: `/stats` reports cumulative tokens and dollars saved, priced per model, split into this-session and all-time.

## Live-agent loop

A real `claude -p` session was run twice through the proxy with an identical prompt. Both runs returned the correct answer with streaming intact and zero proxy errors, so the proxy is transparent to a live Claude Code agent loop. Both responses were stored (complete 200s), yet the second run was a MISS, not a hit. Claude Code's request bodies are not byte-identical across runs (dynamic system prompt and context), so the two turns hashed to different keys.

That sharpens the tool's scope. Exact-match (tier-1) caching hits deterministic, byte-identical repeats: eval suites, CI, scripted SDK calls, the fidelity test. It does not hit interactive or agent sessions, where each turn's context differs. The optional partial-cache tiers (v2.0.3) close part of this gap: tier-2 (`HIT-NORM`) handles the common case where only the system prompt's timestamp or session ID varies across runs of the same logical task; tier-3 (`HIT-SUFFIX`) handles different conversation prefixes with a shared recent context. Neither tier helps when every turn is genuinely novel — the boundary is honest and the README states it plainly.

## Security posture

Materially improved this pass, and the README does not overclaim. The headline change: the proxy now **binds loopback by default and refuses to expose itself without authentication**.

- **Bind + auth gate.** The old `listen(port)` bound *all* interfaces unauthenticated; the default is now `127.0.0.1`. Setting `CACHE_HOST` to a non-loopback address requires `CACHE_AUTH_TOKEN` (`start()` throws otherwise), and the proxy then enforces `x-cache-auth` on every route except `/health`. On a personal machine the loopback default is the safe path; exposure is a deliberate, authenticated opt-in.
- **Monitoring endpoints follow the same gate.** `/stats`, `/metrics`, and `/monitor` require the token when one is set (only `/health` stays open, for liveness probes). They expose usage counters and dollar figures but no secrets and no prompt or response content.
- **Plaintext at rest.** The key lives in `.env` (gitignored, now written chmod 600 by `setup`), and cached responses sit unencrypted under `~/.llm-cache-a/`. Prompts are not persisted, which softens the exposure, but response bodies can still be sensitive. The cache explorer makes targeted invalidation easy.
- **Service install.** The launchd agent sources `.env` via a `bash -lc` wrapper rather than baking the secret into the plist; the systemd unit uses `EnvironmentFile=.env`. Both keep the key in `.env`. The macOS launchd path was exercised on a real boot cycle in v2.0.2, surfacing and fixing three bugs (port race, stale PID, stop-then-restart).
- **macOS bash 3.2 compatibility (v2.0.1).** `cachectl-a.sh status/stats/monitor` previously crashed on macOS with `AUTH_HDR[@]: unbound variable` under `set -u` when `CACHE_AUTH_TOKEN` was not set (empty array expansion in bash 3.2). Fixed with `${AUTH_HDR[@]+"${AUTH_HDR[@]}"}` idiom — a portable empty-array guard that works on both bash 3.2 (macOS system shell) and bash 5.x.
- **Secret hygiene in the repo is sound.** Every commit in this project was gated against staging `.env` or a real key, and the history is clean.

## Engineering judgment: the LiteLLM pivot

The decision record deserves credit independent of the code. The project first reached for LiteLLM on the reasonable theory that built-in caching beats hand-rolled. It then hit a wall of compounding problems: an 87-second import, flaky 120-second-plus startup, a passthrough route that bypassed the cache, a wildcard-routing path that demanded a database, and the IPv4 `localhost` mismatch. Rather than keep patching, the author measured, called it, and rewrote the whole thing as dependency-free Node that starts in under two seconds. Choosing the heavy tool first was defensible; abandoning it on evidence was the right call.

v2.0.1 completed the pivot by formally deleting the abandoned files (cachectl.sh, callback.py, config.yaml, config.nocache.yaml, requirements.txt — 243 lines removed, 9 changed). The repo is now clean; the decision record survives in docs/ARCHITECTURE.md rather than cluttering the working tree. The README replaced the stale file list with a rationale-only "Why not LiteLLM" note, which is the right scope for that surface.

## Recommendations

In priority order:

1. **Bound the metrics log and add age-based eviction** so an always-on instance stays tidy. This matters more now that the proxy runs as a boot service and reads the whole log to seed the counters.
2. **Consider per-client tokens / scoped auth** if multi-user exposure ever becomes a goal; the current single shared `CACHE_AUTH_TOKEN` is right for the single-operator target but is coarse for shared hosts.

**Resolved since the first draft:**

- **Boot-cycle launchd reliability (was Recommendation #2, v2.0.2):** exercised on a real macOS system reboot; found and fixed three bugs: `EADDRINUSE` race, stale pidfile, and stop not preventing restart. All three now confirmed fixed.
- **Authenticated / private-bind exposure (was Recommendation #2):** loopback by default; non-loopback bind requires `CACHE_AUTH_TOKEN`, enforced on all routes but `/health`.
- **Regression safety (new):** a 100%-line/function zero-dep unit suite drives the real code against a mock upstream — no network, no spend — so the byte-exact behavior is now guarded in CI.
- **Streaming + `tool_use` fidelity (was Major):** byte-identical cold→warm replay proven against the live API (23/23), re-verified after the refactor.
- **Live-agent loop (was the last open item):** a real `claude -p` session runs correctly through the proxy with streaming intact and zero errors. (It surfaced the agent-session caching limit, now stated in the README.)
- **Client-abort crash (was Major):** guarded writes plus upstream teardown on disconnect.
- **Concurrency (was three Minors):** async `fs/promises` I/O, request coalescing (a 6-way identical burst makes exactly one upstream call, proven), and a throttled prune.
- **Earlier (PR #2):** per-model pricing for `usd_saved`, structured logging, and the `/stats` + `/metrics` endpoints.

## Scorecard

| Dimension | Rating | Note |
|---|---|---|
| Fit for stated purpose | Excellent | Exact-match rerun/eval/CI caching + optional partial cache (HIT-NORM/HIT-SUFFIX) |
| Code clarity | Excellent | ~450 lines, zero deps, readable in one sitting; heavily commented |
| Correctness (non-streaming) | Strong | Complete-200-only, fail-open, byte-exact |
| Correctness (streaming/tool_use) | Proven | Byte-exact replay verified live (23/23) + multi-chunk SSE covered in the unit suite |
| Robustness under concurrency | Strong | Async I/O, coalescing (1 upstream call per burst, proven), abort guard, throttled prune |
| Test coverage | Excellent | 100% line + function (zero-dep, no paid calls) plus a live paid fidelity proof |
| Observability | Strong | Structured logs + verbosity, `/stats` (session + all-time), `/metrics`, realtime `/monitor` with seq+snippet, `status` |
| Operability | Excellent | First-run setup, boot-service install (systemd/launchd), boot-cycle verified + launchd bugs fixed, cache-explorer TUI, CLI |
| Security (single-user) | Good | Loopback default + token-gated exposure; plaintext at rest; clean secret hygiene |
| Documentation | Strong | Honest scope, measured numbers, preserved decision record |

## Appendix: install & use

**Repository:** https://github.com/mithudso/llm-cache-proxy

Single user, macOS or Linux. Needs **Node ≥ 18** to run the proxy (the unit suite needs **Node ≥ 22** for built-in coverage) and a real Anthropic key.

**Install:**

```bash
brew install mithudso/tap/llm-cache-proxy   # Homebrew (macOS / Linux) — recommended
npm install -g llm-cache-proxy              # npm global  (or: npx llm-cache-proxy <cmd>)
git clone https://github.com/mithudso/llm-cache-proxy.git && cd llm-cache-proxy  # source
```

**First run — just call `on`; it prompts for the key and writes config immediately:**

```bash
llm-cache-proxy on      # Homebrew / npm
./cachectl-a.sh on      # source install
```

No separate setup step required. The wizard runs automatically on the first invocation when the key is not yet set, then starts the proxy.

**Config file paths (written by the setup wizard, chmod 600):**

| Install | Config file |
|---|---|
| Homebrew / npm | `~/.llm-cache-a/.env` |
| Source | `<repo-root>/.env` |

**Config file contents (example):**

```bash
ANTHROPIC_API_KEY_REAL=sk-ant-api03-...   # real key — never committed
CACHE_PORT=4000
CACHE_TTL_SEC=604800                       # 7 days
CACHE_MAX_ENTRIES=5000
CACHE_HOST=127.0.0.1                       # loopback only; 0.0.0.0 requires CACHE_AUTH_TOKEN
# CACHE_LOG_LEVEL=info                     # silent|error|info|debug
# CACHE_LOG_FILE=/Users/you/.llm-cache-a/proxy.log   # or 'none'
```

To re-run setup or rotate the key: `llm-cache-proxy setup` (Homebrew/npm) or `./cachectl-a.sh setup` (source).

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000   # point Claude Code / SDK at it
export ANTHROPIC_API_KEY=anything                 # client key ignored; .env key is used
```

Operate: `on | off | restart | stop | stats | setup | validate` (Homebrew/npm) · `on | off | restart | stop | validate | stats | status | monitor | explore | setup | run | install | uninstall` (source, via `./cachectl-a.sh`).
(`off` = bypass). Verify with `npm test` (zero-dep unit suite, 43 tests, 100% line/function coverage, no paid calls)
and `npm run test:fidelity` (live paid proof, expects 23/23); inspect with `curl localhost:4000/stats`
(this-session + all-time) and `./cachectl-a.sh monitor` (realtime). Configuration is via env vars
(`CACHE_PORT`, `CACHE_HOST`, `CACHE_AUTH_TOKEN`, `CACHE_TTL_SEC`, `CACHE_MAX_ENTRIES`, `CACHE_LOG_LEVEL`,
`CACHE_LOG_FILE`, `CACHE_OFF`) and `~/.llm-cache-a/prices.json` for per-model pricing, `~/.llm-cache-a/normalize.json` for partial-cache patterns; data lives under `~/.llm-cache-a/`.

**Bottom line.** A sharp, well-scoped utility that does the hard part (faithful replay) correctly and provably, tracks its own token and dollar savings, and tells the truth about its limits. The byte-exact core is now wrapped in a 100%-covered unit suite and a matured operational surface (token-gated network exposure, realtime monitor, boot-service install, cache explorer) without losing the zero-dependency, read-in-one-sitting character. Optional partial caching extends the hit surface to "same logical prompt, different timestamp" workloads without touching the exact-match fast path. Ship it for batch and rerun workloads. For interactive sessions: tier-1 still won't help, but tier-2 with a well-tuned normalize.json will recover hits that were previously lost to dynamic system-prompt fields.
