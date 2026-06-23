# Install & Use — llm-cache-proxy

How to install, configure, run, and operate the proxy. For what it is and why, see the
[README](../README.md); for the design, see [ARCHITECTURE.md](ARCHITECTURE.md).

This guide is for a single user on their own machine (macOS or Linux). By the end you will
have the proxy running on `localhost:4000`, Claude Code routed through it, and cache hits
saving tokens.

---

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| **Node.js ≥ 18** | runs the proxy (zero npm dependencies) | `node --version` |
| **A real Anthropic API key** | the proxy calls `api.anthropic.com` on a cache miss | starts with `sk-ant-` |
| **Python 3 + `anthropic`** (optional) | only for `bench.py` | `python3 --version` |
| **`curl`** (optional) | quick `/health` and `/stats` checks | `curl --version` |

The proxy itself needs **only Node**. No build step, no `npm install`.

---

## 2. Install

**Option A — npm (recommended).** Installs the `llm-cache-proxy` command (zero deps, cross-platform):

```bash
npm install -g llm-cache-proxy
# or run without installing:  npx llm-cache-proxy <command>
```

With npm, the `llm-cache-proxy on|off|stop|stats` command replaces `./cachectl-a.sh` in the
steps below. Run it from a directory that holds your `.env` (Step 3), or export the key.

**Option B — from source:**

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git
cd llm-cache-proxy
chmod +x cachectl-a.sh
```

Or download a release tarball from the [Releases page](https://github.com/mithudso/llm-cache-proxy/releases),
unpack it, and `cd` in.

---

## 3. Configure the key

The proxy reads your **real** key from a gitignored `.env` file. This is the only place the
key lives. Never commit it.

```bash
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-your-real-key\n' > .env
```

`cachectl-a.sh` loads `.env` automatically on start.

---

## 4. Start it

```bash
./cachectl-a.sh on
```

Expected output:

```
READY after 1s (pid 12345).
Point Claude Code at it:
  export ANTHROPIC_BASE_URL=http://localhost:4000
  export ANTHROPIC_API_KEY=anything
```

Control commands:

| Command | Effect |
|---|---|
| `./cachectl-a.sh on` | start with caching enabled |
| `./cachectl-a.sh off` | start in bypass mode (forwards everything, caches nothing) |
| `./cachectl-a.sh stop` | stop the proxy |
| `./cachectl-a.sh stats` | print live counters (tokens/dollars saved) |

To run the proxy directly (e.g. under a process manager): `ANTHROPIC_API_KEY_REAL=… node proxy-a.mjs`.

---

## 5. Point your client at it

The proxy speaks the Anthropic Messages API. Set the base URL; the client-side key is ignored
(the proxy uses the real key from `.env`).

**Claude Code:**

```bash
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=anything
claude   # now routes through the cache
```

**Anthropic SDK (Python):**

```python
import anthropic
client = anthropic.Anthropic(base_url="http://localhost:4000", api_key="anything")
client.messages.create(model="claude-haiku-4-5-20251001", max_tokens=64,
                       messages=[{"role": "user", "content": "hi"}])
```

**curl:**

```bash
curl -s http://localhost:4000/v1/messages \
  -H 'content-type: application/json' -H 'anthropic-version: 2023-06-01' -H 'x-api-key: anything' \
  -d '{"model":"claude-haiku-4-5-20251001","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
```

Run the same request twice: the second response carries `x-cache: HIT` and makes no upstream call.

---

## 6. Verify

```bash
curl -s http://localhost:4000/health     # {"status":"ok"}
npm test                                 # fidelity + concurrency proof (needs the key); expect 23/23
curl -s http://localhost:4000/stats      # cumulative tokens/dollars saved
```

`npm test` runs `test-fidelity.mjs`, which proves byte-exact cold→warm replay for streaming,
tool_use, and streaming+tool_use, plus request coalescing.

---

## 7. Configuration

All configuration is via environment variables (set before `./cachectl-a.sh on`):

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY_REAL` | — (required) | your real Anthropic key (set in `.env`) |
| `CACHE_PORT` | `4000` | port to listen on |
| `CACHE_TTL_SEC` | `604800` (7d) | cache entry lifetime |
| `CACHE_MAX_ENTRIES` | `5000` | LRU cap on stored entries |
| `CACHE_OFF` | unset | `1` = bypass (forward all, cache nothing); same as `cachectl-a.sh off` |
| `CACHE_QUIET` | unset | `1` = silence per-request logs (endpoints still work) |

**Per-model pricing** (drives `usd_saved`): matched by substring on the model id
(`haiku`/`sonnet`/`opus`, default opus). Override or extend by writing
`~/.llm-cache-a/prices.json`, e.g. `{"haiku":[0.0000008,0.000004]}` (`[input, output]` $/token).

**Where data lives:** `~/.llm-cache-a/entries/` (cached responses), `~/.llm-cache-a/metrics.jsonl`
(per-call log), `~/.llm-cache-a/proxy.log` (stdout). All outside the repo.

---

## 8. Monitoring

| Surface | What |
|---|---|
| `GET /stats` | JSON: calls, hits, hit_rate, tokens_saved, usd_saved, usd_spent, savings_pct |
| `GET /metrics` | Prometheus text (`llm_cache_*_total`) — scrape into Prometheus/Grafana |
| `./cachectl-a.sh stats` | pretty-prints `/stats` |
| `proxy.log` | one structured line per request (`HIT`/`MISS`/`ERROR`) with tokens, dollars, latency |

Counters seed from `metrics.jsonl` on boot, so totals survive a restart.

---

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `ERROR: ANTHROPIC_API_KEY_REAL not set` | `.env` missing or empty; recreate it (Step 3) |
| Connection refused on `localhost` | should not happen (dual-stack bind); confirm the proxy is up: `curl 127.0.0.1:4000/health` |
| Port already in use | another proxy is running: `./cachectl-a.sh stop`, or set `CACHE_PORT` |
| `npm test` fails to connect | proxy not running; `./cachectl-a.sh on` first |
| 0% hit rate | requests are not byte-identical (any field differs ⇒ a new key); the cache only hits exact full-call repeats |
| 401 from upstream | the key in `.env` is wrong or revoked; rotate it at console.anthropic.com |

---

## 10. Uninstall

```bash
./cachectl-a.sh stop
rm -rf ~/.llm-cache-a      # cache, metrics, logs
rm -rf <clone dir>         # the repo (contains your .env — delete it deliberately)
```
