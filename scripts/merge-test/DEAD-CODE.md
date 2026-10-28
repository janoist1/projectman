# Dead-code merge check

`npm run dead-code` runs the locally installed, pinned Knip against `knip.json`.
`npm run knip` prints its raw JSON report. `npm run dead-code:update` explicitly writes
the current findings to the baseline; review that diff before committing.
The merge runner runs it before workspace checks, including when the selected test scope
is empty. Sharded runs execute it only on shard 1. Dry runs print the command without
executing it. The check is not covered by the workspace step cache.

Only unused files, value exports and type exports are checked. Runtime entrypoints
(screenshot scenarios, cloud probes, fake CLIs, service worker and CLI/build entrypoints)
are configured as entries so their imports are still analyzed. Tests remain consumers;
this check does not attempt to detect code used exclusively by tests.

`dead-code-baseline.json` records the initial debt as sorted JSON-encoded tuples of
issue kind, repository-relative file and exported name (empty for unused files).
Positions are excluded. Removing old debt is allowed; any identity outside the baseline
fails with its file, exported name and issue kind. Missing old entries produce a warning.
Analyzer errors also fail the merge.

Fix a new finding by removing unused code or its unnecessary export. If a file is loaded
externally or dynamically, add the precise entrypoint to `knip.json`. Review configuration
and baseline changes carefully: adding an entrypoint suppresses unused entry exports,
and extending the baseline accepts additional debt. Do not automatically regenerate the
baseline during merges or routine fixes. A Knip version upgrade requires reviewing the
resulting findings.

This check runs entirely in the merge checkout and uses no server state or machine-specific
paths; it works identically on a remote engine.
