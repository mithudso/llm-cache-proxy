# Caching and optimization

The persistent store holds response `.bin` and metadata `.json` pairs under
`~/.llm-cache-a/entries`. Exact, normalized and suffix tiers use the same underlying
response bytes. Metadata includes time, model, content type and usage; new entries
include a body hash so torn/concurrent publication is treated as a miss. Legacy
entries without a body hash remain readable.

TTL is checked on reads. LRU touches payload mtime; a throttled sweep runs when the
entry count exceeds CACHE_MAX_ENTRIES. Aliases consume entries. The in-memory inflight
map coalesces identical requests. Interrupted/oversized responses are not reusable.
No semantic/vector cache or embedding pipeline is active.

Async disk I/O keeps the request path responsive. Request and retained-response caps,
upstream deadline, downstream backpressure and monitor limits bound expensive paths.
Use `node --cpu-prof proxy-a.mjs` only in a disposable, explicitly configured mock
instance. Profiles can capture private data; do not attach them publicly by default.
`python3 bench.py` is a live paid benchmark, not an offline gate. No quantitative
speedup is claimed by this maintenance run.
