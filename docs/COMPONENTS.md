# Components and library usage

| Module | Public surface | Inputs / effects |
|---|---|---|
| proxy-a.mjs | start, createServer, requestHandler, usageFrom, priceFor, usd, statsObj | Reads config at import, creates cache directory; HTTP server, cache and ledger writes |
| cli.mjs | Installed executable | on/off/restart/stop/stats/setup/validate; local files, child process, read-only probes |
| cachectl-a.sh | Source executable | Full control and user-service commands; delegates safe config/process helpers |
| cache-explorer.mjs | listEntries, invalidate; executable CLI/TUI | Reads cache; explicit deletion by full key; import has no CLI execution |
| lib/controller.mjs | parseEnvText, serializeEnv, loadEnvFile, writeEnvFile, readControllerConfig, requestLocal, readProxyPid, processCommand, isProxyCommand, stopProxy | Reusable env/config, bounded HTTP and process ownership helpers |
| lib/proxy-config.mjs | limits | Frozen startup-captured runtime limits |
| lib/proxy-validation.mjs | readLimits, validatePrices, validateNormalization | Pure runtime/optional JSON validators shared with controllers |
| lib/operations-registry.mjs | operations | Declarative inventory only; performs no remote calls |
| bench.py | call, cost, estimated_costs, main | Standard-library live benchmark; paid misses |
| test-fidelity.mjs | Executable proof | Live and paid; requires explicit invocation |
| test-helpers.mjs | boot, post, get, request, uniq, sleep, waitFor, jsonResponder | Temporary mock proxy fixture; tests only |
| scripts/ | Syntax, index, registry, log-rotation entrypoints | Local maintenance; no runtime requirement |

The proxy uses Node built-ins and proxy configuration helpers. Controllers share
`lib/controller.mjs`; the explorer is independent of the proxy server. Libraries
are shipped in the npm package and use Node built-ins only.

Example of the pure configuration helper:

```js
import { parseEnvText, serializeEnv } from '../lib/controller.mjs';
const values = parseEnvText('CACHE_PORT=4100\n');
const safeFile = serializeEnv(values);
```

Import helpers directly for tests rather than executing the controllers. Importing
`proxy-a.mjs` reads its environment and initializes its cache directory, so use a
temporary HOME before import. The server functions use startup-captured configuration;
they are intended for one instance per process. Read source exports before adding
library callers, and run the owning behavior suite after changing a shared helper.
