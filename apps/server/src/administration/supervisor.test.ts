import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdministrationExecutors, AdministrationSubmit } from '../contracts';
import { ensurePrivateDir } from './secure-fs';
import type { ServiceController, ServiceProbe } from './service-control';
import { createDiagnosticsJournal, createOperationStore } from './store';
import { createSupervisor } from './supervisor';

const HUB = { kind: 'hub' } as const;
const COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-10-17T10:00:00.000Z');

let stateDir: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(os.tmpdir(), 'adm-sup-'));
  await ensurePrivateDir(stateDir);
});
afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

/** A fake service manager: restarting changes the boot id (after `restartsAfter` probes when delayed). */
function fakeService(options: { stuck?: boolean; refuse?: boolean; running?: boolean } = {}) {
  const state = { bootId: 'boot-1', running: options.running ?? true, restarts: 0, probes: 0 };
  const controller: ServiceController = {
    kind: 'systemd',
    async probe(): Promise<ServiceProbe> {
      state.probes += 1;
      return state.running ? { running: true, bootId: state.bootId } : { running: false, bootId: null };
    },
    async restart() {
      state.restarts += 1;
      if (options.refuse) throw new Error('refused');
      if (!options.stuck) state.bootId = `boot-${state.restarts + 1}`;
    },
  };
  return { state, controller };
}

async function build(
  controller: ServiceController | null,
  extra: {
    executors?: AdministrationExecutors;
    target?: { kind: 'hub' } | { kind: 'engine'; id: string };
    sleep?: (ms: number) => Promise<void>;
  } = {},
) {
  const store = await createOperationStore(stateDir);
  const journal = await createDiagnosticsJournal(stateDir, () => NOW);
  const supervisor = createSupervisor({
    config: { target: (extra.target ?? HUB) as never },
    controller,
    store,
    journal,
    executors: extra.executors,
    version: '1.2.3',
    now: () => NOW,
    sleep: extra.sleep ?? (async () => undefined),
    restartTimeoutMs: 50,
    pollMs: 1,
  });
  return { supervisor, store, journal };
}

const restart = (operationId: string, expectedBootId = 'boot-1'): AdministrationSubmit => ({
  operationId,
  requestId: 'req1',
  command: { kind: 'restart', target: HUB, expectedBootId },
});

describe('status and logs', () => {
  it('reports the running service, its boot id and what this installation can do', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller);
    expect(await supervisor.status(HUB)).toEqual({
      target: HUB,
      online: true,
      version: '1.2.3',
      bootId: 'boot-1',
      capabilities: ['status', 'logs', 'restart'],
      activeOperationId: null,
    });
  });

  it('advertises only the executors that are installed and no restart without a service manager', async () => {
    const executors: AdministrationExecutors = {
      deploy: async (command) => ({ kind: 'deploy', releaseId: command.releaseId }),
    };
    const { supervisor } = await build(null, { executors });
    const status = await supervisor.status(HUB);
    expect(status.capabilities).toEqual(['status', 'logs', 'deploy']);
    expect(status.online).toBe(false);
    expect(status.bootId).toBeNull();
  });

  it('refuses another target, for both reads', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller);
    const other = { kind: 'engine', id: 'eng_aaaaaaaaaaaa' } as const;
    await expect(supervisor.status(other)).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    await expect(supervisor.logs(other, { limit: 5 })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
  });
});

