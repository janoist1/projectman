import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { HANDOVER_CHECK_RECORD_PATH, type HandoverCheckRecord } from '@projectman/shared';
import { readGitTree, runGit } from './git-tree';
import { handoverSelection, PROXIMITIES } from './handover';
import type { HandoverSelection, Proximity } from './handover';
import { isCode } from './impact';
import type { MergeTestFile } from './impact';
import { runNpm } from './npm';
import { MERGE_TEST_WORKSPACES, runSteps, testStep, typecheckStep } from './steps';
import type { MergeTestStep, StepRun } from './steps';

const USAGE = 'usage: npm run handover-check -- [--base <revision>] [--dry-run]';
const PROXIMITY_LABELS: Record<Proximity, string> = {
  direct: 'direct (changed or importing)',
  rule: 'selection-rule',
  module: 'module-name',
  name: 'name-usage',
  graph: 'farther import-graph',
};
/** The tree the selection reads at both ends: every workspace and the scripts the server tests cover. */
const ROOTS = [...MERGE_TEST_WORKSPACES, 'scripts'];

interface HandoverIo {
  /** Runs `git <args>`; throws when git fails. */
  git?: (args: string[]) => string;
  /** The files of the base revision under the roots. */
  readBase?: (base: string, roots: readonly string[]) => MergeTestFile[];
  /** The working tree files at these repository paths (a deleted file is absent). */
  readWorktree?: (paths: readonly string[]) => MergeTestFile[];
  /** Runs the repository-wide dead-code check. */
  deadCode?: () => Promise<StepRun>;
  /** Runs `npm <args>`. */
  npm?: (args: string[]) => Promise<StepRun>;
  /** Writes the result record where the server reads it (PM-1380); throws when it cannot. */
  writeRecord?: (record: HandoverCheckRecord) => void;
  /** The time now. */
  now?: () => Date;
}

/** The commit and cleanliness of the work tree at one moment of the run (PM-1380). */
interface TreeState {
  commit: string;
  clean: boolean;
}

function treeState(git: (args: string[]) => string): TreeState {
  return {
    commit: git(['rev-parse', 'HEAD']).trim(),
    clean: git(['status', '--porcelain', '--untracked-files=normal']).trim() === '',
  };
}

