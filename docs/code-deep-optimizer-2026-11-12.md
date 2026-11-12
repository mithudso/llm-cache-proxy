# Code deep optimizer — 2026-11-12

Scope: complete repository, no file-count truncation. Standard profile; skill 1.16.0.
Sources and test files were reviewed per file; three primary runtime/controller audits
ran in parallel. Parent reviewed explorer/benchmark/tooling and all original tests.
New libraries/tests were reviewed with their owning component; the final blind audit
reviewed the complete runtime/helper set. Dispatch used component ownership rather
than a separate fresh agent for every tiny test file. No advisory/feature phase.

## 1. Severity by iteration

| Stage | Critical | High | Medium | Low / Nit |
|---|---:|---:|---:|---|
| Initial source audit | 3 | 16 | 18 | cosmetic items skipped |
| First candidate before blind gate | 0 | 0 | 0 | skipped |
| Blind gate1 | 0 | 0 | 5 | skipped |
| Bootstrap/follow-up review | 0 | 1 | 5 | skipped |
| Blind gate2 | 0 | 0 | 2 | skipped |
| Test gate repair | 0 | 0 | 1 | fixed wait flake |
| Final repairs, verified by regressions | 0 | 0 | 0 known | cosmetic items skipped |

Counts group related defects into the findings below; bootstrap manifest coverage is
recorded separately in the bootstrap audit. Every applied delta is justified by an
evidenced correctness, safety, tooling or documentation finding.

## 2. Findings

Baseline anchors refer to main `14216fa`; new-script anchors refer to this task.

