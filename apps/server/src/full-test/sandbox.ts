import path from 'node:path';
import type { FullTestSpec } from '../contracts';

/** The git identity and settings of a full test run: neutral, and no automatic maintenance. */
export const FULL_TEST_GIT_CONFIG =
  '[user]\n\tname = projectman full test\n\temail = full-test@projectman.invalid\n[gc]\n\tauto = 0\n[maintenance]\n\tauto = false\n';

/** The directories of one run: only `sandbox` is writable for the command. */
export function runPaths(runDir: string) {
  const sandbox = path.join(runDir, 'sandbox');
  return {
    runDir,
    settings: path.join(runDir, 'settings.json'),
    sandbox,
    home: path.join(sandbox, 'home'),
    tmp: path.join(sandbox, 'tmp'),
    npmCache: path.join(sandbox, 'npm-cache'),
    gitConfig: path.join(sandbox, 'gitconfig'),
  };
}
export type RunPaths = ReturnType<typeof runPaths>;

/**
 * The `srt` settings of a run (Anthropic Sandbox Runtime, the Seatbelt layer Claude Code uses):
 * - reading: nothing of `spec.sandbox.denyRead`, except `allowRead` and the run's own directory;
 * - writing: only the run's `sandbox` directory (the checkout is read-only);
 * - network: nothing outward, local ports open (decision 24); PTYs allowed (macOS only).
 */
export function srtSettings(spec: FullTestSpec, paths: RunPaths) {
  return {
    network: { allowedDomains: [] as string[], deniedDomains: [] as string[], allowLocalBinding: true },
    filesystem: {
      denyRead: [...new Set(spec.sandbox.denyRead)],
      allowRead: [...new Set([...spec.sandbox.allowRead, paths.sandbox])],
      allowWrite: [paths.sandbox],
      denyWrite: [] as string[],
    },
    allowPty: true,
  };
}

/**
 * The environment of a run: an allow list, nothing else comes from the server's environment, so no
 * `PROJECTMAN_*` (the PTY skip included), token, `SSH_AUTH_SOCK` or billing variable gets in.
 */
export function fullTestEnv(
  paths: RunPaths,
  maxWorkers: number,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: paths.home,
    TMPDIR: paths.tmp,
    npm_config_cache: paths.npmCache,
    npm_config_update_notifier: 'false',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    VITEST_MAX_FORKS: String(maxWorkers),
    VITEST_MAX_THREADS: String(maxWorkers),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const name of ['LANG', 'LC_ALL'] as const) {
    const value = base[name];
    if (value) env[name] = value;
  }
  return env;
}

/** A command for `sh -c`: one word, however it is written. */
export function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** The command the sandbox runs: the repository's command at low priority. */
export function niceCommand(command: string): string {
  return `/usr/bin/nice -n 10 /bin/sh -c ${shellQuote(command)}`;
}
