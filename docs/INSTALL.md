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

Three ways. **Homebrew** is easiest on macOS/Linux; **npm** suits Node users; **source**
gives you the bench and tests.

**Option A — Homebrew:**

```bash
brew install mithudso/tap/llm-cache-proxy
# or:  brew tap mithudso/tap && brew install llm-cache-proxy
```

**Option B — npm:**

```bash
npm install -g llm-cache-proxy        # installs the `llm-cache-proxy` command
# or run without installing:  npx llm-cache-proxy <command>
```

With Homebrew or npm, `llm-cache-proxy on|off|restart|stop|stats|setup|validate` replaces
`./cachectl-a.sh`. The first `llm-cache-proxy on` prompts for your key and writes it to
`~/.llm-cache-a/.env` automatically — no separate Step 3 required.

**Option C — from source:**

```bash
git clone https://github.com/mithudso/llm-cache-proxy.git
cd llm-cache-proxy
chmod +x cachectl-a.sh
```

Or download a release tarball from the [Releases page](https://github.com/mithudso/llm-cache-proxy/releases),
unpack it, and `cd` in.

---

## 3. Configure the key

**Homebrew/npm:** skip this step — `llm-cache-proxy on` will prompt for your key on first run and write it to `~/.llm-cache-a/.env` (chmod 600) automatically.

**Source install:** the proxy reads your real key from a gitignored `.env` in the repo root. The easiest way:

```bash
./cachectl-a.sh setup    # interactive wizard: prompts for key + port/TTL/host, writes .env (chmod 600)
```

Or manually:

```bash
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-your-real-key\nCACHE_PORT=4000\nCACHE_HOST=127.0.0.1\n' > .env
chmod 600 .env
```

The key lives only in `.env`. Never commit it — it is gitignored.

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
| `./cachectl-a.sh on` | start with caching enabled (prompts for key on first run) |
| `./cachectl-a.sh off` | start in bypass mode (forwards everything, caches nothing) |
| `./cachectl-a.sh restart` | stop then start cleanly |
| `./cachectl-a.sh stop` | stop the proxy |
| `./cachectl-a.sh validate` | check config files for errors + runtime health if proxy is up |
| `./cachectl-a.sh stats` | print live counters (tokens/dollars saved) |
| `./cachectl-a.sh status` | full operational snapshot (process, cache mode, last call, recent errors) |
| `./cachectl-a.sh monitor` | realtime call stream (`#seq` type model tok $ ms \| snippet) |

Homebrew/npm equivalent: `llm-cache-proxy on|off|restart|stop|stats|setup|validate`

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
./cachectl-a.sh validate        # config syntax + /health /stats /metrics check (exits 1 on error)
curl -s localhost:4000/health   # {"status":"ok"}
curl -s localhost:4000/stats    # JSON: calls, hits, hit_rate, tokens/dollars saved
```

`validate` is the quickest way to confirm everything is wired up correctly. It checks the key format, port, any optional config files (`normalize.json`, `prices.json`), and the live endpoints if the proxy is running.

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
| Not sure if configured correctly | run `./cachectl-a.sh validate` (or `llm-cache-proxy validate`) — exits 1 and names the problem |
| `ANTHROPIC_API_KEY_REAL not set` | `.env` missing or key absent; run `./cachectl-a.sh setup` to re-create it |
| Connection refused on `localhost` | proxy not running; `./cachectl-a.sh on` to start, `./cachectl-a.sh status` to diagnose |
| Port already in use | another proxy is running: `./cachectl-a.sh restart`, or change `CACHE_PORT` |
| 0% hit rate | requests are not byte-identical; the default tier only hits exact full-call repeats. Add `~/.llm-cache-a/normalize.json` if timestamps/session IDs vary |
| 401 from upstream | the key in `.env` is wrong or revoked; rotate it at console.anthropic.com, then `./cachectl-a.sh setup` |

---

## 10. Uninstall

```bash
./cachectl-a.sh stop
rm -rf ~/.llm-cache-a      # cache, metrics, logs
rm -rf <clone dir>         # the repo (contains your .env — delete it deliberately)
```
