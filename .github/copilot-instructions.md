## Default Execution Strategy

Read relevant files before editing. Run the relevant checks after changes. Never
invent commands or paths. Follow the nonsensitive workflow log rule in CLAUDE.md.
Complete authorized delivery through a verified merge; preserve unrelated work.

## Orientation

Start at docs/wiki/README.md, docs/DEVELOPMENT.md and docs/ARCHITECTURE.md.

## Build, Test, and Validation Commands

`npm run validate`; `npm test`; `node --test proxy.test.mjs`;
`npm run docs:generate`; `npm run ops:doc`. Paid tests are opt-in.

## High-level Architecture

Local client → Node proxy → Anthropic on MISS; private filesystem replay on HIT.
Node CLI and Bash controller manage an owned local process. No build step.

## Key Conventions

Keep zero dependencies. Preserve Node 18 runtime compatibility. Test with temporary
homes. Never publish credentials or cache bodies. Partition keys by API context.
Preserve response bytes. Do not retry paid requests. Do not modify live services.
