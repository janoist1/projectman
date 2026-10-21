import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyBaseLogger } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FullTestSpec } from '../contracts';
import { createFullTestExecutor } from './index';
import { runSandboxed } from './run-sandboxed';
import type { SandboxedEnd, SandboxedRun } from './run-sandboxed';

vi.mock('./run-sandboxed', () => ({ runSandboxed: vi.fn(), srtCli: vi.fn() }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), writeFile: vi.fn(actual.writeFile) };
});
vi.mock('./sandbox', async (original) => {
  const actual = await original<typeof import('./sandbox')>();
  return { ...actual, runDirOf: (root: string, _short: string, runId: string) => path.join(root, runId) };
});

const NOW = Date.parse('2026-10-20T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const key = (n: number) => n.toString(16).padStart(64, '0');
const marker = (n: number) => `merge-test step passed: ${key(n)}\n`;
const entry = (n: number, age = 0) => ({
  key: key(n),
  at: new Date(NOW - age).toISOString(),
  runId: 'earlier',
});
const ended = (overrides: Partial<SandboxedEnd> = {}): SandboxedEnd => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  output: '',
  ...overrides,
});
const warn = vi.fn();
const logger = { warn } as unknown as FastifyBaseLogger;
let root: string;
let file: string;
let spec: FullTestSpec;
let commandEnd: SandboxedEnd;
let commands: SandboxedRun[];
let observe: ((run: SandboxedRun) => void) | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'pm-cache-')));
  file = path.join(root, 'cache', 'merge-test-steps.json');
  spec = {
    runId: 'ftr_cache',
    cwd: root,
    command: 'npm run merge-test',
    maxWorkers: 4,
    timeoutMs: 1000,
    sandbox: { denyRead: [path.dirname(file)], allowRead: [] },
  };
  commandEnd = ended();
  commands = [];
  observe = undefined;
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  warn.mockClear();
  vi.mocked(rename).mockClear();
  vi.mocked(writeFile).mockClear();
  vi.mocked(runSandboxed)
    .mockReset()
    .mockImplementation(async (run) => {
      if (run.command !== spec.command) return ended();
      commands.push(run);
      observe?.(run);
      return commandEnd;
    });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

const seed = (entries: ReturnType<typeof entry>[]) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, entries }));
};
const read = (): { version: number; entries: ReturnType<typeof entry>[] } =>
  JSON.parse(readFileSync(file, 'utf8'));
const run = (stepCacheFile: string | undefined = file) =>
  createFullTestExecutor({ logger, tmpDir: root, stepCacheFile }).run(spec, new AbortController().signal);

