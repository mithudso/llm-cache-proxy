# External calls and local effects

The generated [operations registry](operations-registry.json) is the declarative
inventory in `lib/operations-registry.mjs`; `npm run ops:doc:check` checks drift.
The [route inventory](tool-inventory.json) is compared with the explicit method/path
guards in `proxy-a.mjs`, including extra routes and changed methods. If dispatch
syntax changes, update the static extractor and descriptions together.

| Operation / source symbol | Target | Diagnostics / tests | Retry and persistence |
|---|---|---|---|
| proxy-a.mjs fetchUpstream | Configured HTTPS Anthropic Messages API | Safe outcome/error codes; proxy-hardening, stream-errors and limits tests | No automatic retry; complete bounded responses stored and hash-checked on later reads |
| lib/controller.mjs requestLocal | Configured local health/stats/metrics | Bounded errors; cli.test.mjs | Read-only; startup polls health |
| cli.mjs start / stopProxy | Owned Node process; ps/PowerShell identity | Explicit startup/ownership errors; cli.test.mjs | Operator command only; PID file is not datastore evidence |
| cachectl-a.sh _curl / _start / _stop | Local HTTP, Node, curl and user services | Validation/status; cachectl.test.mjs | Bounded probes; monitor is a deliberate open stream; no paid retry |
| cachectl-a.sh _install / _uninstall | launchctl or systemctl user service | Stubbed managers and parsed XML fixtures | Explicit local side effect; native activation not tested |
| proxy-a.mjs readHit / writeEntry / maybePrune / metric / log | Private cache, ledger and log files | Digest/mode/failure tests; actual stored flag | Cache I/O fails open; write failures logged; ledger/log append failures best effort |
| cache-explorer.mjs listEntries / invalidate | Local cache files | cache-explorer.test.mjs | Explicit deletion only; no remote calls |
| bench.py call | Configured proxy Messages endpoint | bench_test.py local HTTP fixture | Live and paid on MISS; no retry |
| test-fidelity.mjs post / get | Configured local proxy | fidelity-local.test.mjs exercises authenticated proof offline | Manual live proof is paid; bounded requests |
| test-helpers.mjs / *.test.mjs | Ephemeral local mock ports and temporary files/processes | Offline suite | No real upstream or credentials |
| .github/workflows/ci.yml publish | npm registry | Tag/version check; offline checks precede publication | Explicit version tag; release credentials |
| .github/workflows/homebrew.yml | GitHub tarball and tap repository | Strict tag validation and checksum shape | Published release only; scoped tap credential |
| .github/workflows/token-expiry-check.yml | GitHub user API and npm whoami | Scheduled/manual outcome summary | Read-only auth probes; no task-triggered run |
| scripts/check-source.mjs | Git, Node/Bash/Python syntax subprocesses | Offline gate | No runtime entrypoint execution |
| scripts/generate-doc-indexes.mjs | Git file census and public local files | doc-tools.test.mjs and docs:check | Deterministic local output; no embeddings |
| scripts/generate-ops-registry-doc.mjs | Declarative registry and source route guards | doc-tools.test.mjs and ops:doc:check | Deterministic local output |
| scripts/rotate-workflow-logs.mjs | Local workflow logs and archives | Swap preflight/full-backup regression | Explicit invocation; atomic shortened log publication |

The local-tool profile uses existing CLI commands, log/status/metrics/monitor surfaces,
private response files and read-time digest verification. It does not add the full
mdb-tam generic operation runner, centralized errors.jsonl, per-call dashboard cards,
MCP remediation tools or a datastore service. Those five-standard differences are
explicit adaptations, not a claim that every upstream template requirement passes.
Operations inventory error names are descriptive categories; they are not promised
runtime exception classes. Cache/ledger persistence is not a remote-database sync.
