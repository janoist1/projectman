import { describe, expect, it, vi } from 'vitest';
import type { EngineId } from '@projectman/shared';
import { notFound } from '../kernel';
import type {
  AdministrationJob,
  AdministrationMachineSnapshot,
  AdministrationPort,
  AdministrationStatus,
} from '../contracts';
import { createEngineHandlers } from './engine-handlers';
import { methods } from './methods';
import type { EngineMethod } from './methods';
import { Hello } from './protocol';
import { createRemoteHub } from './remote/hub';
import { createRemoteAdministration } from './remote/administration';
import { createFakeCloud, helloOf, silentLogger } from './remote/test-support';
import type { EngineRpc } from './rpc';

const ENGINE = 'eng_aaaaaaaaaaaa' as EngineId;
const OTHER = 'eng_bbbbbbbbbbbb' as EngineId;
const OWN = { kind: 'engine', id: ENGINE } as const;
const AT = '2026-10-17T10:00:00.000Z';

const SNAPSHOT: AdministrationMachineSnapshot = {
  at: AT,
  loadAvg: [0.5, 0.4, 0.3],
  memory: { totalBytes: 16_000_000_000, availableBytes: 8_000_000_000 },
  swap: null,
  topProcesses: [{ pid: 42, name: 'node', cpuPercent: 1.5, rssBytes: 1_000_000 }],
};

const status = (target: AdministrationStatus['target']): AdministrationStatus => ({
  target,
  online: true,
  version: null,
  bootId: 'boot-1',
  capabilities: ['status', 'logs', 'restart'],
  activeOperationId: null,
});

function fakePort() {
  const submitted: unknown[] = [];
  const port: AdministrationPort = {
    status: vi.fn(async (target) => status(target)),
    logs: vi.fn(async () => ({ entries: [] })),
    machine: vi.fn(async () => SNAPSHOT),
    submit: vi.fn(async (input) => {
      submitted.push(input);
      return { accepted: true };
    }),
    inspect: vi.fn(async (operationId): Promise<AdministrationJob> => {
      if (operationId === 'missing') throw notFound('Administration operation', operationId);
      return { operationId, state: 'running', result: null, errorCode: null, updatedAt: AT };
    }),
  };
  return { port, submitted };
}

/** The engine's handlers, as the rpc would call them. */
function engineSide(withAdministration: boolean) {
  const handlers = new Map<string, (params: unknown, context: unknown) => Promise<unknown>>();
  const rpc = {
    handle: (method: string, handler: never) => {
      handlers.set(method, handler);
      return () => undefined;
    },
  } as unknown as EngineRpc;
  const fake = fakePort();
  createEngineHandlers({
    limit: { check: async (_method: string, params: unknown) => params } as never,
    audit: { record: () => undefined } as never,
    runner: {} as never,
    transcripts: {} as never,
    planUsageFor: (() => ({})) as never,
    engine: {} as never,
    github: {} as never,
    probe: {} as never,
    transfers: {} as never,
    mcpBase: 'http://127.0.0.1:4801',
    emit: () => undefined,
    terminals: new Set(),
    exportDir: '/nonexistent',
    ...(withAdministration ? { administration: { port: fake.port, target: OWN } } : {}),
  }).register(rpc);
  const call = (method: string, params: unknown) => handlers.get(method)!(params, { id: 'r1' });
  return { ...fake, call };
}

const restart = (target: unknown, operationId = 'op1') => ({
  operationId,
  requestId: 'req1',
  command: { kind: 'restart', target, expectedBootId: 'boot-1' },
});

describe('the wire methods', () => {
  it('are asked by the cloud only: the engine answers them and cannot call them', () => {
    for (const name of ['admin.status', 'admin.logs', 'admin.submit', 'admin.inspect'] as EngineMethod[])
      expect(methods[name].direction, name).toBe('engine');
  });

  it('refuse a key that is not in the schema, so no program, path or service can ride along', () => {
    expect(methods['admin.status'].params.safeParse({ target: OWN }).success).toBe(true);
    expect(methods['admin.status'].params.safeParse({ target: OWN, program: '/bin/sh' }).success).toBe(false);
    expect(methods['admin.logs'].params.safeParse({ target: OWN, limit: 201 }).success).toBe(false);
    expect(methods['admin.submit'].params.safeParse(restart(OWN)).success).toBe(true);
    expect(
      methods['admin.submit'].params.safeParse({
        ...restart(OWN),
        command: { kind: 'restart', target: OWN, expectedBootId: 'b', unit: 'sshd.service' },
      }).success,
    ).toBe(false);
    expect(
      methods['admin.submit'].params.safeParse({ ...restart(OWN), command: { kind: 'exec', argv: ['sh'] } })
        .success,
    ).toBe(false);
    expect(methods['admin.inspect'].params.safeParse({ operationId: '../x' }).success).toBe(false);
  });
});

