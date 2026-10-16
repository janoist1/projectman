import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SandboxedEnd, SandboxedRun } from '../../apps/server/src/full-test';
import type { CloudContext } from '../cloud/context';
import { badUsage, refused } from '../cloud/errors';
import { noSymlinks, sourceShaSchema } from '../cloud/images';
import { releaseIdSchema } from './receipt';

/** What the caller names: nothing is implicit, so there is no default branch, tag or output location. */
export const prepareReleaseInputSchema = z.strictObject({
  releaseId: releaseIdSchema,
  commit: sourceShaSchema,
  outputDir: z.string().min(1),
  engineReleasesDir: z.string().min(1),
});
export type PrepareReleaseInput = z.input<typeof prepareReleaseInputSchema>;

export interface HeldLock {
  release(): Promise<void>;
}

/**
 * The seams of the preparation. Production code gives none of them; tests pass fakes. Nothing here can widen
 * what the preparation may touch: a missing sandbox, queue or builder is an error, never a host fallback.
 */
export interface PrepareOptions {
  /** Stops the preparation like an interrupt of the process does. */
  signal?: AbortSignal;
  /** The engine's home (`PROJECTMAN_HOME`), which no build step may read; default `PROJECTMAN_HOME` or `~/.projectman`. */
  engineHome?: string;
  /** The user's home, closed to the sandboxed steps; default `deps.homeDir`. */
  userHome?: string;
  /** The root of the sandbox run directory (`pmft-…`); default `os.tmpdir()`, or `/tmp` when that path is too long. */
  tmpDir?: string;
  /** The environment the sandbox's allow list is taken from; default `process.env`. */
  baseEnv?: NodeJS.ProcessEnv;
  /** Runs one command in the Anthropic Sandbox Runtime; default `runSandboxed` of the full-test facade. */
  sandbox?: (run: SandboxedRun) => Promise<SandboxedEnd>;
  /** Waits for the machine's heavy-run queue; default `acquireHeavyLock`. Rejects when the queue is unusable. */
  heavyLock?: (label: string, signal: AbortSignal) => Promise<HeldLock>;
  timeouts?: Partial<Record<'install' | 'build' | 'check' | 'smoke', number>>;
}

export const DEFAULT_TIMEOUTS = {
  install: 30 * 60_000,
  build: 10 * 60_000,
  check: 2 * 60_000,
  smoke: 10 * 60_000,
};

export const forbiddenPathCharacters = /[\0\r\n,]/;

export function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** The directory itself or an ancestor/descendant of it: such directories may not overlap. */
const overlap = (a: string, b: string) => isWithin(a, b) || isWithin(b, a);

function absolute(label: string, value: string): string {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.length < 2 ||
    value.endsWith(path.sep) ||
    forbiddenPathCharacters.test(value)
  )
    throw badUsage(`${label} must be a normalized absolute path`);
  return value;
}

function ownPrivateDirectory(label: string, directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw refused(`${label} must be an existing directory`);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw refused(`${label} must be owned by this user and not writable by others`);
}

export interface PreparedPaths {
  outputDir: string;
  engineReleasesDir: string;
  repoRoot: string;
  engineHome: string;
}

/**
 * The checks that need no side effect: absolute, normalized, symlink-free admin directories that overlap
 * neither the source checkout nor the engine's home nor each other. The output directory is new.
 */
export function validatePrepareInput(
  context: CloudContext,
  raw: unknown,
  options: PrepareOptions,
): { input: z.output<typeof prepareReleaseInputSchema>; paths: PreparedPaths } {
  const parsed = prepareReleaseInputSchema.safeParse(raw);
  if (!parsed.success)
    throw badUsage(`invalid release preparation input: ${parsed.error.issues[0]?.path.join('.') || 'input'}`);
  const input = parsed.data;
  const outputDir = absolute('outputDir', input.outputDir);
  const engineReleasesDir = absolute('engineReleasesDir', input.engineReleasesDir);
  let repoRoot: string;
  try {
    repoRoot = fs.realpathSync(context.deps.repoRoot);
  } catch {
    throw refused('the source checkout is missing or inaccessible');
  }
  const homeInput =
    options.engineHome ?? process.env.PROJECTMAN_HOME ?? path.join(context.deps.homeDir, '.projectman');
  const engineHome = fs.existsSync(homeInput) ? fs.realpathSync(homeInput) : path.resolve(homeInput);
  noSymlinks(outputDir);
  noSymlinks(engineReleasesDir);
  if (fs.lstatSync(outputDir, { throwIfNoEntry: false }))
    throw refused('outputDir must be a new directory that does not exist yet');
  ownPrivateDirectory('the parent of outputDir', path.dirname(outputDir));
  if (!fs.lstatSync(engineReleasesDir, { throwIfNoEntry: false })) {
    ownPrivateDirectory('the parent of engineReleasesDir', path.dirname(engineReleasesDir));
  } else ownPrivateDirectory('engineReleasesDir', engineReleasesDir);
  for (const [label, directory] of [
    ['outputDir', outputDir],
    ['engineReleasesDir', engineReleasesDir],
  ] as const) {
    if (overlap(repoRoot, directory)) throw refused(`${label} must be outside the source checkout`);
    if (overlap(engineHome, directory)) throw refused(`${label} must be outside the engine home`);
  }
  if (overlap(outputDir, engineReleasesDir))
    throw refused('outputDir and engineReleasesDir must not contain each other');
  return { input, paths: { outputDir, engineReleasesDir, repoRoot, engineHome } };
}
