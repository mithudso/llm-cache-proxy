# Bootstrap audit — 2026-11-12

Profile: existing local CLI/proxy, adapted mdb-tam standard. Bootstrap skill 5.4.1.
Baseline main: `14216fa`. Canonical package version becomes 2.0.7.

| Manifest area | Result |
|---|---|
| Workflow guidance | Updated CLAUDE, added AGENTS/GEMINI/Copilot; no project agents or mandatory MCP integrations invented |
| Workflow logs | Nonsensitive request/status logs; explicit swap-aware atomic archive tool |
| Editor/runtime | Existing EditorConfig/Git attributes/Node22 pin retained; VS Code debug/settings and empty MCP inventories |
| Repo hygiene | Ignore dependencies, coverage and private continuation state; preserve all unrelated worktrees/local keys |
| GitHub | Offline PR CI, legacy runtime smoke, release-tag validation, CODEOWNERS, templates, reporting and Dependabot |
| Documentation | Current architecture/development/components/security/testing/installation/requirements/operating guides |
| Wiki | Versioned docs/wiki/README.md links current commands, references and strategy |
| Retrieval | Deterministic public file/exports/dependency map, overview and llms family; private basenames excluded at every depth |
| Operations | Declarative library plus generated registry/route inventory and CI checks; external-call ledger |
| Dependencies | Eight unused npm tooling packages removed; lockfile audited with zero vulnerabilities |
| Hub | Existing project registration refreshed; wiki and offline validation activation registered |

## Adaptations and limits

- Keep the local zero-dependency runtime. Do not scaffold an application server,
  dashboard, MCP tool gateway, datastore or automatic paid remediation runner.
  [External calls](external-calls.md) and generated registry explicitly mark this
  profile rather than reporting the full five-standard template as satisfied.
- Embeddings and semantic watchers remain inactive. Public text/file indexes are
  sufficient for this task; no Ollama/Chroma dependency, re-embedding or daemon added.
- Existing historical machine-integration/skill notes are marked historical and
  excluded from retrieval bodies. They are preserved in VCS. Private workflow logs
  and archive paths are excluded from npm publishing with an explicit docs allowlist.
- Global Copilot skills are not duplicated or overwritten from project documentation.
  Installed skills remain the workflow entrypoints; the maintained repo docs are the
  source of project-specific facts.
- Existing prunable worktree registrations belong to earlier work on another path.
  This task does not delete them, stash work, touch real credentials/cache or restart
  user services.

## Validation and convergence

Initial baseline: 43 Node proxy tests plus 12 example cases passed, despite unsafe
protocol/control paths. Dependency audit found 31 vulnerabilities in unrelated tooling.
Source fixes and bootstrap checks are documented in the [optimizer receipt](code-deep-optimizer-2026-11-12.md).
The bootstrap review caught and repaired stale architecture claims, missing export
lists, weak route drift detection, log-rotation publication, release-tag shell
interpolation and a future workflow-archive package leak. The optimizer ended with bounded
BLIND-AUDIT-DISSENT; all seven findings from its two blind gates were subsequently
fixed with regressions. No third independent clean gate is claimed.

Native service activation, real-provider fidelity, paid benchmarking, embeddings,
external integration authentication and package publication were not performed.
