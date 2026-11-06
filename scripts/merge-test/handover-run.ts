import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

/** What the run left out, printed last so it is the end of the output. */
function footer(selection: HandoverSelection): string[] {
  return [
    ...(selection.omitted
      ? [
          `handover-check: ran ${selection.cap} of ${selection.reached} (cap ${selection.cap}); the merge-test runs the other ${selection.omitted}`,
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
        `handover-check: the cap left out ${selection.omittedByProximity[p].length} ${PROXIMITY_LABELS[p]} test(s), run them yourself: ${selection.omittedByProximity[p].join(', ')}`,
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
  } finally {
    for (const line of footer(selection)) console.log(line);
  }
}
