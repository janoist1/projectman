import { isRepoFilePath } from '../config/project-docs';

/**
 * The marker lines `npm run merge-test` prints (PM-842), one per test file: `failed` for a file that
 * still failed after its one rerun (or was not rerun), `flaky` for one that failed and then passed.
 * The script writes them, the full test executor and the server read them: the rule lives here.
 */
export const MERGE_TEST_FAILED_PREFIX = 'merge-test failed: ';
export const MERGE_TEST_FLAKY_PREFIX = 'merge-test flaky: ';
/** The most marked files read from one output. */
export const MERGE_TEST_MARKED_FILES_MAX = 20;

export type MergeTestMark = 'failed' | 'flaky';

const PREFIX: Record<MergeTestMark, string> = {
  failed: MERGE_TEST_FAILED_PREFIX,
  flaky: MERGE_TEST_FLAKY_PREFIX,
};

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** One marker line, without newline. Throws TypeError when `path` is not `isRepoFilePath`. */
export function mergeTestMarkerLine(kind: MergeTestMark, path: string): string {
  if (!isRepoFilePath(path)) throw new TypeError(`not a repository file path: ${path}`);
  return `${PREFIX[kind]}${path}`;
}

/** One word of a shell command, in single quotes: nothing in it is expanded. */
export function quoteShellWord(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command that runs only `files` (PM-844): the configured `filesCommand` prefix and the
 * repository-relative paths, each shell-quoted.
 */
export function mergeTestFilesCommand(filesCommand: string, files: readonly string[]): string {
  return [filesCommand, ...files.map(quoteShellWord)].join(' ');
}

/**
 * The paths of the line-anchored marker lines of `kind` (ANSI removed, CRLF accepted), unique, in
 * order, at most `MERGE_TEST_MARKED_FILES_MAX`; lines with an invalid path are skipped.
 */
export function mergeTestMarkedFiles(output: string, kind: MergeTestMark): string[] {
  const prefix = PREFIX[kind];
  const files: string[] = [];
  for (const line of output.replace(ANSI, '').split(/\r?\n/)) {
    if (!line.startsWith(prefix)) continue;
    const file = line.slice(prefix.length);
    if (!isRepoFilePath(file) || files.includes(file)) continue;
    files.push(file);
    if (files.length >= MERGE_TEST_MARKED_FILES_MAX) break;
  }
  return files;
}
