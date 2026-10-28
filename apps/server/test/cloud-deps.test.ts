import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { realDeps } from '../../../scripts/cloud/deps';

const fixture = fileURLToPath(new URL('./fixtures/fake-cloud-process.mjs', import.meta.url));
let directory: string;
let pids: number[];
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-process-'));
  pids = [];
});
afterEach(() => {
  // Test failure cleanup is confined to the fixture's own children.
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Already stopped. */
    }
  }
  fs.rmSync(directory, { force: true, recursive: true });
});
async function ready(roles: string[] = ['ssh', 'aws', 'plugin']) {
  await vi.waitFor(() => {
    for (const role of roles) expect(fs.existsSync(path.join(directory, `${role}.pid`))).toBe(true);
  });
  pids = roles.map((role) => Number(fs.readFileSync(path.join(directory, `${role}.pid`), 'utf8')));
}
async function stopped() {
  await vi.waitFor(() => {
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
  });
}

it.each(['pipe', 'inherit'] as const)(
  'aborts SSH and its AWS/plugin process group with %s output',
  async (stdio) => {
    const controller = new AbortController();
    const work = realDeps().run(process.execPath, [fixture, 'ssh', directory], {
      signal: controller.signal,
      stdio,
    });
    await ready();
    controller.abort();
    expect((await work).code).toBe(130);
    await stopped();
  },
);

it('times out SSH and kills the proxy plugin even when it ignores SIGTERM', async () => {
  const work = realDeps().run(process.execPath, [fixture, 'ssh', directory], { timeoutMs: 1000 });
  await ready();
  expect((await work).code).toBe(124);
  await stopped();
});

it.each(['pipe', 'inherit'] as const)(
  'cleans descendants after a successful SSH exit with %s output',
  async (stdio) => {
    const work = realDeps().run(process.execPath, [fixture, 'ssh-success', directory], {
      timeoutMs: 2000,
      stdio,
    });
    await ready();
    expect((await work).code).toBe(0);
    await stopped();
  },
);

it('aborts both sides of a tar stream and the SSH proxy descendants before resolving', async () => {
  const controller = new AbortController();
  const work = realDeps().pipe(
    { command: process.execPath, args: [fixture, 'tar', directory] },
    { command: process.execPath, args: [fixture, 'ssh', directory], signal: controller.signal },
  );
  await ready(['tar', 'ssh', 'aws', 'plugin']);
  controller.abort();
  expect((await work).code).toBe(130);
  await stopped();
});

it('never spawns a command when its signal is already aborted', async () => {
  const signal = AbortSignal.abort();
  expect((await realDeps().run(process.execPath, [fixture, 'ssh', directory], { signal })).code).toBe(130);
  expect(
    (await realDeps().pipe({ command: 'missing', args: [], signal }, { command: 'missing', args: [] })).code,
  ).toBe(130);
  expect(fs.readdirSync(directory)).toEqual([]);
});