describe('restart', () => {
  it('writes the operation before it asks the service manager and confirms by a new boot id', async () => {
    const { controller, state } = fakeService();
    const { supervisor, store } = await build(controller);
    const asked = vi.spyOn(controller, 'restart').mockImplementationOnce(async () => {
      // The record is already on disk when the service manager is asked.
      expect(await store.get('op1')).toMatchObject({ job: { state: 'running' } });
      state.restarts += 1;
      state.bootId = 'boot-2';
    });
    expect(await supervisor.submit(restart('op1'))).toEqual({ accepted: true });
    await supervisor.idle();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'restart', bootId: 'boot-2', version: '1.2.3' },
      errorCode: null,
    });
  });

  it('answers a duplicate submit with the same answer and never restarts twice', async () => {
    const { controller, state } = fakeService();
    const { supervisor } = await build(controller);
    await supervisor.submit(restart('op1'));
    await supervisor.idle();
    expect(await supervisor.submit(restart('op1'))).toEqual({ accepted: true });
    await supervisor.idle();
    expect(state.restarts).toBe(1);
  });

  it('refuses an operation id that was used for another command', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller);
    await supervisor.submit(restart('op1'));
    await supervisor.idle();
    await expect(supervisor.submit({ ...restart('op1', 'boot-2'), requestId: 'req2' })).rejects.toMatchObject(
      {
        code: 'administration_operation_conflict',
      },
    );
  });

  it('refuses a restart that names a boot id the service no longer has', async () => {
    const { controller, state } = fakeService();
    const { supervisor } = await build(controller);
    await expect(supervisor.submit(restart('op1', 'boot-0'))).rejects.toMatchObject({
      code: 'administration_boot_mismatch',
    });
    expect(state.restarts).toBe(0);
    await expect(supervisor.inspect('op1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses a restart of another target and a stopped service', async () => {
    const { controller, state } = fakeService();
    const { supervisor } = await build(controller);
    await expect(
      supervisor.submit({
        operationId: 'op1',
        requestId: 'req1',
        command: {
          kind: 'restart',
          target: { kind: 'engine', id: 'eng_aaaaaaaaaaaa' },
          expectedBootId: 'boot-1',
        },
      }),
    ).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    state.running = false;
    await expect(supervisor.submit(restart('op2'))).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    expect(state.restarts).toBe(0);
  });

  it('refuses a restart where the host has no matching service manager', async () => {
    const { supervisor } = await build(null);
    await expect(supervisor.submit(restart('op1'))).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('fails the operation when the service manager refuses or the boot id never changes', async () => {
    const refusing = fakeService({ refuse: true });
    const first = await build(refusing.controller);
    await first.supervisor.submit(restart('op1'));
    await first.supervisor.idle();
    expect(await first.supervisor.inspect('op1')).toMatchObject({
      state: 'failed',
      errorCode: 'administration_failed',
    });

    const stuck = fakeService({ stuck: true });
    const second = await build(stuck.controller);
    await second.supervisor.submit(restart('op2'));
    await second.supervisor.idle();
    expect(await second.supervisor.inspect('op2')).toMatchObject({
      state: 'failed',
      errorCode: 'administration_failed',
    });
  });

  it('accepts one operation at a time', async () => {
    const { controller } = fakeService({ stuck: true });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { supervisor } = await build(controller, { sleep: () => gate });
    await supervisor.submit(restart('op1'));
    // op1 waits for its boot id to change, so it is still unfinished.
    await expect(supervisor.submit(restart('op2'))).rejects.toMatchObject({
      code: 'administration_operation_conflict',
    });
    release();
    await supervisor.idle();
    expect(await supervisor.inspect('op1')).toMatchObject({ state: 'failed' });
  });
});

describe('recovery after a crash', () => {
  it('confirms a restart that finished while the supervisor was down and never repeats one', async () => {
    const { controller, state } = fakeService();
    const first = await build(controller);
    // A previous run wrote "running" and died after asking for the restart.
    await first.store.create({
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'restart', target: HUB, expectedBootId: 'boot-1' },
      job: {
        operationId: 'op1',
        state: 'running',
        result: null,
        errorCode: null,
        updatedAt: NOW.toISOString(),
      },
      createdAt: NOW.toISOString(),
    });
    state.bootId = 'boot-9';
    const second = await build(controller);
    await second.supervisor.recover();
    expect(await second.supervisor.inspect('op1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'restart', bootId: 'boot-9' },
    });
    expect(state.restarts).toBe(0);
  });

  it('marks a restart whose outcome nothing proves as unknown instead of repeating it', async () => {
    const { controller, state } = fakeService();
    const first = await build(controller);
    await first.store.create({
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'restart', target: HUB, expectedBootId: 'boot-1' },
      job: {
        operationId: 'op1',
        state: 'running',
        result: null,
        errorCode: null,
        updatedAt: NOW.toISOString(),
      },
      createdAt: NOW.toISOString(),
    });
    const second = await build(controller);
    await second.supervisor.recover();
    expect(await second.supervisor.inspect('op1')).toMatchObject({ state: 'unknown' });
    expect(state.restarts).toBe(0);
    // A lost answer is re-asked by the same id and gets the same, unchanged state.
    expect(await second.supervisor.submit(restart('op1'))).toEqual({ accepted: true });
    expect(await second.supervisor.inspect('op1')).toMatchObject({ state: 'unknown' });
  });

  it('starts an operation that was accepted but never started, if it is still acceptable', async () => {
    const { controller, state } = fakeService();
    const first = await build(controller);
    await first.store.create({
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'restart', target: HUB, expectedBootId: 'boot-1' },
      job: {
        operationId: 'op1',
        state: 'accepted',
        result: null,
        errorCode: null,
        updatedAt: NOW.toISOString(),
      },
      createdAt: NOW.toISOString(),
    });
    const second = await build(controller);
    await second.supervisor.recover();
    await second.supervisor.idle();
    expect(await second.supervisor.inspect('op1')).toMatchObject({ state: 'succeeded' });
    expect(state.restarts).toBe(1);
  });

  it('fails an accepted restart whose service has changed in the meantime', async () => {
    const { controller, state } = fakeService();
    const first = await build(controller);
    await first.store.create({
      operationId: 'op1',
      requestId: 'req1',
      command: { kind: 'restart', target: HUB, expectedBootId: 'boot-1' },
      job: {
        operationId: 'op1',
        state: 'accepted',
        result: null,
        errorCode: null,
        updatedAt: NOW.toISOString(),
      },
      createdAt: NOW.toISOString(),
    });
    state.bootId = 'boot-5';
    const second = await build(controller);
    await second.supervisor.recover();
    expect(await second.supervisor.inspect('op1')).toMatchObject({
      state: 'failed',
      errorCode: 'administration_boot_mismatch',
    });
    expect(state.restarts).toBe(0);
  });
});