| Pass | Evidence | Severity | Finding | Fix | Status |
|---|---|---|---|---|---|
| C1/C2/S1 | `proxy-a.mjs:215` | Critical | Cache identity omitted HTTP path/query/API headers | Restricted message POST path; all key tiers vary API headers and HTTP representation | fixed; behavior verified |
| C1/C3 | `proxy-a.mjs:252,292` | Critical | Incomplete SSE was cached/coalesced as success | Require last completed SSE frame to have terminal event; incomplete coalesced replies remain MISS-COALESCED | fixed; behavior verified |
| C1/S3 | `proxy-a.mjs:55,213,286` | High | Malformed model/message types could reject async callbacks | Validate model/message shapes; reject control characters and guard processing failures | fixed; behavior verified |
| S2/P2 | `proxy-a.mjs:282-337` | High | Upstream interruption/deadline did not settle inflight requests | Single settlement handles errors, abort, close, total timeout; active waiters survive leader disconnect | fixed; behavior verified |
| S1 | `proxy-a.mjs:49,296-300` | High | Cache files inherited public-readable permissions | New directories700 and files600; existing data not chmodded | fixed; behavior verified |
| C2/S2 | `proxy-a.mjs:271-278` | High | Hop-by-hop transfer framing was forwarded with Content-Length | Sanitize connection-nominated headers before credential injection; retain Retry-After for coalesced errors | fixed; behavior verified |
| S2/P1/P2 | `proxy-a.mjs:206,284-288,392-396` | High | Unbounded request/response retention and ignored backpressure | Request cap413; replay cache retention cap with intact primary streaming; monitor cap and backlog disconnect; downstream drain pauses upstream | fixed; behavior verified |
| C1/S5 | `proxy-a.mjs:136-140` | Medium | Usage whitespace lost valid token counts | Accept JSON whitespace | fixed; behavior verified |
| C1/S5 | `proxy-a.mjs:105,310,318` | Medium | Coalesced ledger totals and stored flags were inaccurate | Seed coalesced bit; emit stored only after successful writes | fixed; behavior verified |
| S3/M1 | `proxy-a.mjs:54,65-71,81,230` | Medium | Optional config types/ranges were unvalidated | Shared pure limits/pricing/normalization validators; sanitized invalid-config diagnostics | fixed; behavior verified |
| P2 | `proxy-a.mjs:296-300` | Medium | Visible in-place pair writes could expose partial/mixed cache data | Atomic temp-file renames and body digest validation; mismatch falls back to upstream | fixed; behavior verified |
| C1/C2/S4 | `cli.mjs:12,31-41,128-130,208-228` | High | Configuration loaded after fixed request port; IPv4-only unauthenticated control requests | Load configuration before deriving endpoints; respect port, IPv6 host and x-cache-auth | fixed; behavior verified |
| C3/S1/S3 | `cli.mjs:50-52` | High | Unvalidated pidfile can signal process group or unrelated PID | Reject nonpositive/noninteger/unsafe PIDs and verify exact node/proxy command before signaling | fixed; behavior verified |
| S1/S3 | `cli.mjs:74-85` | High | Existing .env mode is not repaired before storing credentials | chmod existing regular file600, reject symlink/nonregular target, atomic private replacement | fixed; behavior verified |
| S2/P2 | `cli.mjs:38-47` | High | Unbounded or aborted local HTTP can leave controller hanging | Bound complete response time and bytes, settle all error/abort paths, cap readiness deadline | fixed; behavior verified |
| C1/C2/S3 | `cli.mjs:67-92` | Medium | Setup allows invalid inputs and lacks LAN auth token generation | Validate settings and generate cryptographic LAN token; serialize .env as literal JSON strings through shared parser | fixed; behavior verified |
| T1 | `package.json test selection excludes CLI and no CLI tests existed` | Medium | Installed controller lacked behavioral regression coverage | 18 isolated tests including full own-process start/stop, setup and HTTP failure paths | fixed; behavior verified |
| C2/S3 | `cli.mjs:169-180,197-200` | Medium | validate accepts invalid normalization options and negative prices rejected by hardened startup | Share pure validators with proxy and validate runtime limits before probes | fixed; behavior verified |
| C3/S2 | `cli.mjs:59` | Medium | Setup EOF exits successfully without saving configuration | Reject readline close before an answer with explicit error | fixed; behavior verified |
| S1 | `cachectl-a.sh:8,58-66` | Critical | Wizard answers were persisted as shell code and executed on next invocation. | Read dotenv through safe shared parser; write literals atomically at mode600; keep key out of argv/output. | fixed; behavior verified |
| S1/P2 | `cachectl-a.sh:27-29,359-367` | High | Stale PID and blanket pkill/pgrep could kill or adopt unrelated processes or other checkouts. | Use shared exact Node command identity; remove basename-wide search/signals; verify installed-service source. | fixed; behavior verified |
| S4 | `cachectl-a.sh:99-111` | High | Generated launchd plist contains raw && XML and shell-interpreted unquoted paths. | Generate XML-escaped argument array invoking safe controller run; pin Node directory in service PATH. | fixed; behavior verified |
| P2 | `cachectl-a.sh:293-307` | High | on/off starts nohup then loads launchd, creating competing processes; systemd stop could restart killed process. | Use installed service as sole owner with persisted mode, otherwise spawn nohup; stop manager before signaling. | fixed; behavior verified |
| S4/C1 | `cachectl-a.sh:7,13` | Medium | Relative invocation from parent resolves script directory twice and exits before command. | Resolve BASH_SOURCE directory once before cd. | fixed; behavior verified |
| C1/S2 | `cachectl-a.sh:173-196,205-222` | Medium | set-e exits invalid JSON assignments before validation diagnostic; fixed shared /tmp filename races/leaks. | Put command substitutions in if conditions and capture diagnostic directly; avoid shared error file. | fixed; behavior verified |
| C1 | `cachectl-a.sh:231-264` | Medium | Offline curl prints 000 and fallback echoes 000, so validation reports 000000 error rather than skip. | Retain curl status code once and classify offline as runtime skipped. | fixed; behavior verified |
| S2 | `cachectl-a.sh:231,237,253,298,327,376-377` | Medium | Control-plane requests have no deadline and target localhost regardless configured bind. | Bound connect/request durations and derive IPv4/IPv6 host URL from settings; keep monitor stream open. | fixed; behavior verified |
| S5 | `cachectl-a.sh:407-413` | Medium | status counts ^ERR although runtime prefixes all logs with ISO timestamp. | Count explicit ERR/ERROR log labels with optional timestamp and test result. | fixed; behavior verified |
| C2 | `cachectl-a.sh:40-41` | Medium | setup returns early when key exists even though installation docs direct setup for rotation. | Allow deliberate key replacement and preserve unrelated optional config. | fixed; behavior verified |
| S3 | `cachectl-a.sh:166-167,178-185,208-211` | Medium | validate misses missing nonloopback token, invalid pattern types, fractional suffix counts and negative prices. | Add schema and token checks with useful diagnostic summaries. | fixed; behavior verified |
| C3/S1 | `cache-explorer.mjs:39,76` | High | Empty invalidation prefix and exported key traversal can remove unintended files. | Require bounded nonempty hexadecimal prefixes and full validated keys. | fixed; behavior verified |
| S1/S5 | `cache-explorer.mjs:47,72,101` | High | Untrusted cache fields/payload emit terminal control sequences. | Escape C0, DEL and C1 in human output. | fixed; behavior verified |
| C2/S2 | `cache-explorer.mjs:31,123` | Medium | Null metadata crashes listing; importing the library executes CLI. | Tolerate malformed metadata; guard executable entrypoint. | fixed; behavior verified |
| C1 | `bench.py:57-72` | Medium | Replayed usage counted as billed cost, falsely reporting zero savings. | Use raw x-cache classification; estimates clearly labelled. | fixed; behavior verified |
| T2 | `package.json:57-71` | High | Unused dependency tree contains 31 audit vulnerabilities. | Remove eight unrelated packages and script permissions; regenerate empty lockfile. | fixed; behavior verified |
| T3/T1 | `.github/workflows/ci.yml:8-23` | High | PR CI omits offline unit suite and can run paid proof automatically. | Run offline gates Node22/24, Node18 smoke; remove automatic paid calls. | fixed; behavior verified |
| M4 | `README.md:120; docs/ARCHITECTURE.md:26` | Medium | Stale examples and architecture claims lead to wrong operational actions. | Rewrite maintained docs and mark historical claims. | fixed; behavior verified |
| S2 | `scripts/rotate-workflow-logs.mjs` | Medium | Rotation writes before checking other swaps and can lose latest section. | Batch preflight, full original archive and atomic publication. | fixed; behavior verified |
| T3 | `scripts/generate-ops-registry-doc.mjs` | Medium | Known-string route presence misses extra routes and changed methods. | Compare explicit method/path guard sets; test extras and inverse guard. | fixed; behavior verified |
| M4 | `scripts/generate-doc-indexes.mjs` | Medium | Named export lists missing from retrieval cards. | Parse exported lists and verify proxy exports in generated output. | fixed; behavior verified |
| S1 | `.github/workflows/homebrew.yml:23` | High | Release tag interpolated directly into shell code. | Pass via environment; require vMAJOR.MINOR.PATCH before URL/output use. | fixed; behavior verified |
| S1 | `package.json files` | Medium | Broad docs package inclusion would publish future archived workflow bodies. | Explicit public doc allowlist; pack dry-run has no private paths. | fixed; behavior verified |
| C2/S2 | `test-fidelity.mjs:26-40` | Medium | Fidelity entrypoint ignores proxy token/IPv6 and can hang. | Shared endpoint config/auth and bounded requests; local authenticated proof regression. | fixed; behavior verified |
| C1 | `proxy-a.mjs serveHit` | Medium | Blind gate1: encoded payload replay drops content-encoding. | Follow-up repair and regression. | fixed; behavior verified |
| C3/P2 | `proxy-a.mjs handle` | Medium | Blind gate1: disconnected oversized waiter starts a paid fallback fetch. | Follow-up liveness guard and regression. | fixed; behavior verified |
| C2/S3 | `proxy-a.mjs readHit` | Medium | Blind gate1: invalid metadata bypasses TTL or hangs header writes. | Follow-up schema/header validation and regression. | fixed; behavior verified |
| C2/M2 | `cachectl-a.sh _validate` | Medium | Blind gate1: runtime limits accepted although startup rejects them. | Follow-up shared readLimits validation and regression. | fixed; behavior verified |
| S5 | `cachectl-a.sh monitor` | Medium | Blind gate1: monitor snippets emit terminal controls. | Follow-up escaping and synthetic SSE regression. | fixed; behavior verified |
| P1/C1 | `proxy-a.mjs maybePrune` | Medium | Blind gate2: stale count gives a negative slice and evicts valid entries below cap. | Clamp excess from actual ranked entries and recount actual files. | fixed; behavior verified |
| C1 | `proxy-a.mjs priceFor` | Medium | Blind gate2: built-in family price takes precedence over specific model override. | Match longest configured model substring first. | fixed; behavior verified |
| T4 | `proxy.test.mjs:46` | Medium | Fixed60ms wait flakes under concurrent Node24 validation. | Poll for exact metadata publication before asserting disk HIT. | fixed; behavior verified |

