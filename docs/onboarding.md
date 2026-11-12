# Onboarding

1. Read [README](../README.md) and the [wiki](wiki/README.md).
2. Use Node22+ and Python3; run `npm run validate` without real credentials.
3. Read [architecture](ARCHITECTURE.md) and [components](COMPONENTS.md).
4. Add a failing test with a mock upstream or temporary controller fixture.
5. Implement, regenerate docs/inventories if needed, and rerun the gate.
6. Review secrets and the final diff, then deliver through a checked PR.

Do not use the live cache as test data. Production setup is separate from development.