describe('the hello', () => {
  it('carries the capabilities only as the known names, and an old hello without them is still valid', () => {
    const base = helloOf();
    expect(Hello.safeParse(base).success).toBe(true);
    expect(Hello.safeParse({ ...base, administration: ['status', 'restart'] }).success).toBe(true);
    expect(Hello.safeParse({ ...base, administration: ['root_shell'] }).success).toBe(false);
  });
});

describe('the engine handlers', () => {
  it('forwards owner commands only to its own supervisor target', async () => {
    const side = engineSide(true);
    const input = (target: unknown) => ({
      operationId: 'owner1',
      requestId: 'req1',
      command: {
        kind: 'owner_command',
        target,
        command: 'pwd',
        timeoutSeconds: 120,
        reason: 'Inspect fixture',
      },
    });
    await expect(side.call('admin.submit', input({ kind: 'hub' }))).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(side.call('admin.submit', input(OWN))).resolves.toEqual({ accepted: true });
    expect(side.submitted).toEqual([input(OWN)]);
  });
  it('serve only the engine’s own target', async () => {
    const side = engineSide(true);
    await expect(side.call('admin.status', { target: OWN })).resolves.toMatchObject({ online: true });
    await expect(side.call('admin.status', { target: { kind: 'hub' } })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(side.call('admin.status', { target: { kind: 'engine', id: OTHER } })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(side.call('admin.logs', { target: { kind: 'hub' }, limit: 5 })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    expect(side.port.status).toHaveBeenCalledTimes(1);
    expect(side.port.logs).not.toHaveBeenCalled();
  });

  it('refuse a restart of another target and a deploy, and reach the supervisor only for an own restart', async () => {
    const side = engineSide(true);
    await expect(side.call('admin.submit', restart({ kind: 'hub' }))).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(side.call('admin.submit', restart({ kind: 'engine', id: OTHER }))).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(
      side.call('admin.submit', {
        operationId: 'd1',
        requestId: 'r',
        command: { kind: 'deploy', releaseId: 'rel1' },
      }),
    ).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    expect(side.submitted).toEqual([]);
    await expect(side.call('admin.submit', restart(OWN))).resolves.toEqual({ accepted: true });
    expect(side.submitted).toHaveLength(1);
  });

  it('pass a full test or an image build to the supervisor, which decides whether it can run it', async () => {
    const side = engineSide(true);
    await side.call('admin.submit', {
      operationId: 't1',
      requestId: 'r',
      command: { kind: 'full_test', taskKey: 'PM-1', commit: 'c'.repeat(40), profile: 'merge-test' },
    });
    expect(side.submitted).toHaveLength(1);
    await expect(side.call('admin.inspect', { operationId: 'missing' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('answer nothing where the engine has no supervisor', async () => {
    const side = engineSide(false);
    await expect(side.call('admin.status', { target: OWN })).rejects.toBeDefined();
  });
});

describe('the hub’s way to an engine', () => {
  function setup(hello: Parameters<typeof helloOf>[0]) {
    const cloud = createFakeCloud();
    const hub = createRemoteHub({ links: cloud.links, registry: cloud.registry, logger: silentLogger() });
    const administration = createRemoteAdministration({ hub });
    const engine = cloud.connect(ENGINE, { hello });
    return { cloud, hub, administration, engine };
  }

  it('transports owner commands only when the engine advertises the opt-in capability', async () => {
    const old = setup({ administration: ['status', 'restart'] });
    const input = {
      operationId: 'owner1',
      requestId: 'req1',
      command: {
        kind: 'owner_command',
        target: OWN,
        command: 'pwd',
        timeoutSeconds: 120,
        reason: 'Inspect fixture',
      },
    } as const;
    await expect(old.administration.port(ENGINE).submit(input)).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    expect(old.engine.requests).toEqual([]);
    const enabled = setup({ administration: ['status', 'owner_command'] });
    enabled.engine.answer('admin.submit', async () => ({ accepted: true }));
    enabled.engine.answer('admin.inspect', async ({ operationId }) => ({
      operationId,
      state: 'succeeded',
      errorCode: null,
      updatedAt: AT,
      result: {
        kind: 'owner_command',
        exitCode: 0,
        signal: null,
        stdout: 'fixture',
        stderr: '',
        truncated: false,
        durationMs: 1,
      },
    }));
    const port = enabled.administration.port(ENGINE);
    expect(await port.submit(input)).toEqual({ accepted: true });
    expect((await port.inspect(input.operationId)).result).toMatchObject({
      kind: 'owner_command',
      stdout: 'fixture',
    });
    expect(enabled.engine.requests[0]?.params).toEqual(input);
  });

  it('calls the engine when it announced the capability, and validates what comes back', async () => {
    const { administration, engine } = setup({ administration: ['status', 'logs', 'restart'] });
    const answers = fakePort();
    engine.answer('admin.status', (params) => answers.port.status(params.target));
    engine.answer('admin.submit', (params) => answers.port.submit(params));
    const port = administration.port(ENGINE);
    expect(await port.status(OWN)).toMatchObject({ online: true, bootId: 'boot-1' });
    expect(await port.submit(restart(OWN) as never)).toEqual({ accepted: true });
    expect(engine.requests.map((request) => request.method)).toEqual(['admin.status', 'admin.submit']);
  });

  it('is unavailable, without a call, for an engine that did not announce the capability', async () => {
    const { administration, engine } = setup({});
    const answered = vi.fn();
    engine.answer('admin.status', answered as never);
    const port = administration.port(ENGINE);
    await expect(port.status(OWN)).rejects.toMatchObject({ code: 'administration_unavailable' });
    await expect(port.submit(restart(OWN) as never)).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    expect(answered).not.toHaveBeenCalled();
    expect(engine.requests).toEqual([]);
  });

  it('asks only for what the engine announced', async () => {
    const { administration } = setup({ administration: ['status', 'logs'] });
    const port = administration.port(ENGINE);
    await expect(port.submit(restart(OWN) as never)).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    await expect(
      port.submit({
        operationId: 't1',
        requestId: 'r',
        command: { kind: 'full_test', taskKey: 'PM-1', commit: 'c'.repeat(40), profile: 'merge-test' },
      }),
    ).rejects.toMatchObject({ code: 'administration_unavailable' });
  });

  it('is unavailable for an engine that is not connected, and for one the hub does not know', async () => {
    const { administration, engine } = setup({ administration: ['status'] });
    engine.disconnect();
    await expect(administration.port(ENGINE).status(OWN)).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    await expect(administration.port(OTHER).status({ kind: 'engine', id: OTHER })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('gives the engine’s refusal back under the same code, and a failure of the call as a plain failure', async () => {
    const { administration, engine } = setup({ administration: ['status', 'logs', 'restart'] });
    engine.answer('admin.status', async () => {
      throw Object.assign(new Error('mismatch'), { code: 'administration_target_mismatch' });
    });
    engine.answer('admin.logs', async () => {
      throw new Error('boom with a secret-canary');
    });
    const port = administration.port(ENGINE);
    await expect(port.status(OWN)).rejects.toMatchObject({ code: 'administration_target_mismatch' });
    const failure = await port.logs(OWN, { limit: 5 }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'administration_failed' });
    expect(String((failure as Error).message)).not.toContain('canary');
  });

  it('lists every engine the registry knows, for the operation lookup', () => {
    const { administration } = setup({});
    expect(administration.ids()).toEqual([ENGINE]);
  });

  it('reads the machine of an engine that announced it, and validates the snapshot', async () => {
    const { administration, engine } = setup({ administration: ['status', 'logs', 'machine'] });
    engine.answer('admin.machine', async () => SNAPSHOT);
    expect(await administration.port(ENGINE).machine(OWN)).toEqual(SNAPSHOT);
    expect(engine.requests.map((request) => request.method)).toEqual(['admin.machine']);
  });

  it('gives an engine that predates the machine state, its log filters and the cleanup an unavailable answer', async () => {
    const { administration, engine } = setup({ administration: ['status', 'logs', 'restart'] });
    const answered = vi.fn();
    engine.answer('admin.machine', answered as never);
    engine.answer('admin.logs', answered as never);
    engine.answer('admin.submit', answered as never);
    const port = administration.port(ENGINE);
    await expect(port.machine(OWN)).rejects.toMatchObject({ code: 'administration_unavailable' });
    await expect(port.logs(OWN, { limit: 5, minLevel: 'warn' })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    await expect(
      port.submit({
        operationId: 'c1',
        requestId: 'r',
        command: { kind: 'process_cleanup', target: OWN, selector: 'orphan_test_workers' },
      }),
    ).rejects.toMatchObject({ code: 'administration_unavailable' });
    expect(answered).not.toHaveBeenCalled();
  });

  it('sends the log filters only when they are set, and the service log only to an engine that has one', async () => {
    const { administration, engine } = setup({ administration: ['status', 'logs', 'machine'] });
    engine.answer('admin.logs', async () => ({ entries: [] }));
    const port = administration.port(ENGINE);
    await port.logs(OWN, { limit: 5 });
    await port.logs(OWN, { limit: 5, minLevel: 'warn', contains: 'timeout' });
    expect(engine.requests.map((request) => request.params)).toEqual([
      { target: OWN, limit: 5 },
      { target: OWN, limit: 5, minLevel: 'warn', contains: 'timeout' },
    ]);
    await expect(port.logs(OWN, { limit: 5, source: 'service' })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });

  it('serves the machine and the cleanup only for the engine’s own target', async () => {
    const side = engineSide(true);
    await expect(side.call('admin.machine', { target: OWN })).resolves.toEqual(SNAPSHOT);
    await expect(side.call('admin.machine', { target: { kind: 'hub' } })).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    const cleanup = (target: unknown) => ({
      operationId: 'c1',
      requestId: 'r',
      command: { kind: 'process_cleanup', target, selector: 'orphan_test_workers' },
    });
    await expect(side.call('admin.submit', cleanup({ kind: 'hub' }))).rejects.toMatchObject({
      code: 'administration_target_mismatch',
    });
    await expect(side.call('admin.submit', cleanup(OWN))).resolves.toEqual({ accepted: true });
    expect(side.submitted).toHaveLength(1);
  });
});
