# Security model

## Boundaries and principals

The operator owns a local process, real Anthropic key and plaintext cache. A client
that reaches `/v1/messages` can spend that key. The proxy binds loopback by default;
non-loopback exposure requires a shared `CACHE_AUTH_TOKEN`. This is a local operator
tool, not a tenant-isolated gateway. It does not provide TLS on its listening socket.

## Threat model

| Threat | Mitigation / limit |
|---|---|
| Spoofing | Shared x-cache-auth on all routes except exact /health; loopback default |
| Tampering | API-context cache identity, complete-stream checks, validated config and coherent cache reads |
| Repudiation | Request outcomes and metrics ledger; no tamper-proof audit trail |
| Information disclosure | New cache files private; real key replaces client auth; local control headers stripped |
| Denial of service | Request/retained-response bounds, deadlines, backpressure and monitor limits |
| Elevation of privilege | Config parsed as data; positive PID and matching command required before signals |

Setup writes config privately. Do not follow config-file symlinks. Existing legacy
cache files may have older permissions; review them privately before reuse. Cached
response bodies and `/monitor` snippets can contain private text. The cache and ledger
are unencrypted; filesystem access is the security boundary. There is no compliance
attestation, customer-data isolation or encryption-at-rest claim.

## Contributor and incident guidance

Never commit real credentials, local cache bodies, transcripts or customer exports.
Use synthetic markers in tests. Validate headers, input shapes and log contents.
Do not print keys while diagnosing configuration; use presence-only status.
Rotate compromised keys at the provider and update local config deliberately.
Stop only the verified owned instance. Review logs locally; do not paste private
response snippets into public issues. See [reporting](../.github/SECURITY.md).
