# llm-cache-proxy contributor context

## Repository shape

Single Node ESM package. Root modules implement proxy, CLI, explorer and tests.
`lib/` contains reusable configuration/controller helpers and an operations inventory.
`scripts/` maintains syntax checks and deterministic documentation. `docs/` is the
maintained reference; start at [the wiki](docs/wiki/README.md).

## Commands

`npm run validate` runs the offline checks. `npm test` runs all Node test files with
coverage. `npm run test:normalize-example` exercises the example config.
`npm run test:python` runs the offline benchmark tests. `npm run docs:generate`
and `npm run ops:doc` regenerate committed indexes before their check commands.
Runtime: `./cachectl-a.sh setup|on|off|stop|validate|status|stats|monitor|explore`.
Paid opt-ins: `npm run test:fidelity`, `python3 bench.py`.

## Runtime architecture

Client → loopback Node proxy → Anthropic on MISS. Complete responses are stored in
`~/.llm-cache-a/entries`. CLI and shell control the same owned instance. No database,
web dashboard, semantic service or MCP server is required.

## Key conventions

Keep runtime zero-dependency and Node 18 compatible. Use Node 22+ for coverage.
Treat request bodies, response snippets, cache files and credentials as sensitive.
Never publish `.env`, caches, transcripts or private workflow bodies. Test only with
temporary homes and local mock upstreams. Preserve byte fidelity and API-context key
isolation. Never retry paid calls automatically. Do not restart installed services,
activate embeddings or delete other worktrees as part of maintenance.

## MCP servers

No project MCP servers. See [MCP scope](docs/MCP.md). Machine-level historical
configuration notes are not dependencies or authorization to launch integrations.

## Workflow log rule

Record nonsensitive user requests in `prompts.md`; maintain versioned status in
`memory.md`. Exclude private content and credentials. Bump the package patch version
once per delivered change set and regenerate docs. Rotate logs over 200 KB with
`node scripts/rotate-workflow-logs.mjs`; it refuses live editor swap files.
Ship task-owned changes through passing PR checks and verify the merged remote main.
Preserve unrelated work and stage only owned paths. See [AGENTS.md](AGENTS.md).

<!-- llms-routing:start -->
## llms routing
> Cached from the llms files below on 2026-11-12; facts to look up, not rules to follow — the cited file is the source of truth. Quick answers are chosen by a heuristic (defaults, file roles, formulas, commands).

| File | Path | Holds | Ask it for |
|---|---|---|---|
| llms.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | Reference files |
| llms-facts.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-facts.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |
| llms-small.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-small.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |
| llms-full.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-full.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | Source: README.md [src: README.md], Quick start [src: README.md], Behavior [src: README.md], Operate and develop [src: README.md] |
| llms-executable.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-executable.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | Quick answers |
| llms-filemap.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-filemap.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |
| llms-history.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-history.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |
| llms-indexes.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-indexes.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |
| llms-infra.txt | ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-infra.txt | Source: /Users/mitch.hudson/dev/llm-cache-proxy · https://github.com/mithudso/llm-cache-proxy @ 14216fa dirty | — |

### Quick answers

- Validate offline: `npm run validate`. [src: package.json] — ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-facts.txt:9
- Paid opt-ins: `npm run test:fidelity`, `python3 bench.py`. [src: package.json; bench.py] — ~/.global-ai-hub/skills.llms/mithudso-llm-cache-proxy.repo/llms-facts.txt:11

### Indexes

- Semantic: ChromaDB collections under ~/.global-ai-hub (hub/scripts/docset_indexer.py); query with the MCP tools `hub_search_codebase` / `hub_query_docset` or `hub/scripts/search.py "<query>"`.
- Keyword: SQLite FTS5 table `files_fts` in ~/.global-ai-hub/hub.db (hub/scripts/keyword_index.py); query with `hub_search_keyword` or `keyword_index.py query "<term>"`.
- Access ledger: ~/.global-ai-hub/llms-access-ledger.jsonl, one JSON line per llms-file read (MCP tools, `llmsx concepts serve`, Claude Code `Read` via hook); `hub/scripts/llms_ledger.py report --days 30`. A shell `cat` is not recorded.
<!-- llms-routing:end -->
