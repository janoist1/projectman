import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sensitivePaths } from '../runtime/sessions';
import { createHostSystem } from './host';
import { createProcessCleaner, listProcesses } from './processes';
import { createOwnerCommandRunner } from './owner-command';
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

const host = createHostSystem();
// The sandbox of a member session refuses `ps`; the test then has nothing to read and is skipped.
const psWorks = await listProcesses(host, { withCommand: true })
  .then((rows) => rows.length > 0)
  .catch(() => false);

describe('process cleanup', () => {
  const MARKER = `pm886-orphan-${process.pid}-${Date.now()}`;

  it.skipIf(!psWorks)(
    'stops a real orphan that carries the marker and leaves its neighbours alone',
    async (ctx) => {
      // A shell in a group of its own starts a marked child in the background and exits, so the child's parent is 1.
      const shell = spawn(
        '/bin/sh',
        ['-c', `"$0" -e "setTimeout(function(){},600000)" ${MARKER} & :`, process.execPath],
        {
          detached: true,
          stdio: 'ignore',
        },
      );
      shell.unref();
      const orphans = async () =>
        (await listProcesses(host, { withCommand: true })).filter((row) => row.command.includes(MARKER));
      let found: Awaited<ReturnType<typeof orphans>> = [];
      for (let attempt = 0; attempt < 40 && (found.length === 0 || found[0]!.ppid !== 1); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        found = await orphans();
      }
      try {
        // A host with a subreaper never makes the child's parent 1: nothing to assert there.
        if (found.length !== 1 || found[0]!.ppid !== 1) return ctx.skip();
        const cleaner = createProcessCleaner({
          host,
          markers: [MARKER],
          minAgeSeconds: 0,
          graceMs: 5_000,
          pollMs: 100,
        });
        expect(await cleaner.cleanup('orphan_test_workers')).toEqual({ found: 1, stopped: 1, remaining: 0 });
        expect(await orphans()).toEqual([]);
        // The test process itself, which carries no marker, is still here.
        expect(() => process.kill(process.pid, 0)).not.toThrow();
      } finally {
        for (const row of await orphans()) host.kill(row.pid, 'SIGKILL');
      }
    },
  );
});

describe('sessions', () => {
  it('cannot read the supervisor’s state on a machine that has the app home', () => {
    const denied = sensitivePaths({ userHome: '/fictional/user', appHome: '/fictional/app' });
    expect(denied).toContain('/fictional/app/administration');
  });
});

describe('owner command shell', () => {
  it('runs a harmless command as the supervisor user in a temporary directory and redacts the result', async (ctx) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), 'adm-owner-'));
    ctx.onTestFinished(() => rm(cwd, { recursive: true, force: true }));
    await writeFile(path.join(cwd, 'fixture.txt'), 'fixture-cwd\n');
    const result = await createOwnerCommandRunner('/bin/sh')(
      {
        kind: 'owner_command',
        target: HUB,
        command: 'cat fixture.txt; printf "token=fixture-secret\\n"; printf "fixture-error\\n" >&2; exit 3',
        cwd,
        timeoutSeconds: 5,
        reason: 'Boundary fixture',
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ exitCode: 3, signal: null, stderr: 'fixture-error\n', truncated: false });
    expect(result.stdout).toContain('fixture-cwd');
    expect(result.stdout).toContain('[redacted]');
    expect(result.stdout).not.toContain('fixture-secret');
  });
});
