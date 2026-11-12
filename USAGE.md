# Usage guide

## Controllers

The installed `llm-cache-proxy` command (`cli.mjs`) supports `on`, `off`, `restart`,
`stop`, `stats`, `setup` and `validate`. With no command it prints help.

The source `./cachectl-a.sh` supports those commands plus `status`, `monitor`,
`explore`, `run`, `install`, `uninstall` and `--help`.
`off` starts bypass mode: requests still go upstream and incur cost.
`stop` stops the owned instance. Service install/uninstall changes user services.
Both controllers verify PID identity before signaling a process.

Use `127.0.0.1` for the default IPv4 bind. For an IPv6 bind, use `[::1]` in URLs.
Source config comes from `<repo>/.env`; installed config comes from
`~/.llm-cache-a/.env`, with `./.env` as fallback. Config is parsed as data.
Shell code and command substitution in `.env` are never executed.

## HTTP endpoints

| Method | Path | Result |
|---|---|---|
| POST | `/v1/messages` | MISS forwards; HIT replays bytes |
| GET | `/health` | Open liveness probe |
| GET | `/stats` | All-time counters and nested `.session` counters |
| GET | `/metrics` | Prometheus text |
| GET | `/monitor` | Live SSE events; may contain response snippets |

When configured, send `x-cache-auth: <token>` to every endpoint except `/health`.
`x-cache-bypass: 1` disables caching for a request. `x-cache` identifies `MISS`,
`HIT`, `HIT-NORM`, `HIT-SUFFIX`, `HIT-COALESCED`, `MISS-COALESCED` or `ERROR`.
A successful liveness probe does not prove an API key works upstream.

## Cache inspection

```bash
node cache-explorer.mjs --list
node cache-explorer.mjs --json
node cache-explorer.mjs --view abcd
node cache-explorer.mjs --invalidate abcd
```

Use a hexadecimal prefix of 4–64 characters. Viewing requires one match;
invalidation deletes all matches. The interactive TUI supports arrows or j/k,
Enter, d/x to invalidate, r to refresh, and q/Ctrl-C to exit. Human displays escape
terminal controls; JSON output remains machine-readable. Cache bodies can contain
private response text. Keep exported JSON and inspected bodies private.

## Partial matching

Copy `normalize.json.example` to `~/.llm-cache-a/normalize.json`, review the patterns,
run `./cachectl-a.sh validate`, then restart deliberately.
`system_strip` and `message_strip` are arrays of JavaScript regex strings applied
to string system/message content. Matches become `<NORM>`. Structured content blocks
are preserved. `suffix_only` defaults false; `suffix_turns` defaults to 3 and must
be a positive integer. Suffix matching ignores earlier messages and may serve an
answer from a different conversation. Patterns can also merge semantically distinct
requests. Use only when your workload justifies these equivalences.

## Configuration and paths

[Development](docs/DEVELOPMENT.md) lists every environment variable.
[Architecture](docs/ARCHITECTURE.md) explains storage and key identity.
[Installation](docs/INSTALLATION.md) covers services, upgrades and removal.
[Runbooks](docs/runbooks/operations.md) cover diagnosis and recovery.
