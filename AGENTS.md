# Agent guidance

Read [CLAUDE.md](CLAUDE.md), [development](docs/DEVELOPMENT.md) and the
[project wiki](docs/wiki/README.md) before changing this repository.

No repository-local agents are shipped under `.claude/agents/` or `.github/agents/`.
There are no required agent tools, models or external credentials for offline work.
Use focused agents when the requested workflow requires delegation; assign explicit
file ownership and preserve concurrent edits.

Maintain zero runtime dependencies and Node 18 compatibility. Use temporary homes,
synthetic keys and local mock upstreams. Do not access live cache data or restart
services to validate changes. Live paid tests, embeddings, research ingestion and
external messaging require their own task scope.

Complete repository-changing work by reviewing the diff, running the relevant checks,
staging only task-owned files, committing, pushing a task branch, opening/updating a
PR, waiting for final checks, merging and verifying content on remote main. Synchronize
a clean default checkout when safe. Preserve other worktrees, branches and dirty work.
Do not force-push or bypass required checks. Report exact delivery blockers.

Use the project tracker before changes: search for existing work, create/claim a task,
preserve durable constraints, and complete it after remote delivery. Keep nonsensitive
workflow logs as described in CLAUDE.md. Private workflow documents must be excluded
by basename at every depth from generated retrieval bodies.

<!-- llms-routing:pointer --> See `## llms routing` in CLAUDE.md for the llms files and quick answers.
