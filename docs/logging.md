# Logging and sensitive data

The proxy emits timestamped outcome lines to stdout and, by default,
`~/.llm-cache-a/proxy.log`. Levels are silent, error, info and debug. CACHE_QUIET=1
is a silent alias unless CACHE_LOG_LEVEL overrides it. CACHE_LOG_FILE=none disables
the additional file sink; a controller may still redirect process stdout to its log.
The ledger `metrics.jsonl` stores counters and pricing inputs. It seeds totals at boot.
`/monitor` emits live SSE outcomes and can include an 80-character response snippet.

Never log credentials or request headers/bodies. Use stable operation/error names
and numeric metadata. Treat model values and upstream messages as untrusted; avoid
copying private caught payloads into diagnostics. Test changed error logs with
synthetic markers. Monitor snippets and cache inspection intentionally expose local
response content; keep their consumers within the same auth/privacy boundary.

There is no centralized errors.jsonl, remote telemetry or automatic remediation loop.
The [external-call inventory](external-calls.md) records local diagnostics and retries.
