# Local-Only LLM Cache (LiteLLM) for Claude Code

Returns cached Anthropic responses from local disk with **no upstream call** on a
byte-identical repeat — 100% token save on hits. Built for rerun/eval/CI workloads.

## Install
Already done in a local venv (`.venv/`, Python 3.13 — litellm needs <3.14). To rebuild:
```bash
python3.13 -m venv .venv --clear
./.venv/bin/pip install -r requirements.txt
```
`cachectl.sh` runs litellm from `.venv` automatically.

## Run
```bash
export ANTHROPIC_API_KEY_REAL=sk-ant-...      # your REAL Anthropic key — SHELL env, never a file
./cachectl.sh on                              # start proxy + cache on :4000
# in the Claude Code shell:
export ANTHROPIC_BASE_URL=http://localhost:4000
export ANTHROPIC_API_KEY=sk-local-cache       # the local virtual key
```
Bypass: `./cachectl.sh off` (proxy stays up, caching disabled).
Stop: `./cachectl.sh stop`. Stats: `./cachectl.sh stats`.

## Verify it actually saves (the real numbers)
```bash
python bench.py --identical 5 --varied 5 --model claude-haiku-4-5-20251001
./cachectl.sh stats
```
Expect the identical block to drop ~80% (1 cold + 4 hits); varied block unchanged.

## Fidelity gate (do this before trusting it for real work)
LiteLLM may not reproduce Anthropic-native streaming `tool_use`/`thinking` framing
byte-for-byte. Run a real Claude Code tool-use turn twice (miss, then hit) and confirm
the tool loop behaves identically. If it breaks and config can't fix it, fall back to a
hand-rolled byte-exact reverse proxy (spec §Fidelity gate).

## Guardrails
- Only complete 200 responses are cached (errors/partials skipped).
- `~/.llm-cache` disk store, 7d TTL, 2 GB LRU cap.
- Fail-open: cache faults forward upstream, never block a turn.
- Plaintext local store — `~/.llm-cache` is gitignored; don't commit it.

Files: `config.yaml` (cache on), `config.nocache.yaml` (bypass), `callback.py`
(metrics + segment analytics), `cachectl.sh` (control), `bench.py` (measurement).