/** Writes the record atomically (temp file and rename) to the git-path the server's reader resolves the same way. */
function writeRecordFile(git: (args: string[]) => string, record: HandoverCheckRecord): void {
  const path = resolve(git(['rev-parse', '--git-path', HANDOVER_CHECK_RECORD_PATH]).trim());
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`);
  renameSync(temp, path);
}

function parseArgs(argv: readonly string[]): { base?: string; dryRun: boolean } | { error: string } {
  const rest = [...argv];
  const dryRun = rest.includes('--dry-run');
  if (dryRun) rest.splice(rest.indexOf('--dry-run'), 1);
  const at = rest.indexOf('--base');
  if (at < 0) return rest.length ? { error: USAGE } : { dryRun };
  const base = rest[at + 1];
  if (!base || base.startsWith('-') || rest.length !== 2 || at !== 0) return { error: USAGE };
  return { base, dryRun };
}

const lines = (output: string): string[] => output.split('\0').filter(Boolean);

/** The working tree as the selection reads it: only code is read, as the analysis needs nothing else. */
function worktreeFiles(paths: readonly string[]): MergeTestFile[] {
  return paths
    .filter((path) => existsSync(resolve(path)))
    .map((path) => ({ path, source: isCode(path) ? readFileSync(resolve(path), 'utf8') : '' }));
}

function steps(selection: HandoverSelection): MergeTestStep[] {
  if (selection.kind === 'none') return [];
  const tests =
    selection.kind === 'cloud'
      ? [testStep('apps/server', selection.testFilters)]
      : selection.tests.map(({ workspace, files }) => testStep(workspace, files));
  return [...selection.typecheck.map((workspace) => typecheckStep(workspace)), ...tests];
}

function header(selection: HandoverSelection, count: number): string {
  const tests = selection.tests.map(({ workspace, files }) => `${workspace}: ${files.length}`).join(', ');
  return `handover-check: ${count} changed files; kind: ${selection.kind}; type check: ${selection.typecheck.join(', ') || 'none'}; tests: ${tests || 'none'}`;
}

const NAMED_MAX = 20;
/** The first tests by name, the rest as a count. */
const named = (paths: readonly string[]): string =>
  paths.length > NAMED_MAX
    ? `${paths.slice(0, NAMED_MAX).join(', ')} (+${paths.length - NAMED_MAX} more)`
    : paths.join(', ');

/** What the run left out, printed last so it is the end of the output. */
function footer(selection: HandoverSelection): string[] {
  return [
    ...(selection.moduleTests.length
      ? [
          `handover-check: ${selection.moduleTests.length} ${PROXIMITY_LABELS.module} test(s) named after a changed module run ahead of the import graph: ${named(selection.moduleTests)}`,
        ]
      : []),
    ...(selection.omitted
      ? [
          `handover-check: ran ${selection.reached - selection.omitted} of ${selection.reached} (cap ${selection.cap} cuts only the farther tests, the ${selection.nearest} nearest always run); the merge-test runs the other ${selection.omitted}`,
          `handover-check: the cap cut ${selection.omitted} test(s)`,
        ]
      : []),
    ...(selection.omitted
      ? [
          `handover-check: left out by proximity: ${PROXIMITIES.map((p) => `${selection.omittedByProximity[p].length} ${PROXIMITY_LABELS[p]}`).join(', ')}`,
        ]
      : []),
    // The nearer tests the cap cut are named: run them yourself (npx vitest run <files>).
    ...PROXIMITIES.filter((p) => p !== 'graph' && selection.omittedByProximity[p].length).map(
      (p) =>
        `handover-check: the cap left out ${selection.omittedByProximity[p].length} ${PROXIMITY_LABELS[p]} test(s), run them yourself: ${named(selection.omittedByProximity[p])}`,
    ),
    ...(selection.unmapped.length
      ? [
          `handover-check: not mapped to a test (the merge-test covers them): ${selection.unmapped.join(', ')}`,
        ]
      : []),
    'handover-check: this is not the merge-test: it runs the nearest tests only',
  ];
}

/** Exit codes: 0 green (also when the cap left tests to the merge-test), 1 a step failed, 2 usage or git error. */
export async function runHandoverCheck(argv: readonly string[], io: HandoverIo = {}): Promise<number> {
  const parsed = parseArgs(argv);
  if ('error' in parsed) {
    console.error(parsed.error);
    return 2;
  }
  const git = io.git ?? runGit;
  let selection: HandoverSelection;
  let count: number;
  try {
    let base = parsed.base;
    if (base === undefined) {
      try {
        base = git(['merge-base', 'HEAD', 'main']).trim();
      } catch {
        throw new Error('no merge base with main: pass the base revision with --base <revision>');
      }
    } else base = git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim();
    const diff = (...flags: string[]) =>
      lines(git(['diff', '--name-only', '--no-renames', '-z', ...flags, base]));
    const untracked = lines(git(['ls-files', '--others', '--exclude-standard', '-z']));
    const changed = [...new Set([...diff(), ...untracked])];
    const files = lines(
      git(['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...ROOTS]),
    );
    selection = handoverSelection({
      changed,
      added: [...diff('--diff-filter=A'), ...untracked],
      deleted: diff('--diff-filter=D'),
      before: (io.readBase ?? ((revision, roots) => readGitTree(revision, roots, git)))(base, ROOTS),
      after: (io.readWorktree ?? worktreeFiles)([...new Set(files)]),
    });
    count = changed.length;
  } catch (error) {
    console.error(`handover-check: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const list = steps(selection);
  console.log(header(selection, count));
  if (parsed.dryRun) {
    console.log('handover-check step: npm run dead-code');
    for (const step of list) console.log(`handover-check step: npm ${step.args.join(' ')}`);
    for (const line of footer(selection)) console.log(line);
    return 0;
  }
  const now = io.now ?? (() => new Date());
  const startedAt = now().toISOString();
  let before: TreeState | null = null;
  try {
    before = treeState(git);
  } catch (error) {
    console.error(
      `handover-check: no result record: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const run = async (): Promise<number> => {
    try {
      const checked = await (io.deadCode ?? (() => runNpm(['run', 'dead-code'])))();
      if (checked.signaled || checked.code !== 0) return 1;
      // The working tree is no commit, so there is no step cache and no rerun of a failed file.
      const code = await runSteps(list, {
        spawn: io.npm ?? runNpm,
        changed: null,
        tree: '',
        noCache: true,
        log: (text) => console.log(text),
      });
      return code === 0 ? 0 : 1;
    } catch (error) {
      console.error(`handover-check: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  };
  const exitCode = await run();
  // The result the server reads (PM-1380); a record that cannot be written changes neither the output nor the exit code.
  if (before) {
    try {
      const after = treeState(git);
      (io.writeRecord ?? ((record) => writeRecordFile(git, record)))({
        version: 1,
        commit: before.commit,
        clean: before.clean && after.clean && after.commit === before.commit,
        outcome: exitCode === 0 ? 'passed' : 'failed',
        exitCode,
        startedAt,
        finishedAt: now().toISOString(),
        summary: header(selection, count).slice(0, 500),
      });
    } catch (error) {
      console.error(
        `handover-check: the result record was not written: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  for (const line of footer(selection)) console.log(line);
  return exitCode;
}
