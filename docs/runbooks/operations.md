# Local operations runbook

## Diagnose without spending tokens

Precondition: use the intended installation and config. Run its `validate` command,
then source `status` and `stats` where available. Check host/port/token presence and
read `/health` without a paid POST. Health confirms liveness, not upstream auth.
If unavailable, inspect the owned process and local log. Preserve unrelated processes.
If a port belongs to another app, choose another port or resolve ownership manually.

## Configuration or upstream failure

Review config locally without printing credentials. Correct types/ranges and run
validate before deliberate restart. For an upstream auth error, rotate the provider
key and update config; do not repeatedly rerun paid requests. For timeouts, inspect
connectivity and logs. Escalate unresolved ownership/auth issues to the operator.

## Cache recovery

Precondition: retain any required response/accounting data privately. Inspect with
`node cache-explorer.mjs --list`. View one unambiguous key prefix. Invalidate only
a deliberate prefix and verify it disappears. Corrupt/hash-mismatched entries miss
safely. Do not delete the entire data directory to fix one entry.

## Roll back a delivered change

Use a new revert PR for the merged commit, run the offline gate and verify the
remote merge. Do not rewrite main. A source rollback does not restart an installed
service or publish an older npm release; handle deployment separately and deliberately.