describe('the executor merge-test step cache', () => {
  it('exposes only unexpired keys in the disposable sandbox file and sets its environment', async () => {
    seed([entry(1, DAY), entry(2, 14 * DAY + 1), entry(3, 14 * DAY)]);
    observe = (command) => {
      const list = command.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS!;
      expect(list).toBe(path.join(root, spec.runId, 'sandbox', 'merge-test-passed-keys'));
      expect(readFileSync(list, 'utf8').split('\n')).toEqual([key(1), key(3)]);
      const settings = JSON.parse(readFileSync(command.settings, 'utf8'));
      expect(settings.filesystem.allowWrite).toEqual([path.dirname(list)]);
      expect(settings.filesystem.denyRead).toContain(path.dirname(file));
    };
    expect((await run()).outcome).toBe('passed');
    expect(read().entries.map((entry) => entry.key)).toEqual([key(1), key(3)]);
    expect(existsSync(path.join(root, spec.runId))).toBe(false);
  });

  it('starts with an empty cache when missing, then reuses the persisted keys on the next run', async () => {
    const lists: string[] = [];
    observe = (command) => lists.push(readFileSync(command.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS!, 'utf8'));
    commandEnd = ended({ output: marker(1) + marker(1) + marker(2) });
    await run();
    commandEnd = ended();
    await run();
    expect(lists).toEqual(['', `${key(1)}\n${key(2)}`]);
    expect(read()).toEqual({ version: 1, entries: [1, 2].map((n) => ({ ...entry(n), runId: spec.runId })) });
  });

  it.each([
    ['passed', {}],
    ['failed', { exitCode: 1 }],
    ['error', { timedOut: true, exitCode: null }],
    ['error', { aborted: true, exitCode: null }],
    ['error', { signal: 'SIGTERM' as const, exitCode: null }],
    ['error', { spawnError: new Error('spawn failed'), exitCode: null }],
  ])('persists completed steps when the command ends as %s (%j)', async (outcome, overrides) => {
    commandEnd = ended({ ...overrides, output: marker(1) });
    expect((await run()).outcome).toBe(outcome);
    expect(read().entries).toEqual([{ ...entry(1), runId: spec.runId }]);
  });

  it('merges, deduplicates, refreshes and expires entries while retaining the newest five hundred', async () => {
    seed([...Array.from({ length: 501 }, (_, n) => entry(n, (n + 1) * 1000)), entry(800, 15 * DAY)]);
    // A later write while the sandbox runs must also survive the final merge.
    observe = () => seed([...read().entries, entry(900, 1)]);
    commandEnd = ended({ output: marker(500) + marker(700) + marker(700) });
    await run();
    const entries = read().entries;
    expect(entries).toHaveLength(500);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(500);
    expect(entries.slice(0, 2)).toEqual([500, 700].map((n) => ({ ...entry(n), runId: spec.runId })));
    expect(entries.some((entry) => entry.key === key(900))).toBe(true);
    expect(entries.some((entry) => entry.key === key(800) || entry.key === key(499))).toBe(false);
  });

  it.each([
    '{broken',
    '{"version":2,"entries":[]}',
    '{"version":1,"entries":[{"key":"bad","at":"today","runId":"old"}]}',
    JSON.stringify({ version: 1, entries: [{ ...entry(1), at: 'invalid' }] }),
  ])('ignores invalid cache data: %s', async (content) => {
    seed([]);
    writeFileSync(file, content);
    commandEnd = ended({ output: marker(1) });
    expect((await run()).outcome).toBe('passed');
    expect(commands[0]!.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS).toBeUndefined();
    expect(readFileSync(file, 'utf8')).toBe(content);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: spec.runId }),
      expect.stringContaining('running without it'),
    );
  });

  it('ignores filesystem read errors and runs without the cache', async () => {
    mkdirSync(file, { recursive: true });
    expect((await run()).outcome).toBe('passed');
    expect(commands[0]!.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS).toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('publishes by atomic rename, with the previous cache intact until the replacement', async () => {
    seed([entry(1, DAY)]);
    const previous = readFileSync(file, 'utf8');
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(rename).mockImplementationOnce(async (temporary, target) => {
      expect(target).toBe(file);
      expect(path.dirname(String(temporary))).toBe(path.dirname(file));
      expect(readFileSync(file, 'utf8')).toBe(previous);
      expect(JSON.parse(readFileSync(temporary, 'utf8')).entries).toHaveLength(2);
      await actual.rename(temporary, target);
    });
    commandEnd = ended({ output: marker(2) });
    await run();
    expect(rename).toHaveBeenCalledOnce();
    expect(read().entries.map((entry) => entry.key)).toEqual([key(2), key(1)]);
    expect(readdirSync(path.dirname(file))).toEqual(['merge-test-steps.json']);
  });

  it('preserves the previous cache and verdict on a publication error and removes the temporary file', async () => {
    seed([entry(1, DAY)]);
    const previous = readFileSync(file, 'utf8');
    vi.mocked(rename).mockRejectedValueOnce(new Error('rename denied'));
    commandEnd = ended({ output: marker(2), exitCode: 7 });
    expect(await run()).toMatchObject({ outcome: 'failed', exitCode: 7 });
    expect(readFileSync(file, 'utf8')).toBe(previous);
    expect(readdirSync(path.dirname(file))).toEqual(['merge-test-steps.json']);
    expect(warn).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('could not write'));
  });

  it('disables reuse if the disposable key file cannot be written', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(writeFile).mockImplementation(async (target, data, options) => {
      if (String(target).endsWith('merge-test-passed-keys')) throw new Error('key file denied');
      return actual.writeFile(target, data, options);
    });
    try {
      expect((await run()).outcome).toBe('passed');
      expect(commands[0]!.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS).toBeUndefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      vi.mocked(writeFile).mockImplementation(actual.writeFile);
    }
  });

  it('does not inherit a caller key file or write a cache when no cache file is configured', async () => {
    const executor = createFullTestExecutor({
      logger,
      tmpDir: root,
      env: { PROJECTMAN_MERGE_TEST_PASSED_KEYS: '/caller/keys' },
    });
    commandEnd = ended({ output: marker(1) });
    expect((await executor.run(spec, new AbortController().signal)).outcome).toBe('passed');
    expect(commands[0]!.env.PROJECTMAN_MERGE_TEST_PASSED_KEYS).toBeUndefined();
    expect(existsSync(file)).toBe(false);
    expect(rename).not.toHaveBeenCalled();
  });
});

describe('the executor report of the measurements (PM-876)', () => {
  const measured = [
    'merge-test scope: modules (2 files); modules: a',
    'merge-test workers: 4',
    'merge-test timing: {"index":0,"kind":"typecheck","workspace":"apps/server","result":"passed","durationMs":41200}',
    'merge-test timing: {"index":1,"kind":"test","workspace":"apps/server","result":"cached","durationMs":null}',
    '',
  ].join('\n');
  const report = {
    scope: 'modules',
    workers: 4,
    commandMs: expect.any(Number),
    steps: [
      { index: 0, kind: 'typecheck', workspace: 'apps/server', result: 'passed', durationMs: 41_200 },
      { index: 1, kind: 'test', workspace: 'apps/server', result: 'cached', durationMs: null },
    ],
  };

  it.each([
    ['passed', ended({ output: measured }), 'passed'],
    ['failed', ended({ output: `${measured} FAIL  test/a.test.ts > x\n`, exitCode: 1 }), 'failed'],
    ['timeout', ended({ output: measured, timedOut: true }), 'error'],
    ['killed', ended({ output: measured, signal: 'SIGKILL' }), 'error'],
  ])('carries what the command measured on a %s run', async (_name, end, outcome) => {
    commandEnd = end;
    expect(await run()).toMatchObject({ outcome, report });
  });

  it('keeps the failure report as it was (the failed files)', async () => {
    commandEnd = ended({ output: `${measured} FAIL  test/a.test.ts > x\n`, exitCode: 1 });
    expect(await run()).toMatchObject({ failedFiles: ['test/a.test.ts'] });
  });

  it('has no report for a command that printed no measurement (another command or an older script)', async () => {
    commandEnd = ended({ output: 'vitest run\n' });
    expect(await run()).toMatchObject({ outcome: 'passed', report: null });
  });
});