## 3. Verify gate

| Command | Baseline | Final candidate | Verdict |
|---|---|---|---|
| npm run check; bash -n; Python syntax | PASS | PASS | PASS |
| npm test | 43 proxy tests; 100% reported lines/functions | 114/114 Node tests on Node26 and Node24 | PASS |
| npm run test:normalize-example | 12/12 | 12/12 | PASS |
| npm run test:python | absent | 3/3 | PASS |
| npm run docs:check; npm run ops:doc:check | absent | PASS | PASS |
| npm audit | 31: 2 critical, 19 high, 8 moderate, 2 low | zero dependencies; zero findings | PASS |
| npm pack --dry-run | not a baseline gate | 36 public files; all four libraries; no private paths | PASS |

Regression receipts: proxy had 10 failing cases and two deadline cancellations before
fixes; CLI first five regressions failed, then validator/EOF regressions failed; shell
baseline rerun had 11 failures. Explorer baseline regressions failed in a temporary
baseline mirror; authenticated fidelity proof initially returned 401. No real API
calls were used. Final local gate: 114/114 Node tests on Node26.7 and Node24.22.1; 12/12 normalization
cases; 3/3 Python tests. Proxy coverage: 99.49% lines, 97.26% functions, 95.73% branches.
ShellCheck warning gate, syntax, package privacy and both drift checks pass.

