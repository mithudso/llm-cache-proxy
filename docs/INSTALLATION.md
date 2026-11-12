# Installation and removal

## Source

Install Node 18+ (Node 22+ for coverage), Bash and curl. Clone the repository.
No npm or Python runtime dependencies are needed. Run `./cachectl-a.sh setup`, then
`./cachectl-a.sh on`. Setup stores the real key in ignored `<repo>/.env` with mode600.
Point clients at `http://127.0.0.1:4000`. See [usage](../USAGE.md) for auth and IPv6.

## Installed package

`npm install -g llm-cache-proxy` supplies the `llm-cache-proxy` command. Homebrew users
can use `brew install mithudso/tap/llm-cache-proxy`. Published packages may lag main;
these commands install the published release. `llm-cache-proxy setup` stores config
in `~/.llm-cache-a/.env`; use `llm-cache-proxy on` to start.

## Verify and operate

`./cachectl-a.sh validate` checks source config and read-only runtime endpoints.
`curl http://127.0.0.1:4000/health` confirms liveness only. Use the auth header for
stats/metrics when configured. `npm run validate` is the offline development gate.

Source users can explicitly install a user boot service with `./cachectl-a.sh install`.
Linux uses systemd user services; macOS uses launchd. `uninstall` removes the user
service. Do not install or reload services merely to test repository edits.

## Upgrade and uninstall

Stop the owned instance deliberately before upgrading its installation, preserve
`.env` and local cache data, update source or the package, validate config, then
restart. An ordinary repository merge does not update a published npm/Homebrew release.

Remove a source boot service with `./cachectl-a.sh uninstall` before removing the
checkout. `./cachectl-a.sh stop` or `llm-cache-proxy stop` stops the owned process.
Use `npm uninstall -g llm-cache-proxy` or `brew uninstall llm-cache-proxy` for packages.
Cache/config data under `~/.llm-cache-a/` is retained; remove it only deliberately
when you no longer need its secrets, responses or accounting history.
