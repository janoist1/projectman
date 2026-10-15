import { constants } from 'node:os';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { pipeSpawn } from './pipe-spawn';
import type { PtyProcess } from './session';
import { fixtureScopeProcesses, silentLogger, tempDirs, waitFor, FAKE_CLAUDE } from './test-helpers';
import { createProcessScopeDriver } from './process-scope';

const NODE = process.execPath;
const options = {
  name: 'xterm-256color',
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
};

function run(script: string) {
  const proc: PtyProcess = pipeSpawn(NODE, ['-e', script], options);
  let output = '';
  const exits: Array<{ exitCode: number; signal?: number }> = [];
  proc.onData((data) => (output += data));
  proc.onExit((event) => exits.push(event));
  const exited = () =>
    new Promise<{ exitCode: number; signal?: number }>((resolve) => {
      proc.onExit(resolve);
    });
  return { proc, output: () => output, exits, exited };
}

describe('pipeSpawn', () => {
  it('closes the fake lifecycle fixture and its marked detached TERM-resistant child without ps', async () => {
    const dirs = tempDirs();
    const directory = await dirs.make('scope-smoke-');
    const childFile = path.join(directory, 'child-info');
    const driver = createProcessScopeDriver({
      config: { kind: 'process_group' },
      uid: process.getuid?.() ?? null,
      logger: silentLogger(),
      processes: fixtureScopeProcesses(directory),
    });
    const scope = await driver.open('ses_pipe_smoke');
    const fixture = pathToFileURL(path.join(path.dirname(FAKE_CLAUDE), 'fake-tui.mjs')).href;
    const command = scope.launch({
      file: NODE,
      args: [
        '-e',
        `import(${JSON.stringify(fixture)}).then(({ exitOnSignals }) => {
        exitOnSignals({ sessionEnd: async () => {}, restore: '' });
        process.stdout.write('ready'); setInterval(() => {}, 1000);
      });`,
      ],
      env: {
        ...options.env,
        PROJECTMAN_SESSION_ID: 'ses_pipe_smoke',
        FAKE_SCOPE_RECORDS_DIR: directory,
        FAKE_SCOPE_CHILD_FILE: childFile,
      },
    });
    const proc = pipeSpawn(command.file, command.args, { ...options, env: command.env });
    scope.attached(proc.pid);
    let child: { pid: number; scopeId: string } | undefined;
    try {
      await vi.waitFor(
        async () => {
          child = await readFile(childFile, 'utf8').then(
            (text) => JSON.parse(text),
            () => undefined,
          );
          expect(child?.scopeId).toBe(scope.scopeId);
        },
        { timeout: 5000 },
      );
      expect(await scope.close('stop', { force: false })).toMatchObject({ outcome: 'clean', killed: true });
      expect(() => process.kill(child!.pid, 0)).toThrow();
    } finally {
      proc.kill('SIGKILL');
      if (child) {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      await dirs.cleanup();
    }
  }, 15_000);
  it('reports the CLI exit even when a detached child still holds its output pipes open', async () => {
    const { proc, output, exited } = run(
      "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); process.stdout.write(String(child.pid)); child.unref(); process.exit(0);",
    );
    const finished = exited();
    let pid: number | undefined;
    try {
      pid = await waitFor(() => (/^\d+$/.test(output()) ? Number(output()) : undefined));
      expect(
        await Promise.race([finished, new Promise((resolve) => setTimeout(() => resolve('blocked'), 500))]),
      ).toMatchObject({ exitCode: 0 });
      expect(proc.pid).not.toBe(pid);
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  });
  it('starts the pipe process as its own group leader', async () => {
    const { proc, output, exited } = run("process.stdout.write('ready'); setInterval(() => {}, 1000);");
    const finished = exited();
    try {
      await waitFor(() => output().includes('ready'));
      expect(() => process.kill(-proc.pid, 0)).not.toThrow();
    } finally {
      proc.kill('SIGKILL');
      await finished;
    }
  });
  it('returns what is written to the standard input, and the standard error too', async () => {
    const { proc, output, exited } = run(
      "process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => { process.stdout.write('out:' + d); process.stderr.write('err:' + d); process.exit(0); });",
    );
    expect(proc.pid).toBeGreaterThan(0);
    proc.write('hello');
    await exited();
    expect(output()).toContain('out:hello');
    expect(output()).toContain('err:hello');
  });

  it('keeps a character that arrives in two chunks whole', async () => {
    // "é" is 0xC3 0xA9: write the two bytes apart.
    const { output, exited } = run(
      'process.stdout.write(Buffer.from([0xc3])); setTimeout(() => { process.stdout.write(Buffer.from([0xa9])); }, 50);',
    );
    await exited();
    expect(output()).toBe('é');
  });

  it('reports the exit code', async () => {
    const { exited } = run('process.exit(3)');
    expect(await exited()).toMatchObject({ exitCode: 3 });
  });

  it('reports the signal of a kill, once', async () => {
    const { proc, exits, exited } = run('setInterval(() => {}, 1000);');
    proc.kill();
    const event = await exited();
    expect(event.signal).toBe(constants.signals.SIGTERM);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(exits).toHaveLength(1);
    expect(() => proc.kill()).not.toThrow();
  });

  it('reports a file that does not exist as exit code 127, once, without an unhandled error', async () => {
    const proc = pipeSpawn('/no/such/file-pm-267', [], options);
    const exits: Array<{ exitCode: number; signal?: number }> = [];
    proc.onExit((event) => exits.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exits).toEqual([{ exitCode: 127 }]);
    expect(proc.pid).toBe(-1);
    expect(() => proc.write('x')).not.toThrow();
    expect(() => proc.kill()).not.toThrow();
  });

  it('does not throw when written to after the exit', async () => {
    const { proc, exited } = run('process.exit(0)');
    await exited();
    expect(() => proc.write('late')).not.toThrow();
    expect(() => proc.resize(100, 40)).not.toThrow();
  });

  it('does not throw when the process closes its input before the write', async () => {
    const { proc, exited } = run('process.stdin.destroy(); setTimeout(() => process.exit(0), 100);');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => proc.write('x'.repeat(100_000))).not.toThrow();
    await exited();
  });
});
