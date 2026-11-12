# Architecture

## Context and containers

```text
Client (Messages API)
        | HTTP + optional x-cache-auth
        v
Local Node proxy ---- MISS / real key ----> Anthropic HTTPS
        |
        +---- complete bounded response ----> private filesystem cache
        +---- outcome ----------------------> metrics ledger + local logs
        +---- live event -------------------> authenticated monitor clients

Node CLI / Bash controller --> owned proxy process + read-only health probes
Cache explorer            --> local cache files (explicit invalidation)
```

This is one Node ESM package without runtime npm dependencies. `proxy-a.mjs` owns
HTTP forwarding, caching and monitoring. `lib/proxy-config.mjs` captures validated
limits from `lib/proxy-validation.mjs`. Controllers share `lib/controller.mjs` for
safe configuration, bounded probes and process identity. The independent explorer
reads the same store. The benchmark uses Python's standard library.

## Request flow and identity

1. Match supported endpoints and authenticate all except exact `GET /health`.
2. Read a bounded Messages request and validate usable model/body shape.
3. Hash model, raw body and API context. Query strings and response-affecting
   Anthropic headers partition exact, normalized, suffix and inflight keys.
4. Try exact disk hit, then opt-in normalized/suffix aliases. Check TTL and any
   stored body digest before replaying bytes.
5. Join an identical in-flight operation or forward one upstream request.
6. Stream with backpressure, enforce a deadline, and settle aborted operations.
7. Publish a complete bounded 200 response, record actual persistence and outcome.

The legacy default key is `sha256(model + "\\n" + raw body)` when the default path
has no additional API context. Header/query context produces a separate namespace.
`node proxy-a.mjs key <model> <body>` computes the legacy default key only.
Normalization substitutes selected string fields. Suffix mode also drops earlier
messages; both deliberately weaken semantic identity and remain opt-in.

A stream requires a terminal SSE event frame rather than a substring in response
text. A truncated or oversized response cannot be a reusable hit. Oversized bodies
continue streaming to the primary client; waiters can fall back to their own fetch.
The primary client's abort cancels its upstream request; waiters can then retry
through their own fetch path. No blanket automatic paid retry policy is introduced.

## Storage and deployment

`~/.llm-cache-a/entries/<key>.bin` holds raw bytes; `.json` holds timestamp, content
type, optional content encoding, model, usage and, for new entries, body hash. Temporary files and rename prevent
partial individual-file publication; a digest rejects mismatched pairs. A mismatch
can cause a safe miss during concurrent alias writes. Legacy pairs remain readable.
New directories/files use restrictive permissions. Existing historical files are
not recursively rewritten. TTL checks reads; LRU uses payload mtime and entry count.

The proxy listens on `127.0.0.1:4000` by default. It does not bind dual-stack by
default. A non-loopback host requires a shared token, and the listening socket is
HTTP. User services are explicit source-controller operations. No deployment or
service activation occurs as a side effect of repository maintenance.

## Decisions and constraints

- Keep Node built-ins rather than restoring the removed LiteLLM runtime. The historical
  evaluation reported slow/flaky startup and no passthrough cache hits; those figures
  are historical evidence, not measurements of this version.
- Keep byte-exact replay and explicit optional equivalences rather than semantic matching.
- Do not retry paid operations automatically or add dashboards/databases just for audit
  symmetry. The local CLI, metrics and monitor are the operational surface.
- Keep numeric coverage gates alongside behavioral boundary tests; 100% reported lines
  alone did not prove header identity, stream completion or safe process control.

See [security](SECURITY.md), [known limits](known-issues.md), [logging](logging.md)
and [library APIs](COMPONENTS.md). Current live fidelity, performance, service reboots
and native Windows acceptance require separate validation.
