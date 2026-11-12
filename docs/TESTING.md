# Test strategy

## Offline suites

| Command | Scope |
|---|---|
| npm run check | Syntax of all tracked/new source modules, Bash and Python |
| npm test | All *.test.mjs in isolated Node test processes; mock upstreams and temp homes |
| npm run test:normalize-example | Example patterns, no real upstream |
| npm run test:python | Benchmark cost classification and raw HTTP against a local fixture |
| npm run docs:check | Deterministic indexes and local Markdown paths |
| npm run ops:doc:check | Generated operations and route inventory drift |
| npm run validate | Combined offline gate |

Use `node --test <file>.test.mjs` for a focused run. The proxy harness imports after
setting a temporary home, synthetic key and mock endpoint. Each file boots one proxy
and tears down connections and files. Controller tests copy only owned scripts into
disposable fixtures; signals never target the live installation.

## Coverage policy

Important and changed paths need assertions on bytes, headers, upstream call counts,
error termination, file permissions and logs. The CI gate enforces 95% lines, 95%
functions and 90% branches for `proxy-a.mjs`. The former blanket 100% gate excluded
many defensive paths while missing trust-boundary defects. The new gate keeps a
numeric regression floor while allowing real defensive branches; no new coverage
exclusions should be added to hide failures. Helpers/controllers also receive
behavior tests, although their coverage is not part of that numeric gate.

Node 22+ supplies the coverage flags. CI checks Node 22 and 24; runtime remains Node
18-compatible. A separate legacy-runtime smoke run exercises the suite without
coverage flags. Concurrency between files is safe because each uses temporary homes
and ephemeral ports. Disk-HIT assertions poll for metadata publication. Short observation windows remain
for negative asynchronous assertions; avoid longer arbitrary sleeps in new tests.

## Paid/manual tests

`npm run test:fidelity` uses a running proxy and real Anthropic key. It checks live
SSE/tool-use fidelity and coalescing. `python3 bench.py` sends paid misses and reports
cache classification and estimated dollar savings. Neither runs automatically in CI.
No live proof, reboot acceptance, native Windows service acceptance or performance
improvement is established by the offline suite.