A Node24 shell fixture mismatch was repaired by making fixture PATH
use the runner runtime, then all shell cases passed.

## 4. Activated skills

- repo-bootstrapper: metadata, operational inventory, maintenance and docs.
- code-deep-optimizer: all 18 passes at file or repository scope.
- lang-js-ts references: Node18 ESM/HTTP/async semantics.
- lang-python patterns: standard-library benchmark and offline tests.
- security-review reference: input/auth/config/process/secret boundaries.
- software-engineering-patterns reviewer/coding standards: evidence and behavioral tests.
- crawl-repo-to-llms reference: public static retrieval exports; no embeddings.

C1–C3, S1–S5, P1–P2, M1–M4 and T1–T4 all ran. M3/T2/T3 and cross-file
duplication ran at repo scope. T4 applies only to tests; existing independent test
processes remain parallel. No speculative runner replacement or timer rewrite.

## 5. Per-file changes and completion manifest

Diff excerpts are capped at six changed lines per existing file; see the PR for the
full patch. Newly created files are listed with exact paths and line counts.

| File | Lines | Status |
|---|---:|---|
| `.env.example` | 29 | created |
| `.github/CODEOWNERS` | 1 | created |
| `.github/ISSUE_TEMPLATE/bug_report.md` | 7 | created |
| `.github/ISSUE_TEMPLATE/feature_request.md` | 7 | created |
| `.github/PULL_REQUEST_TEMPLATE.md` | 7 | created |
| `.github/SECURITY.md` | 7 | created |
| `.github/copilot-instructions.md` | 25 | created |
| `.github/dependabot.yml` | 10 | created |
| `.github/workflows/ci.yml` | 51 | updated |
| `.github/workflows/homebrew.yml` | 71 | updated |
| `.gitignore` | 24 | updated |
| `.mcp.json` | 1 | created |
| `.vscode/extensions.json` | 1 | created |
| `.vscode/launch.json` | 1 | created |
| `.vscode/mcp.json` | 1 | created |
| `.vscode/settings.json` | 1 | created |
| `AGENTS.md` | 27 | created |
| `CLAUDE.md` | 74 | updated |
| `CODE_OF_CONDUCT.md` | 6 | created |
| `CONCEPT-FAMILY-SKILLS-OPTIMIZATION.md` | 78 | updated |
| `CONTRIBUTING.md` | 7 | created |
| `GEMINI.md` | 4 | created |
| `MCP-SERVERS-SYNC.md` | 93 | updated |
| `README.md` | 61 | updated |
| `USAGE.md` | 65 | updated |
| `bench.py` | 80 | updated |
| `bench_test.py` | 51 | created |
| `cache-explorer.mjs` | 139 | updated |
| `cache-explorer.test.mjs` | 59 | created |
| `cachectl-a.sh` | 549 | updated |
| `cachectl.test.mjs` | 272 | created |
| `cli.mjs` | 257 | updated |
| `cli.test.mjs` | 220 | created |
| `doc-tools.test.mjs` | 38 | created |
| `docs/ARCHITECTURE.md` | 76 | updated |
| `docs/COMPONENTS.md` | 34 | created |
| `docs/DEVELOPMENT.md` | 67 | created |
| `docs/INSTALL.md` | 4 | updated |
| `docs/INSTALLATION.md` | 37 | created |
| `docs/MCP.md` | 9 | created |
| `docs/SECURITY.md` | 34 | created |
| `docs/TESTING.md` | 42 | created |
| `docs/archive/README.md` | 3 | created |
| `docs/caching-and-optimization.md` | 19 | created |
| `docs/code-deep-optimizer-2026-11-12.md` | generated receipt | created |
| `docs/codebase-overview.md` | 90 | created |
| `docs/external-calls.md` | 35 | created |
| `docs/high_signal_file_index.json` | 774 | created |
| `docs/integrations-and-assumptions.md` | 18 | created |
| `docs/known-issues.md` | 17 | created |
| `docs/logging.md` | 17 | created |
| `docs/onboarding.md` | 10 | created |
| `docs/operations-registry.json` | 150 | created |
| `docs/repo-bootstrap-audit-2026-11-12.md` | 50 | created |
| `docs/requirements.md` | 15 | created |
| `docs/runbooks/operations.md` | 29 | created |
| `docs/tool-inventory.json` | 31 | created |
| `docs/wiki/README.md` | 20 | created |
| `fidelity-local.test.mjs` | 26 | created |
| `lib/controller.mjs` | 149 | created |
| `lib/operations-registry.mjs` | 12 | created |
| `lib/proxy-config.mjs` | 3 | created |
| `lib/proxy-validation.mjs` | 50 | created |
| `llm-cache-proxy-tech-review.md` | 203 | updated |
| `llms-facts.txt` | 7 | updated |
| `llms-full.txt` | 396 | updated |
| `llms-small.txt` | 7 | updated |
| `llms.txt` | 13 | updated |
| `memory.md` | 12 | created |
| `package.test.mjs` | 20 | created |
| `package-lock.json` | 19 | updated |
| `package.json` | 83 | updated |
| `prompts.md` | 5 | created |
| `proxy-a.mjs` | 588 | updated |
| `proxy-eviction-pricing.test.mjs` | 33 | created |
| `proxy-hardening.test.mjs` | 193 | created |
| `proxy-limits.test.mjs` | 88 | created |
| `proxy-stream-errors.test.mjs` | 94 | created |
| `proxy.test.mjs` | 223 | updated |
| `scripts/check-doc-indexes.mjs` | 20 | created |
| `scripts/check-source.mjs` | 11 | created |
| `scripts/generate-doc-indexes.mjs` | 61 | created |
| `scripts/generate-ops-registry-doc.mjs` | 31 | created |
| `scripts/rotate-workflow-logs.mjs` | 28 | created |
| `test-fidelity.mjs` | 128 | updated |
| `test-helpers.mjs` | 117 | updated |

