# Requirements

1. Proxy only the Anthropic Messages endpoint and preserve live/replayed body bytes.
2. Reuse complete successful responses only; never cache interrupted/error streams.
3. Isolate cache identity by body and relevant API context; normalization is opt-in.
4. Coalesce identical bounded in-flight requests and maintain TTL/LRU storage.
5. Expose health, stats, metrics and monitor routes; authenticate configured exposure.
6. Provide local setup, control and inspection without runtime npm dependencies.

Runtime: Node 18+, local disk and outbound HTTPS to the configured upstream. Development:
Node 22+, Python 3, Bash, curl and Git. No hardware minimum was benchmarked. Storage
is bounded by entry count and retained-response size, not a total byte quota. Metrics
ledger growth is unbounded. Request deadlines and buffer bounds limit resource use.
All npm dependencies were removed after source/CI consumer inspection; the Python
benchmark uses the standard library. See [known issues](known-issues.md).
