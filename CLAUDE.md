# CLAUDE.md — llm-cache-proxy

Local-only, zero-dependency caching reverse proxy for the Anthropic Messages API
(`/v1/messages`). On an exact-match repeat it replays the byte-identical cached
response with **no upstream call** → 100% token save per hit. Built for
rerun/eval/CI/dev-loop workloads (high full-call repeat rate).

## Canonical implementation
- `proxy-a.mjs` — the proxy (Node, **zero dependencies**: `node:http/https/crypto/fs`).
- `cachectl-a.sh` — control: `on` | `off` (bypass) | `stop` | `stats`.
- `bench.py` — measures savings (needs `pip install anthropic`; not required to run the proxy).

## Deprecated (do not extend)
`config.yaml`, `config.nocache.yaml`, `callback.py`, `cachectl.sh`, `requirements.txt`
are the abandoned LiteLLM attempt, kept for history. LiteLLM was dropped: ~87s import,
>120s flaky startup, the `/v1/messages` passthrough route bypassed the cache, and
master_key+wildcard routing required a Prisma DB. See docs/ARCHITECTURE.md.

## Run
```bash
printf 'ANTHROPIC_API_KEY_REAL=sk-ant-...\n' > .env   # real key; gitignored
./cachectl-a.sh on
export ANTHROPIC_BASE_URL=http://localhost:4000
```

## Secrets (hard rule)
The real Anthropic key lives ONLY in `.env` (gitignored). Never commit it; never
write it into any tracked file. `cachectl-a.sh` sources `.env` at start.

## Notes
- Cache store + metrics live in `~/.llm-cache-a/` (outside the repo).
- Exact-match key = `sha256(model + "\n" + raw request body)`. No semantic matching.
- Only complete 200 responses are cached (streaming requires `message_stop`). Fail-open.
- Dual-stack bind so both `localhost` (::1) and `127.0.0.1` work.