### .github/workflows/ci.yml
```diff
-on: [push, pull_request]
+on:
+  push:
+    branches: [main]
+    tags: ['v*']
+  pull_request:
```
Excerpt capped; full diff in PR.

### .github/workflows/homebrew.yml
```diff
+        env:
+          RELEASE_TAG: ${{ github.event.release.tag_name }}
-          TAG="${{ github.event.release.tag_name }}"
-          case "$TAG" in
-            v*) : ;;
-            *) echo "::error::tag '$TAG' does not start with 'v'"; exit 1 ;;
```
Excerpt capped; full diff in PR.

### .gitignore
```diff
+
+# Development and private continuation state
+node_modules/
+coverage/
+dist/
+.remember/
```
Excerpt capped; full diff in PR.

### CLAUDE.md
```diff
-# Semantic Indexing Rule
-- Do NOT use `view_file` to blindly explore large files.
-- ALWAYS use the `search_codebase` MCP tool (local semantic index) first to pull semantic chunks.
-- If the index does not exist, build it using `scripts/semantic_indexer.py`.
-- If the MCP server is not running or fails, attempt to start it. If it still fails, only then fallback to `view_file`.
-
```
Excerpt capped; full diff in PR.

### CONCEPT-FAMILY-SKILLS-OPTIMIZATION.md
```diff
+> Historical snapshot. Current commands and constraints are maintained in [the project wiki](docs/wiki/README.md). This maintenance run did not revalidate historical live results or machine integrations.
+
```
Excerpt capped; full diff in PR.

