import { constants } from 'node:os';
import { describe, expect, it } from 'vitest';
import { pipeSpawn } from './pipe-spawn';
import type { PtyProcess } from './session';

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