describe('business commands', () => {
  const fullTest = (operationId: string): AdministrationSubmit => ({
    operationId,
    requestId: 'req1',
    command: { kind: 'full_test', taskKey: 'PM-1', commit: COMMIT, profile: 'merge-test' },
  });

  it('only forwards them to the installed executor and keeps its result', async () => {
    const seen: unknown[] = [];
    const executors: AdministrationExecutors = {
      full_test: async (command) => {
        seen.push(command);
        return { kind: 'full_test', outcome: 'passed', exitCode: 0, durationMs: 5, failedFiles: [] };
      },
    };
    const { controller } = fakeService();
    const { supervisor } = await build(controller, { executors });
    await supervisor.submit(fullTest('op1'));
    await supervisor.idle();
    expect(seen).toEqual([{ kind: 'full_test', taskKey: 'PM-1', commit: COMMIT, profile: 'merge-test' }]);
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'full_test', outcome: 'passed' },
    });
  });

  it('refuses a command whose executor is not installed', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller);
    await expect(supervisor.submit(fullTest('op1'))).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('reports an executor failure as a code, never as its message', async () => {
    const executors: AdministrationExecutors = {
      full_test: async () => {
        throw new Error('secret-canary-value in a stack');
      },
    };
    const { controller } = fakeService();
    const { supervisor, journal } = await build(controller, { executors });
    await supervisor.submit(fullTest('op1'));
    await supervisor.idle();
    const job = await supervisor.inspect('op1');
    expect(job).toMatchObject({ state: 'failed', errorCode: 'administration_failed' });
    expect(JSON.stringify(job)).not.toContain('canary');
    expect(JSON.stringify(await journal.read(50))).not.toContain('canary');
  });
});

describe('persisted state', () => {
  it('keeps every file private and the journal free of anything but known codes', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller);
    await supervisor.submit(restart('op1'));
    await supervisor.idle();
    const logs = await supervisor.logs(HUB, { limit: 50 });
    expect(logs.entries.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        'submit_accepted',
        'operation_started',
        'restart_requested',
        'restart_confirmed',
      ]),
    );
    expect(await readdir(path.join(stateDir, 'operations'))).toEqual(['op1.json']);
    expect(JSON.parse(await readFile(path.join(stateDir, 'operations', 'op1.json'), 'utf8'))).toMatchObject({
      operationId: 'op1',
    });
  });
});
