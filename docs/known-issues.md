# Known limits

- Metrics ledger is append-only and loaded at startup; large history increases startup
  memory/time. Preserve accounting history before any manual archival.
- Entry count includes normalized/suffix aliases; this is not a byte quota. Expired
  files remain until eviction or explicit invalidation.
- Normalization and suffix matching can serve a semantically inappropriate response;
  they remain opt-in. Structured system/content blocks are not regex-normalized.
- Oversized upstream responses stream to the primary client without retained replay;
  coalesced waiters may need independent upstream requests.
- Existing legacy cache files may retain permissive permissions. New files are private.
- Native Windows process control and Linux/macOS service-manager activation are not
  established by temporary-fixture tests on macOS. Reboots were not tested in this run.
- Live API fidelity and performance were not remeasured. The historical technical
  review is an archive, not evidence of current live behavior.
- No dashboard, centralized remediation agent, generic operations runner or datastore
  service is shipped. The operations inventory explicitly records these adaptations.
