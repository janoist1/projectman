/**
 * Files that start processes or load code at runtime (child_process, worker_threads, vm, module,
 * @lydell/node-pty), each with the repository files it starts or loads. A listed file is not
 * uncertain: its entries become graph edges. [] means it starts only external programs or packages.
 * An unlisted file stays uncertain, so every test reaching it runs.
 */
export const RUNTIME_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  // runner/{cli,pipe-spawn}, runner/providers/claude/plan-usage and full-test/run-sandboxed-core
  // accept a caller's command/script; they deliberately retain the uncertain baseline.
  'apps/server/src/full-test/run-sandboxed.ts': [], // Resolves the sandbox-runtime package.
  'apps/server/src/runner/session.ts': [], // Loads node-pty; the configured agent is external.
  'apps/server/src/runner/terminal.ts': [], // Loads the xterm packages.

  // Helpers and scripts with a fixed command set. Generic command runners stay unlisted.
  'apps/server/test/helpers/golden-path.ts': [],
  'apps/server/test/helpers/migration-source.ts': [],
  'scripts/browsers.mjs': [], // Starts Playwright's package CLI.
  'scripts/engine/cli.ts': ['apps/server/src/index.ts'],
  'scripts/full-test/cli.ts': [], // Only git; command execution has a separate dependency.
  'scripts/load-probe/load-probe.mjs': [],
  'scripts/merge-test/run.ts': [], // Only git; npm execution is behind its own graph dependency.
  'scripts/release/cli.ts': [],

  // Tests that only start git. Their imported production dependencies still determine selection.
  'apps/server/src/engine-host/branch-merger.test.ts': [],
  'apps/server/src/services/merges/train-git.test.ts': [],
  'apps/server/src/worktree/dependencies.test.ts': [],
  'apps/server/src/worktree/member-workspace-manager.test.ts': [],
  'apps/server/src/worktree/worktree-manager.test.ts': [],
  'apps/server/test/config-store.test.ts': [],
  'apps/server/test/member-workspaces-base.test.ts': [],
  'apps/server/test/member-workspaces.test.ts': [],
  'apps/server/test/review-pins.test.ts': [],
  'apps/server/test/structure-api.test.ts': [],

  // Tests that start repository entrypoints rather than importing them.
  'apps/server/test/memory-log-startup.test.ts': ['apps/server/src/index.ts'],
  'apps/server/test/removed-vm-settings.test.ts': ['apps/server/src/index.ts'],
  'apps/server/test/migration-verify.test.ts': ['scripts/migrate/cli.ts'],
};
