import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdministrationExecutors, AdministrationSubmit, AdministrationTarget } from '../contracts';
import type { MachineReader } from './machine';
import type { ProcessCleaner } from './processes';
import type { OwnerCommandRunner } from './owner-command';
import { ensurePrivateDir } from './secure-fs';
import type { ServiceLogReader } from './service-logs';
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
    machine?: MachineReader;
    serviceLogs?: ServiceLogReader;
    cleaner?: ProcessCleaner;
    ownerCommand?: OwnerCommandRunner;
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
    machine: extra.machine,
    serviceLogs: extra.serviceLogs,
    cleaner: extra.cleaner,
    ownerCommand: extra.ownerCommand,
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

describe('owner command opt-in', () => {
  const command = {
    kind: 'owner_command',
    target: HUB,
    command: 'pwd',
    timeoutSeconds: 120,
    reason: 'Inspect fixture',
  } as const;
  const input = { operationId: 'owner1', requestId: 'req1', command };
  const result = {
    kind: 'owner_command',
    exitCode: 0,
    signal: null,
    stdout: 'fixture',
    stderr: '',
    truncated: false,
    durationMs: 1,
  } as const;

  it('does not advertise or accept a shell command without an installed opt-in runner', async () => {
    const { supervisor } = await build(null);
    expect((await supervisor.status(HUB)).capabilities).not.toContain('owner_command');
    await expect(supervisor.submit(input)).rejects.toMatchObject({ code: 'administration_unavailable' });
  });

  it('advertises an enabled shell and records its result once for duplicate submits', async () => {
    const ownerCommand = vi.fn(async () => result);
    const { supervisor } = await build(null, { ownerCommand });
    expect((await supervisor.status(HUB)).capabilities).toContain('owner_command');
    await supervisor.submit(input);
    await supervisor.idle();
    await supervisor.submit(input);
    expect(ownerCommand).toHaveBeenCalledTimes(1);
    expect(await supervisor.inspect(input.operationId)).toMatchObject({ state: 'succeeded', result });
  });

  it('refuses a shell command for another machine', async () => {
    const ownerCommand = vi.fn(async () => result);
    const { supervisor } = await build(null, { ownerCommand });
    await expect(
      supervisor.submit({
        ...input,
        command: { ...command, target: { kind: 'engine', id: 'eng_aaaaaaaaaaaa' } },
      }),
    ).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    expect(ownerCommand).not.toHaveBeenCalled();
  });

  it('holds the existing operation lock while a command is running', async () => {
    let finish!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      finish = resolve;
    });
    const { supervisor } = await build(null, {
      ownerCommand: () => pending,
    });
    await supervisor.submit(input);
    await expect(supervisor.submit({ ...input, operationId: 'owner2' })).rejects.toMatchObject({
      code: 'administration_operation_conflict',
    });
    finish(result);
    await supervisor.idle();
  });
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

