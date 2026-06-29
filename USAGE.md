# llm-cache-proxy — Usage Guide

Local-only, zero-dependency caching reverse proxy for the Anthropic Messages API
(`/v1/messages`). On an exact-match repeat it replays the byte-identical cached
response with **no upstream call** — a 100% token save per hit. Built for
rerun / eval / CI / dev-loop workloads.

- Quick reference: [Commands](#control-script-cachectl-ash) · [Env vars](#environment-variables) · [Endpoints](#http-endpoints) · [Examples](#examples)
- See also: [README](README.md) · [INSTALL](docs/INSTALL.md) · [ARCHITECTURE](docs/ARCHITECTURE.md)

---

## Install

```bash
brew tap mithudso/tap && brew install llm-cache-proxy   # Homebrew (macOS / Linux)
npm install -g llm-cache-proxy                          # npm   (or: npx llm-cache-proxy <cmd>)
git clone https://github.com/mithudso/llm-cache-proxy.git && cd llm-cache-proxy   # from source (full control surface)
```

The Homebrew/npm `llm-cache-proxy` command is the self-contained proxy + CLI and reads the key
from `$ANTHROPIC_API_KEY_REAL`. The cloned `cachectl-a.sh` control script reads it from `.env`
and adds start/stop/status/monitor/service-install.

## Quick start

```bash
./cachectl-a.sh on                               # first run: prompts for key + settings, writes .env (chmod 600), then starts
# -- or, for Homebrew/npm installs --
llm-cache-proxy on                               # same: prompts on first run, writes ~/.llm-cache-a/.env

export ANTHROPIC_BASE_URL=http://localhost:4000  # point Claude Code / SDK at the proxy
export ANTHROPIC_API_KEY=anything                # client key is ignored; the .env key is used
```

---

## Client compatibility

Works with any client that speaks the Anthropic **Messages API** (`POST /v1/messages`) and honors
`ANTHROPIC_BASE_URL`:

| Client | Works? | How |
|---|---|---|
| Claude Code (`claude`) | ✅ | `export ANTHROPIC_BASE_URL=http://localhost:4000` |
| Anthropic SDK (Python / TS) | ✅ | set `base_url` (or `ANTHROPIC_BASE_URL`) to the proxy |
| `curl` / scripts | ✅ | `POST http://localhost:4000/v1/messages` |
| Augment CLI ("Auggie") | ❌ | not supported (see below) |

**Auggie is not supported.** The Augment CLI ignores `ANTHROPIC_BASE_URL` (0 occurrences in its
binary) and never calls `api.anthropic.com`. It sends all traffic to Augment's own backend,
authenticated by an `auggie login` session (`~/.augment/session.json` / `AUGMENT_SESSION_AUTH`),
not an Anthropic key — so an Anthropic-`/v1/messages` cache has nothing to intercept, and setting
`ANTHROPIC_BASE_URL` before `auggie` simply has no effect. (Augment's server-side BYOK
`AUGMENT_ANTHROPIC_API_KEY` runs from Augment's servers, also outside a local proxy's path.)

---

## Control script (`cachectl-a.sh`)

```
./cachectl-a.sh <command>
```

| Command | What it does |
|---|---|
| `on` | Start the proxy with caching **enabled** (background; writes `~/.llm-cache-a/proxy.pid` + `proxy.log`). Auto-prompts for the key if missing (TTY only). |
| `off` | Start in **bypass** mode — forward every request upstream, cache nothing. |
| `restart` | Stop the running proxy then start it again cleanly (equivalent to `stop` + `on`). |
| `stop` | Stop the running proxy (also unloads the launchd plist on macOS to prevent `KeepAlive` restart). |
| `validate` | Check all config files for errors (key format, port range, `normalize.json` JSON + regex, `prices.json` schema); if the proxy is running, also hit `/health`, `/stats`, and `/metrics` and report. Exits 0 all-pass, 1 on error — safe in CI/boot scripts. |
| `stats` | Print **this-session** and **all-time** savings (live `/stats` if up; else the on-disk ledger). |
| `status` | Operational snapshot: process up + since when, accepting calls (`/health`), cache on/off, last call received, errors + recent log lines this run. |
| `monitor` | Realtime view — tail `GET /monitor` (SSE) as one readable line per served call. Shows `#seq`, type, model, tokens, cost, latency, and a response snippet. Ctrl-C to stop. |
| `explore` | Cache explorer TUI (browse / view / invalidate). Passes flags through to `cache-explorer.mjs` (`--list`, `--json`, `--view <key>`, `--invalidate <key>`). |
| `setup` | (Re-)run the key + settings wizard: prompt for key / port / TTL / max entries / bind host / auth token, write a `chmod 600` `.env`. |
| `run` | Foreground exec of the proxy — what a service manager's `ExecStart` calls. |
| `install` | Install a boot service that auto-restarts on failure: a **systemd** user unit (Linux) or a **launchd** agent (macOS). |
| `uninstall` | Remove the installed boot service. |
| `-h`, `--help`, `-?`, or any unknown command | Show this usage guide. |

---

## Proxy CLI (`llm-cache-proxy` / `node proxy-a.mjs`)

No arguments starts the server. With a subcommand it runs that routine and exits:

| Command | Output |
|---|---|
| `node proxy-a.mjs stats` | The full stats JSON (this-session + all-time). |
| `node proxy-a.mjs price <model>` | `[input_$per_token, output_$per_token]` for the model. |
| `node proxy-a.mjs usage <text>` | `{input_tokens, output_tokens}` parsed from a response body. |
| `node proxy-a.mjs key <model> <body>` | The exact-match cache key (`sha256(model + "\n" + body)`). |

The Homebrew/npm `llm-cache-proxy` CLI (via `cli.mjs`) is the cross-platform equivalent of
`cachectl-a.sh` for installed users:

| Command | What it does |
|---|---|
| `on` | Start with caching enabled. Prompts for the key on first run; writes `~/.llm-cache-a/.env`. |
| `off` | Start in bypass mode. |
| `restart` | Stop then start cleanly. |
| `stop` | Stop the proxy. |
| `stats` | Print live tokens/dollars saved. |
| `setup` | (Re-)run the key + settings wizard. |
| `validate` | Check config files + runtime health. Exits 0 all-pass, 1 on error. |

---

## Cache explorer (`cache-explorer.mjs`)

Interactive TUI (a terminal): `./cachectl-a.sh explore` or `node cache-explorer.mjs`
- `↑`/`↓` (or `j`/`k`) move · `Enter` view an entry · `d` / `x` invalidate · `r` refresh · `q` quit

Non-interactive (scriptable / testable):

| Flag | Effect |
|---|---|
| `--list` | One row per entry (key, model, age, size, tokens). |
| `--json` | All entries as JSON. |
| `--view <keyPrefix>` | Dump one entry's meta + the first 600 bytes of its body. |
| `--invalidate <keyPrefix>` | Delete every entry whose key starts with the prefix. |
| `--help` | Short flag help. |

---

## Environment variables

All optional; set in `.env` (sourced by `cachectl-a.sh`) or the environment.

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY_REAL` | *(required)* | The real Anthropic key the proxy sends upstream. Lives only in `.env`. |
| `CACHE_PORT` | `4000` | Listen port. |
| `CACHE_HOST` | `127.0.0.1` | Bind address. Loopback-only by default. A non-loopback value (e.g. `0.0.0.0`) **requires** `CACHE_AUTH_TOKEN`. |
| `CACHE_AUTH_TOKEN` | *(unset)* | When set, every route except `/health` requires the header `x-cache-auth: <token>`. Required to bind a non-loopback host. |
| `CACHE_OFF` | *(unset)* | `1` = bypass mode (forward everything, cache nothing). |
| `CACHE_TTL_SEC` | `604800` (7 d) | Cache entry time-to-live, in seconds. |
| `CACHE_MAX_ENTRIES` | `5000` | LRU cap; oldest entries are pruned past this. |
| `CACHE_LOG_LEVEL` | `info` | `silent` \| `error` \| `info` \| `debug`. |
| `CACHE_QUIET` | *(unset)* | `1` = alias for `CACHE_LOG_LEVEL=silent`. |
| `CACHE_LOG_FILE` | `~/.llm-cache-a/proxy.log` | Log file written alongside stdout. `none` disables the file sink. |
| `CACHE_UPSTREAM_HOST` | `api.anthropic.com` | Upstream host (overridden by the test suite to point at a mock). |
| `CACHE_UPSTREAM_PORT` | `443` | Upstream port. |
| `CACHE_UPSTREAM_PROTO` | `https` | `http` to talk to a local mock upstream. |

Pricing override: `~/.llm-cache-a/prices.json`, e.g. `{"haiku":[0.8e-6,4e-6]}` (matched by model substring).

---

## Partial caching (`normalize.json`)

By default the proxy uses an **exact-match** cache key: any difference in the request body — including timestamps in the system prompt or changing tool results — produces a different key and a MISS. The optional `normalize.json` file adds two additional key tiers that strip or ignore those dynamic parts before hashing.

**File location:** `~/.llm-cache-a/normalize.json`

The file is read once at proxy start. After editing it, restart the proxy (`./cachectl-a.sh restart`) for changes to take effect. Run `./cachectl-a.sh validate` to check for JSON or regex errors before restarting.

### Schema

```json
{
  "system_strip":  ["regex-1", "regex-2"],
  "message_strip": ["regex-3"],
  "suffix_only":   false,
  "suffix_turns":  3
}
```

| Field | Type | Default | Purpose |
|---|---|---|---|
| `system_strip` | `string[]` | `[]` | Regex patterns (ECMAScript, `g` flag) stripped from the **system prompt** before hashing. Each match is replaced with `<NORM>`. |
| `message_strip` | `string[]` | `[]` | Same, applied to each **message content** string (`gs` flag — dotAll so `.` matches newlines). |
| `suffix_only` | `boolean` | `false` | When `true`, also try a key built from only the last `suffix_turns` messages (ignoring older history). See caveats below. |
| `suffix_turns` | `integer` | `3` | Number of recent messages to include in the suffix key. Only used when `suffix_only: true`. |

All fields are optional. An empty object `{}` loads the feature but is a no-op (no patterns, no suffix).

### Tier 2 — normalized key (`HIT-NORM`)

When any pattern matches, the proxy computes a second hash after substitution. If a prior response was stored under that normalized hash, it is served as `x-cache: HIT-NORM` with no upstream call.

**Use `system_strip` for:**
- Timestamps and dates embedded in the system prompt (`"Current date: [^\\n]*"`)
- Session or request IDs (`"Session-ID: [a-f0-9-]+"`)
- Any field that changes every run but doesn't affect what the response should be

**Use `message_strip` for:**
- Tool results that carry volatile data the model doesn't need for its core answer (`"<tool_result>[\\s\\S]*?</tool_result>"`)
- Injected context snippets that vary but don't change the question

**Example — strip date + session from system prompt:**

```json
{
  "system_strip": [
    "Current date[^\\n]*",
    "Session-ID: [a-f0-9-]+"
  ],
  "message_strip": [],
  "suffix_only": false
}
```

With this config, these two requests produce the same normalized key and the second is a `HIT-NORM`:

```
Request 1 system: "Current date: 2026-01-01\nYou are helpful."
Request 2 system: "Current date: 2026-06-24\nYou are helpful."
```

Both normalize to `"<NORM>\nYou are helpful."` before hashing.

**JSON regex escaping note:** JSON doubles backslashes. The ECMAScript pattern `\d+` is written `"\\d+"` in JSON. The pattern `[\s\S]*?` (any character, non-greedy) is written `"[\\s\\S]*?"`.

### Tier 3 — suffix key (`HIT-SUFFIX`, gated)

When `suffix_only: true`, the proxy also tries a key built from `(model, system_normalized, messages[-suffix_turns:])` — the last N messages only, ignoring older conversation history. If a stored response matches that suffix, it is served as `x-cache: HIT-SUFFIX`.

**Use when:** you run repeated short exchanges that share the same final question, even from different conversation contexts. Example: an eval suite that asks the same follow-up question after different setup exchanges.

**Do not use when:**
- The response depends on earlier context that varies (the suffix key would serve a cached response from a different logical conversation)
- Messages include tool calls or tool results that must match the current context
- You need guaranteed accuracy over higher hit rates

```json
{
  "system_strip": ["Current date[^\\n]*"],
  "message_strip": [],
  "suffix_only": true,
  "suffix_turns": 2
}
```

### How alias writes work

On a MISS, the proxy stores the response under the **exact key** and also writes alias files under every active tier-2/3 key. This means:

1. First call with `system: "date: 2026-01-01 ..."` → MISS → writes under exact key **and** normalized key
2. Second call with `system: "date: 2026-06-24 ..."` → exact miss → finds alias under normalized key → `HIT-NORM`

### Checking your config

```bash
./cachectl-a.sh validate    # reports JSON parse errors and which patterns fail to compile
```

The `validate` command tests every regex with `new RegExp(pattern, 'gs')` and reports any that throw. Fix them before restarting.

---

## HTTP endpoints

| Method · Path | Purpose |
|---|---|
| `POST /v1/messages` | The proxied Anthropic Messages endpoint. HIT → replay; MISS → forward + cache. Header `x-cache-bypass: 1` forces a passthrough. Response carries `x-cache: HIT \| HIT-COALESCED \| MISS \| MISS-COALESCED \| ERROR`. |
| `GET /health` | `{"status":"ok"}` — always open (liveness), never requires the auth token. |
| `GET /stats` | JSON: top-level = **all-time** counters, nested `.session` = **this run** (calls, hits, hit_rate, tokens/usd saved, savings %). |
| `GET /metrics` | Prometheus exposition of the all-time counters. |
| `GET /monitor` | Server-Sent-Events stream; one event per served call (`seq`, `type`, `from_cache`, `stored`, `model`, tokens, `usd`, `ms`, `snippet`). |

When `CACHE_AUTH_TOKEN` is set, every endpoint except `/health` requires `x-cache-auth: <token>`.

---

## Network access & auth

The proxy injects the real key for **any** client that can reach it, so it binds **loopback by
default**. To expose it on a network set `CACHE_HOST`, which then requires `CACHE_AUTH_TOKEN`
(the proxy refuses to start a non-loopback bind without one):

```bash
CACHE_HOST=0.0.0.0 CACHE_AUTH_TOKEN=$(openssl rand -hex 18) ./cachectl-a.sh on
curl -H "x-cache-auth: <token>" http://<host>:4000/v1/messages ...
```

## Run as a service (start on boot, restart on failure)

```bash
./cachectl-a.sh install      # systemd user unit (Linux) or launchd agent (macOS)
./cachectl-a.sh uninstall    # remove it
```
Linux: a systemd **user** unit (`EnvironmentFile=.env`, `Restart=on-failure`, started at boot via
linger). macOS: a launchd agent (`RunAtLoad` + restart-on-failure) that sources `.env` via a wrapper.

---

## Files & paths

| Path | What |
|---|---|
| `<repo>/.env` | Key + settings for source installs (gitignored, `chmod 600`). |
| `~/.llm-cache-a/.env` | Key + settings for Homebrew/npm installs (written by `setup` / first `on`). |
| `~/.llm-cache-a/entries/` | Cache: one `.bin` (response) + one `.json` (meta) per entry. |
| `~/.llm-cache-a/metrics.jsonl` | Append-only ledger; seeds the counters on boot. |
| `~/.llm-cache-a/proxy.pid` | PID of the backgrounded proxy. |
| `~/.llm-cache-a/proxy.log` | Default log file. |
| `~/.llm-cache-a/prices.json` | Optional per-model pricing override (`{"haiku":[0.8e-6,4e-6]}`). |
| `~/.llm-cache-a/normalize.json` | Optional partial-cache config (system/message pattern stripping, suffix-key mode). |

---

## Examples

```bash
# Start, point a client at it, watch calls live
./cachectl-a.sh on
ANTHROPIC_BASE_URL=http://localhost:4000 claude -p "hello"
./cachectl-a.sh monitor

# Inspect & manage the cache
./cachectl-a.sh stats
./cachectl-a.sh explore --list
./cachectl-a.sh explore --invalidate 9f3a

# Measure savings (needs: pip install anthropic)
python bench.py --identical 5 --varied 0 --model claude-haiku-4-5-20251001 --base-url http://localhost:4000
```

---

## Testing

| Command | What |
|---|---|
| `npm test` | Zero-dep `node:test` suite vs a local mock upstream — **no network, no key, no paid calls** — enforcing 100% line + function coverage of `proxy-a.mjs`. (Needs Node ≥ 22 for built-in coverage.) |
| `npm run test:fidelity` | Live, **paid** byte-exact cold→warm replay proof against the real API (23/23). |
| `npm run check` | Syntax-check the JS entrypoints. |

The proxy itself runs on **Node ≥ 18**.
