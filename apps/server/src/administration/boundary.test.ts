import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensitivePaths } from '../runtime/sessions';
import { ensurePrivateDir } from './secure-fs';
import { runCommand } from './service-control';
import { createDiagnosticsJournal, createOperationStore } from './store';
import { createSupervisor } from './supervisor';

/**
 * The secrets rule of the administration adapter (PM-763): whatever the process environment holds, none of it
 * reaches the child processes the supervisor starts, its answers, its journal or its state files, and the
 * member sessions' sandboxes cannot read the supervisor's state directory.
 */

const CANARY = 'canary-7f3a91c2-do-not-leak';
const HUB = { kind: 'hub' } as const;
const NOW = new Date('2026-10-17T10:00:00.000Z');

describe('secrets', () => {
  let stateDir: string;
  beforeEach(async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), 'adm-canary-'));
    await ensurePrivateDir(stateDir);
    process.env.PM763_TOKEN_CANARY = CANARY;
    process.env.PROJECTMAN_ADMIN_TOKEN = CANARY;
  });
  afterEach(async () => {
    delete process.env.PM763_TOKEN_CANARY;
    delete process.env.PROJECTMAN_ADMIN_TOKEN;
    await rm(stateDir, { recursive: true, force: true });
  });

  it('starts every child with a minimal environment, never the server’s', async () => {
    const result = await runCommand('/usr/bin/env', [], { timeoutMs: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    const names = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('=')[0]!)
      .filter((name) => name !== '_' && name !== 'PWD' && name !== 'SHLVL' && name !== 'OLDPWD');
    expect(names.sort()).toEqual(['LANG', 'LC_ALL', 'PATH']);
  });

  it('keeps the environment out of answers, the journal and the state files', async () => {
    const store = await createOperationStore(stateDir);
    const journal = await createDiagnosticsJournal(stateDir, () => NOW);
    const supervisor = createSupervisor({
      config: { target: HUB },
      controller: {
        kind: 'systemd',
        probe: async () => ({ running: true, bootId: 'boot-1' }),
        restart: async () => {
          throw new Error(`failed with ${process.env.PM763_TOKEN_CANARY}`);
        },
      },
      store,
      journal,
      now: () => NOW,
      sleep: async () => undefined,
      restartTimeoutMs: 20,
      pollMs: 1,
    });
    await supervisor.submit({
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'restart', target: HUB, expectedBootId: 'boot-1' },
    });
    await supervisor.idle();
    const seen = JSON.stringify([
      await supervisor.status(HUB),
      await supervisor.logs(HUB, { limit: 200 }),
      await supervisor.inspect('op1'),
    ]);
    expect(seen).not.toContain(CANARY);
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: 'failed',
      errorCode: 'administration_failed',
    });
    for (const dir of [stateDir, path.join(stateDir, 'operations')])
      for (const name of await readdir(dir, { withFileTypes: true }))
        if (name.isFile())
          expect(await readFile(path.join(dir, name.name), 'utf8'), name.name).not.toContain(CANARY);
  });
});

describe('sessions', () => {
  it('cannot read the supervisor’s state on a machine that has the app home', () => {
    const denied = sensitivePaths({ userHome: '/fictional/user', appHome: '/fictional/app' });
    expect(denied).toContain('/fictional/app/administration');
  });
});