### MCP-SERVERS-SYNC.md
```diff
+> Historical snapshot. Current commands and constraints are maintained in [the project wiki](docs/wiki/README.md). This maintenance run did not revalidate historical live results or machine integrations.
+
```
Excerpt capped; full diff in PR.

### README.md
```diff
-Local-only, **zero-dependency** caching reverse proxy for the Anthropic Messages API.
-On an exact-match repeat it replays the byte-identical cached response with **no
-upstream call** — 100% token save per hit. Built for rerun / eval / CI / dev-loop
-workloads, where the same `/v1/messages` request recurs.
+A local, zero-dependency reverse proxy for the Anthropic Messages API. Repeated
+requests replay the stored response bytes without another upstream call. It fits
```
Excerpt capped; full diff in PR.

### USAGE.md
```diff
-# llm-cache-proxy — Usage Guide
+# Usage guide
-Local-only, zero-dependency caching reverse proxy for the Anthropic Messages API
-(`/v1/messages`). On an exact-match repeat it replays the byte-identical cached
-response with **no upstream call** — a 100% token save per hit. Built for
-rerun / eval / CI / dev-loop workloads.
```
Excerpt capped; full diff in PR.

### bench.py
```diff
-"""bench.py — measured token/$ savings for the local cache.
+"""Measure local-cache latency and estimated savings. Calls are live and paid on MISS.
-Fires identical calls (should HIT after the first) + varied calls (should MISS),
-through the proxy, and prints cold-vs-warm cost. This produces the REAL numbers
-the design doc only modeled.
-
```
Excerpt capped; full diff in PR.

### cache-explorer.mjs
```diff
+import { fileURLToPath } from 'node:url';
-    if (!f.endsWith('.bin')) continue;
+    if (!/^[a-f0-9]{64}\.bin$/.test(f)) continue;
-    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); ts = meta.ts || 0; } catch { /* orphan bin */ }
+    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); if (!meta || typeof meta !== 'object') meta = {}; ts = Number(meta.ts) || 0; } catch { /* orphan bin */ }
+  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('invalid cache key');
```
Excerpt capped; full diff in PR.

### cachectl-a.sh
```diff
-# Reads ANTHROPIC_API_KEY_REAL (+ other CACHE_* settings) from ./.env (gitignored).
+# Parses ANTHROPIC_API_KEY_REAL (+ other CACHE_* settings) from ./.env as data.
-cd "$(dirname "$0")"
-[ -f .env ] && { set -a; . ./.env; set +a; }
-PORT="${CACHE_PORT:-4000}"
+REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```
Excerpt capped; full diff in PR.

### cli.mjs
```diff
-// llm-cache-proxy CLI — cross-platform control (on | off | stop | stats | setup).
+// llm-cache-proxy CLI — local start, stop, setup, statistics and validation.
-import http from 'node:http';
+import { randomBytes } from 'node:crypto';
+import { loadEnvFile, writeEnvFile, readControllerConfig, requestLocal, stopProxy } from './lib/controller.mjs';
+import { readLimits, validateNormalization, validatePrices } from './lib/proxy-validation.mjs';
```
Excerpt capped; full diff in PR.

### docs/ARCHITECTURE.md
```diff
-# Architecture — llm-cache-proxy
+# Architecture
-## Purpose
-Cut Anthropic API token spend on repeated identical calls (reruns, evals, CI, dev
-loops). A local reverse proxy in front of `api.anthropic.com` that replays cached
-responses with zero upstream calls on exact-match repeats.
```
Excerpt capped; full diff in PR.

### docs/INSTALL.md
```diff
-# Install & Use — llm-cache-proxy
+# Installation
-How to install, configure, run, and operate the proxy. For what it is and why, see the
-[README](../README.md); for the design, see [ARCHITECTURE.md](ARCHITECTURE.md).
-
-This guide is for a single user on their own machine (macOS or Linux). By the end you will
```
Excerpt capped; full diff in PR.

### llm-cache-proxy-tech-review.md
```diff
+> Historical snapshot. Current commands and constraints are maintained in [the project wiki](docs/wiki/README.md). This maintenance run did not revalidate historical live results or machine integrations.
+
```
Excerpt capped; full diff in PR.