describe('machine state, service logs and process cleanup (PM-886)', () => {
  const SNAPSHOT = {
    at: NOW.toISOString(),
    loadAvg: [0.1, 0.2, 0.3] as [number, number, number],
    memory: { totalBytes: 2, availableBytes: 1 },
    swap: null,
    topProcesses: [],
  };
  const machine: MachineReader = { snapshot: async () => SNAPSHOT };
  const cleanup = (overrides: Partial<ProcessCleaner> = {}): ProcessCleaner & { selectors: string[] } => {
    const selectors: string[] = [];
    return {
      selectors,
      supported: () => true,
      cleanup: async (selector) => {
        selectors.push(selector);
        return { found: 3, stopped: 2, remaining: 1 };
      },
      ...overrides,
    };
  };
  const cleanupCommand = (operationId: string, target: AdministrationTarget = HUB): AdministrationSubmit => ({
    operationId,
    requestId: 'req1',
    command: { kind: 'process_cleanup', target, selector: 'orphan_test_workers' },
  });

  it('advertises the machine and the service log only when this installation has them', async () => {
    const { controller } = fakeService();
    const serviceLogs: ServiceLogReader = { available: () => false, read: async () => [] };
    const without = await build(controller, { machine, serviceLogs });
    expect((await without.supervisor.status(HUB)).capabilities).toEqual([
      'status',
      'logs',
      'machine',
      'restart',
    ]);
    const withLog = await build(controller, {
      machine,
      serviceLogs: { ...serviceLogs, available: () => true },
    });
    expect((await withLog.supervisor.status(HUB)).capabilities).toEqual([
      'status',
      'logs',
      'machine',
      'service_logs',
      'restart',
    ]);
  });

  it('answers the machine snapshot, and refuses another target or a host without a reader', async () => {
    const { controller } = fakeService();
    const { supervisor } = await build(controller, { machine });
    expect(await supervisor.machine(HUB)).toEqual(SNAPSHOT);
    await expect(supervisor.machine({ kind: 'engine', id: 'eng_aaaaaaaaaaaa' })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    const bare = await build(controller);
    await expect(bare.supervisor.machine(HUB)).rejects.toMatchObject({ code: 'administration_unavailable' });
  });

  it('filters its own journal and hands the service log request to the reader', async () => {
    const { controller } = fakeService();
    const seen: unknown[] = [];
    const serviceLogs: ServiceLogReader = {
      available: () => true,
      read: async (query) => {
        seen.push(query);
        return [{ at: NOW.toISOString(), level: 'info', code: 'service_log', message: 'from the service' }];
      },
    };
    const { supervisor, journal } = await build(controller, { serviceLogs });
    await journal.append('supervisor_started');
    await journal.append('submit_refused', { errorCode: 'administration_operation_conflict' });
    const warned = await supervisor.logs(HUB, { limit: 10, minLevel: 'warn' });
    expect(warned.entries.map((entry) => entry.code)).toEqual(['submit_refused']);
    const service = await supervisor.logs(HUB, { limit: 10, source: 'service', contains: 'service' });
    expect(service.entries.map((entry) => entry.message)).toEqual(['from the service']);
    expect(seen).toEqual([{ limit: 10, source: 'service', contains: 'service' }]);

    const bare = await build(controller);
    await expect(bare.supervisor.logs(HUB, { limit: 10, source: 'service' })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('runs the cleanup, records only its counts and refuses it where it cannot work', async () => {
    const { controller } = fakeService();
    const cleaner = cleanup();
    const { supervisor } = await build(controller, { cleaner });
    expect(await supervisor.submit(cleanupCommand('op1'))).toEqual({ accepted: true });
    await supervisor.idle();
    expect(cleaner.selectors).toEqual(['orphan_test_workers']);
    expect(await supervisor.inspect('op1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'process_cleanup', found: 3, stopped: 2, remaining: 1 },
    });
    const journal = (await supervisor.logs(HUB, { limit: 50 })).entries.map((entry) => entry.message);
    expect(journal).toContain('cleanup_finished operationId=op1 found=3 stopped=2 remaining=1');

    await expect(
      supervisor.submit(cleanupCommand('op2', { kind: 'engine', id: 'eng_aaaaaaaaaaaa' })),
    ).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    const unsupported = await build(controller, { cleaner: cleanup({ supported: () => false }) });
    await expect(unsupported.supervisor.submit(cleanupCommand('op3'))).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('records a failed cleanup as a failure without its error text', async () => {
    const { controller } = fakeService();
    const cleaner = cleanup({
      cleanup: async () => {
        throw new Error('ps said secret-argv');
      },
    });
    const { supervisor } = await build(controller, { cleaner });
    await supervisor.submit(cleanupCommand('op1'));
    await supervisor.idle();
    const job = await supervisor.inspect('op1');
    expect(job).toMatchObject({ state: 'failed', errorCode: 'administration_failed' });
    expect(JSON.stringify(job)).not.toContain('secret-argv');
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
