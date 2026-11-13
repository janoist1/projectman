import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runNpm } from '../../../scripts/merge-test/npm';
import { RUN_FACTS_PREFIX, RUN_FACTS_VARIABLE } from '../../../scripts/merge-test/reporter';
import { runSteps, type StepRun } from '../../../scripts/merge-test/steps';
import { vitestFailedFiles } from '../src/full-test/output';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(source: string, others: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'merge-watchdog-'));
  roots.push(root);
  const cli = resolve(import.meta.dirname, '../../../node_modules/vitest/vitest.mjs');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { test: `node ${JSON.stringify(cli)} run --config vitest.config.mjs` } }),
  );
  // One worker per file, so that every file runs when the first deadline passes.
  const workers = 1 + Object.keys(others).length;
  writeFileSync(
    join(root, 'vitest.config.mjs'),
    `export default { test: { pool: "forks", maxWorkers: ${workers}, minWorkers: ${workers} } };`,
  );
  writeFileSync(join(root, 'hang.test.js'), source);
  for (const [name, body] of Object.entries(others)) writeFileSync(join(root, name), body);
  return ['test', '--prefix', root];
}

/** Runs the fixture as the merge test's step, with the given file deadline; the run and the logged lines. */
async function mergeStep(args: string[], fileTimeoutMs: number) {
  const runs: StepRun[] = [];
  const lines: string[] = [];
  const code = await runSteps([{ kind: 'test', workspace: 'apps/server', args }], {
    tree: 'watchdog-fixture',
    changed: new Set(),
    log: (line) => lines.push(line),
    spawn: async (command) => {
      // Keep deliberate fixture failures and reporter events out of the enclosing merge report.
      const run = await runNpm(command, { fileTimeoutMs, forwardOutput: false });
      runs.push(run);
      return run;
    },
  });
  return { code, runs, lines };
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
      const stdout = vi.spyOn(process.stdout, 'write');
      const stderr = vi.spyOn(process.stderr, 'write');
      const { code, runs, lines } = await mergeStep(args, 2_000);
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

  it('fails only the file over its deadline and names the files stopped with it (PM-1440)', async () => {
    const vitest = resolve(import.meta.dirname, '../../../node_modules/vitest/dist/index.js');
    const hang = `import { test } from ${JSON.stringify(vitest)};\ntest("hang", () => new Promise(() => {}));`;
    const { code, runs, lines } = await mergeStep(fixture(hang, { 'other.test.js': hang }), 2_000);
    expect(code).toBe(1);
    const output = runs[0]!.output;
    // Both files start together; the first one queued reaches its deadline first.
    const over = /File deadline exceeded \(2000 ms\): (\S+)/.exec(output)?.[1];
    expect(['hang.test.js', 'other.test.js']).toContain(over);
    const stopped = over === 'hang.test.js' ? 'other.test.js' : 'hang.test.js';
    expect(vitestFailedFiles(output)).toEqual([over]);
    expect(output).toMatch(
      new RegExp(`^Stopped with it, not failed: ${stopped} \\(running \\d+ ms\\)$`, 'm'),
    );
    expect(lines).toContain(`merge-test failed: apps/server/${over}`);
    expect(lines).not.toContain(`merge-test failed: apps/server/${stopped}`);
  });

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

    it('removes inherited run facts from the child environment when disabled', async () => {
      vi.stubEnv(RUN_FACTS_VARIABLE, '1');
      const vitest = resolve(import.meta.dirname, '../../../node_modules/vitest/dist/index.js');
      const run = await runNpm(
        fixture(
          `import { test, expect } from ${JSON.stringify(vitest)};\n` +
            `test("has no run facts variable", () => { expect(process.env).not.toHaveProperty(${JSON.stringify(RUN_FACTS_VARIABLE)}); });`,
        ),
        { fileTimeoutMs: 20_000, forwardOutput: false, runFacts: false },
      );
      expect(run).toMatchObject({ code: 0, signaled: false });
      expect(factsLines(run.output)).toEqual([]);
      expect(process.env[RUN_FACTS_VARIABLE]).toBe('1');
    });
  });
});