### package.json
```diff
-  "version": "2.0.6",
+  "version": "2.0.7",
-    "docs/",
-    "LICENSE"
+    "LICENSE",
+    "lib/",
```
Excerpt capped; full diff in PR.

### proxy-a.mjs
```diff
+import { limits } from './lib/proxy-config.mjs';
+import { validatePrices, validateNormalization } from './lib/proxy-validation.mjs';
-const PORT = +(process.env.CACHE_PORT || 4000);
+const PORT = limits.port;
-const UPSTREAM_PORT = +(process.env.CACHE_UPSTREAM_PORT || 443);
+const UPSTREAM_PORT = limits.upstreamPort;
```
Excerpt capped; full diff in PR.

### proxy.test.mjs
```diff
-  await sleep(60);
+  await P.waitForEntry(body);
-  await sleep(60);
+  await P.waitForEntry(body);
-  await sleep(80);
+  await P.waitForEntry(body);
```
Excerpt capped; full diff in PR.

### test-fidelity.mjs
```diff
+import { readControllerConfig } from './lib/controller.mjs';
-const PORT = +(process.env.CACHE_PORT || 4000);
+const CONFIG = readControllerConfig();
+const PORT = CONFIG.port;
-      host: '127.0.0.1', port: PORT, path: '/v1/messages', method: 'POST',
-      headers: { 'content-type': 'application/json', 'x-api-key': 'test-client', 'anthropic-version': '2023-06-01', 'content-length': data.length },
```
Excerpt capped; full diff in PR.

### test-helpers.mjs
```diff
+import crypto from 'node:crypto';
+export async function waitFor(predicate, timeout = 3000) {
+  const deadline = Date.now() + timeout;
+  while (!(await predicate())) {
+    if (Date.now() >= deadline) throw new Error('Timed out waiting for mock fixture state');
+    await sleep(5);
```
Excerpt capped; full diff in PR.

## 6. Blind re-audit

Gate1: FAIL, five corroborated Medium findings (encoded replay, disconnected waiter,
metadata schema, shell limits and terminal monitor controls). One additional repair
iteration fixed all five. Gate2: BLIND-AUDIT-DISSENT, two corroborated Medium findings
(stale-count over-pruning and model-price specificity). Both final findings received
failing regression tests and were then repaired and verified. No third independent
gate was run; the bounded optimizer status remains BLIND-AUDIT-DISSENT. No reported
Medium+ defect remains knowingly unfixed. This is not a CLEAN independent verdict.

## 7. Recommendations

Not requested; advisory track disabled.

## 8. Implemented features

Not requested. Changes repair existing behavior and add maintenance/test infrastructure.

## 9. Summary

2 bounded audit iterations plus final dissent repairs · 18 active passes · profile standard · known final C/H/M: 0/0/0 · Verify PASS · Status BLIND-AUDIT-DISSENT

Convergence mechanics: the installed canonical convergence-and-severity.md and
convergence_check.py. Empirical mode: cannot auto-improve without an independent
held-out evaluation surface; the live paid benchmark is not used as an eval. No
persisted champion, automatic paid calls or performance-promotion claim.

## 10. Snapshot and rollback

Original tracked files are in the local pre-write baseline archive. Restore them into
a fresh directory for inspection; do not overwrite a live/shared checkout:

```bash
mkdir -p /tmp/llm-cache-proxy-before-20261112
tar -xf /Users/mitch.hudson/.claude/skill-consolidation/backups/llm-cache-proxy-20261112/baseline.tar -C /tmp/llm-cache-proxy-before-20261112
```

New files have no baseline counterpart. A package import-boundary regression additionally verifies every shipped relative
module import and excludes private workflow files. The backup directory holds the exact
created-file removal manifest for an isolated rollback and per-iteration snapshots.
For delivered changes, use a checked revert PR; do not rewrite main or restart a
running service as a side effect.

## 11. Index

index: public deterministic file/exports/docs refreshed; semantic index n/a outside
optimizer corpus roots. Embeddings/watchers remain inactive.

## 12. Memory-central

memory-central: 2 lessons and 2 conventions consulted; 0 prior regression checks fired.
Older notes were checked against current source; launchd PID/history was treated as
historical. Durable boundary lessons recorded in the project graph. Repo memory.md
contains only nonsensitive continuation/delivery status.

Native service activation, reboot acceptance, Windows identity execution, current live
fidelity and quantified performance were not verified. These limits are explicit.
