# Development

## Setup and workflow

Use the Node version in `.nvmrc` (22) for coverage and Python 3 for benchmark tests.
Runtime tools require Node 18+ and built-ins only; no npm install is needed to run
source tests. `npm ci --ignore-scripts` verifies the empty dependency lockfile.
Bash and curl are needed for the source controller. There is no bundler, build,
watch server or TypeScript compilation step. Edit modules and restart only your
own disposable development instance when needed.

```bash
npm run validate
node --test proxy.test.mjs
npm run docs:generate
npm run ops:doc
npm run docs:check
npm run ops:doc:check
```

Add behavior through the owning module and a test using `test-helpers.mjs` or a
temporary controller fixture. First reproduce the bug, then implement and run the
owning suite and complete gate. Keep credentials and live cache data out of fixtures.
Tests run in separate processes; avoid adding shared disk or fixed-port dependencies.

Use a focused task branch and descriptive commit. Review the final diff, push the PR,
wait for required checks and merge. CI runs offline tests and doc drift checks on PRs
and pushes. Tags may publish npm; published releases may update Homebrew. No release
is created by an ordinary merge. Live paid tests are manual only.

## Environment variables

Values in `.env.example` are placeholders; do not copy a real key into documentation.

| Variable | Default | Meaning |
|---|---|---|
| ANTHROPIC_API_KEY_REAL | required for server | Real upstream credential |
| CACHE_PORT | 4000 | Listen port; tests may inject ephemeral port through start(0) |
| CACHE_HOST | 127.0.0.1 | Bind host; non-loopback requires token |
| CACHE_AUTH_TOKEN | unset | Proxy authentication header value |
| CACHE_OFF | unset | 1 bypasses caching |
| CACHE_TTL_SEC | 604800 | Entry lifetime in seconds |
| CACHE_MAX_ENTRIES | 5000 | Maximum cache entries, including aliases |
| CACHE_LOG_LEVEL | info | silent, error, info or debug |
| CACHE_QUIET | unset | 1 is silent unless explicit log level takes precedence |
| CACHE_LOG_FILE | ~/.llm-cache-a/proxy.log | Additional file sink; none disables |
| CACHE_UPSTREAM_HOST | api.anthropic.com | Test/upstream override; no secret in value |
| CACHE_UPSTREAM_PORT | 443 | Upstream TCP port |
| CACHE_UPSTREAM_PROTO | https | http only for trusted local mocks |
| CACHE_MAX_REQUEST_BYTES | 33554432 | Maximum buffered request body |
| CACHE_MAX_RESPONSE_BYTES | 33554432 | Maximum retained response for cache/coalescing |
| CACHE_UPSTREAM_TIMEOUT_MS | 120000 | Upstream total request deadline |
| CACHE_MAX_MONITORS | 100 | Concurrent monitor connections |
| CACHE_REQUEST_TIMEOUT_MS | 2000 | Controller HTTP probe deadline |

The Node CLI preserves already-set environment values. Source-controller parsing
behavior is documented in the controller source. Configuration is read at startup.
`normalize.json` and `prices.json` live under `~/.llm-cache-a/`.
Prices map model substrings to nonnegative finite input/output dollars per token.
The longest matching substring wins, so a full model override beats a family rate.

## Troubleshooting

A test affected by exported CACHE_* variables needs harness isolation. Never fix it
by pointing tests at production. A 401 on local probes requires the same auth token.
Use 127.0.0.1 for IPv4 and ::1 for IPv6. An occupied port may belong to another app;
inspect ownership before changing it. See [runbooks](runbooks/operations.md).
