import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNpm } from '../../../scripts/merge-test/npm';
import { RUN_FACTS_PREFIX } from '../../../scripts/merge-test/reporter';
import { runSteps, type StepRun } from '../../../scripts/merge-test/steps';
import { vitestFailedFiles } from '../src/full-test/output';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string) {
  const root = mkdtempSync(join(tmpdir(), 'merge-watchdog-'));
  roots.push(root);
  const cli = resolve(import.meta.dirname, '../../../node_modules/vitest/vitest.mjs');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: `node ${JSON.stringify(cli)} run --config vitest.config.mjs` } }),
  );
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    'export default { test: { pool: "forks", maxWorkers: 1, minWorkers: 1 } };',
  );
  writeFileSync(join(root, 'hang.test.js'), source);
  return ['test', '--prefix', root];
}

describe('merge-test file watchdog at the process boundary', () => {
  it.each([
    ['collection', 'await new Promise(() => {});'],
    ['synchronous execution', 'test("hang", () => { while (true) {} });'],
    ['teardown', 'afterAll(() => new Promise(() => {})); test("ok", () => {});'],
  ])(
    'fails a file stuck during %s without rerunning or waiting for the job deadline',
    async (_phase, body) => {
      // Import Vitest by absolute path: the disposable package has no node_modules of its own.
      const vitest = resolve(import.meta.dirname, '../../../node_modules/vitest/dist/index.js');
      const args = fixture(`import { test, afterAll } from ${JSON.stringify(vitest)};\n${body}`);
      const runs: StepRun[] = [];
      const lines: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write');
      const stderr = vi.spyOn(process.stderr, 'write');
      const code = await runSteps([{ kind: 'test', workspace: 'apps/server', args }], {
        tree: 'watchdog-fixture',
        changed: new Set(),
        log: (line) => lines.push(line),
        spawn: async (command) => {
          // Keep deliberate fixture failures and reporter events out of the enclosing merge report.
          const run = await runNpm(command, { fileTimeoutMs: 2_000, forwardOutput: false });
          runs.push(run);
          return run;
        },
      });
      expect(code).toBe(1);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.signaled).toBe(false);
      expect(runs[0]?.output).toContain('File deadline exceeded');
      expect(vitestFailedFiles(runs[0]!.output)).toEqual(['hang.test.js']);
      expect(lines).toContain('merge-test failed: apps/server/hang.test.js');
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalled();
    },
  );

  it('clears a completed file deadline and preserves a successful exit', async () => {
    const vitest = resolve(import.meta.dirname, '../../../node_modules/vitest/dist/index.js');
    const run = await runNpm(
      fixture(`import { test } from ${JSON.stringify(vitest)}; test("ok", () => {});`),
      { fileTimeoutMs: 2_000, forwardOutput: false },
    );
    expect(run).toMatchObject({ code: 0, signaled: false });
    const events = run.output.split('\n').filter((line) => line.startsWith('merge-test file: '));
    expect(events.map((line) => JSON.parse(line.slice('merge-test file: '.length)).phase)).toEqual([
      'start',
      'end',
    ]);
  });

  describe('run facts (PM-1406)', () => {
    const refused = () => {
      const vitest = resolve(import.meta.dirname, '../../../node_modules/vitest/dist/index.js');
      return fixture(
        `import { test, beforeEach } from ${JSON.stringify(vitest)};\n` +
          `beforeEach(() => { throw Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), ` +
          `{ code: 'EPERM', syscall: 'listen', address: '127.0.0.1' }); });\n` +
          `test("binds", () => {});`,
      );
    };
    const factsLines = (output: string) =>
      output.split('\n').filter((line) => line.startsWith(RUN_FACTS_PREFIX));

    it('hands the structured error facts of a failed file to the caller that asks for them', async () => {
      const run = await runNpm(refused(), { fileTimeoutMs: 20_000, forwardOutput: false, runFacts: true });
      expect(run.code).not.toBe(0);
      const lines = factsLines(run.output);
      expect(lines).toHaveLength(1);
      const facts = JSON.parse(lines[0]!.slice(RUN_FACTS_PREFIX.length));
      expect(facts.reason).toBe('failed');
      expect(facts.failed).toHaveLength(1);
      expect(facts.failed[0].file).toMatch(/hang\.test\.js$/);
      expect(facts.failed[0].failures[0].errors[0]).toMatchObject({
        code: 'EPERM',
        syscall: 'listen',
        address: '127.0.0.1',
      });
    });

    it('prints no facts line by default, so the output stays as it was', async () => {
      const run = await runNpm(refused(), { fileTimeoutMs: 20_000, forwardOutput: false });
      expect(run.code).not.toBe(0);
      expect(factsLines(run.output)).toEqual([]);
    });
  });
});
