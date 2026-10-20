import { describe, expect, it, vi } from 'vitest';
import type { EngineId } from '@projectman/shared';
import { notFound, unavailable } from '../kernel';
import type { AdministrationJob, AdministrationPort, AdministrationStatus } from '../contracts';
import { createAdministrationService } from './service';

const ENGINE = 'eng_aaaaaaaaaaaa' as EngineId;
const OTHER = 'eng_bbbbbbbbbbbb' as EngineId;
const COMMIT = 'b'.repeat(40);
const AT = '2026-10-17T10:00:00.000Z';

const job = (operationId: string, patch: Partial<AdministrationJob> = {}): AdministrationJob => ({
  operationId,
  state: 'running',
  result: null,
  errorCode: null,
  updatedAt: AT,
  ...patch,
});

function fakePort(name: string, known: Record<string, AdministrationJob> = {}) {
  const port: AdministrationPort & { calls: string[] } = {
    calls: [],
    async status(target) {
      port.calls.push(`status:${name}`);
      return {
        target,
        online: true,
        version: null,
        bootId: 'b',
        capabilities: ['status'],
        activeOperationId: null,
      } as AdministrationStatus;
    },
    async logs() {
      port.calls.push(`logs:${name}`);
      return { entries: [] };
    },
    async machine() {
      port.calls.push(`machine:${name}`);
      return {
        at: AT,
        loadAvg: [0, 0, 0],
        memory: { totalBytes: 1, availableBytes: 1 },
        swap: null,
        topProcesses: [],
      };
    },
    async submit(input) {
      port.calls.push(`submit:${name}:${input.operationId}`);
      return { accepted: true };
    },
    async inspect(operationId) {
      port.calls.push(`inspect:${name}`);
      const found = known[operationId];
      if (!found) throw notFound('Administration operation', operationId);
      return found;
    },
  };
  return port;
}

function build(options: {
  hub?: AdministrationPort | null;
  engines?: Record<string, AdministrationPort>;
  online?: string[];
  fence?: { releaseId: string } | null;
  builder?: EngineId | null;
}) {
  const engines = options.engines ?? {};
  return createAdministrationService({
    hub: options.hub === undefined ? fakePort('hub') : options.hub,
    engines: {
      port: (id) => {
        const port = engines[id];
        if (!port) throw unavailable('administration_unavailable', 'no supervisor');
        return port;
      },
      ids: () => Object.keys(engines) as EngineId[],
    },
    isEngineOnline: (id) => (options.online ?? []).includes(id),
    fence: () => options.fence ?? null,
    builderEngine: () => (options.builder === undefined ? null : options.builder),
  });
}

const restartOf = (target: { kind: 'hub' } | { kind: 'engine'; id: EngineId }, operationId = 'op1') => ({
  operationId,
  requestId: 'req1',
  command: { kind: 'restart' as const, target, expectedBootId: 'boot-1' },
});

describe('routing', () => {
  it('routes an owner command to its target without requiring a builder', async () => {
    const hub = fakePort('hub');
    const engine = fakePort('engine');
    const service = build({ hub, engines: { [ENGINE]: engine } });
    const command = {
      kind: 'owner_command',
      command: 'pwd',
      timeoutSeconds: 120,
      reason: 'Inspect fixture',
    } as const;
    await service.submit({
      operationId: 'owner1',
      requestId: 'req1',
      command: { ...command, target: { kind: 'hub' } },
    });
    await service.submit({
      operationId: 'owner2',
      requestId: 'req2',
      command: { ...command, target: { kind: 'engine', id: ENGINE } },
    });
    expect(hub.calls).toEqual(['submit:hub:owner1']);
    expect(engine.calls).toEqual(['submit:engine:owner2']);
  });
  it('sends status, logs and a restart to the supervisor of the named target only', async () => {
    const hub = fakePort('hub');
    const engine = fakePort('engine');
    const other = fakePort('other');
    const service = build({ hub, engines: { [ENGINE]: engine, [OTHER]: other } });
    await service.status({ kind: 'engine', id: ENGINE });
    await service.logs({ kind: 'hub' }, { limit: 5 });
    await service.submit(restartOf({ kind: 'engine', id: ENGINE }));
    expect(engine.calls).toEqual(['status:engine', 'submit:engine:op1']);
    expect(hub.calls).toEqual(['logs:hub']);
    expect(other.calls).toEqual([]);
  });

  it('runs a deploy on the hub and a full test or image build on the builder engine', async () => {
    const hub = fakePort('hub');
    const engine = fakePort('engine');
    const service = build({ hub, engines: { [ENGINE]: engine }, builder: ENGINE });
    await service.submit({
      operationId: 'd1',
      requestId: 'r',
      command: { kind: 'deploy', releaseId: 'rel1' },
    });
    await service.submit({
      operationId: 't1',
      requestId: 'r',
      command: { kind: 'full_test', taskKey: 'PM-1', commit: COMMIT, profile: 'merge-test' },
    });
    await service.submit({
      operationId: 'i1',
      requestId: 'r',
      command: { kind: 'image_build', taskKey: 'PM-1', commit: COMMIT, platforms: ['linux/amd64'] },
    });
    expect(hub.calls).toEqual(['submit:hub:d1']);
    expect(engine.calls).toEqual(['submit:engine:t1', 'submit:engine:i1']);
  });

  it('is unavailable, not guessing, when there is no hub supervisor, no builder or no engine supervisor', async () => {
    await expect(build({ hub: null }).status({ kind: 'hub' })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
    const noBuilder = build({ builder: null });
    await expect(
      noBuilder.submit({
        operationId: 't1',
        requestId: 'r',
        command: { kind: 'full_test', taskKey: 'PM-1', commit: COMMIT, profile: 'full-test' },
      }),
    ).rejects.toMatchObject({ code: 'administration_unavailable' });
    await expect(build({}).status({ kind: 'engine', id: ENGINE })).rejects.toMatchObject({
      code: 'administration_unavailable',
    });
  });
});

describe('release fence', () => {
  it('keeps a restart out while a deployment holds the instance, for the hub and for an engine, and reaches no supervisor', async () => {
    const hub = fakePort('hub');
    const engine = fakePort('engine');
    const service = build({ hub, engines: { [ENGINE]: engine }, fence: { releaseId: 'rel9' } });
    for (const target of [{ kind: 'hub' } as const, { kind: 'engine', id: ENGINE } as const])
      await expect(service.submit(restartOf(target))).rejects.toMatchObject({
        code: 'release_pause_conflict',
      });
    expect(hub.calls).toEqual([]);
    expect(engine.calls).toEqual([]);
  });

  it('does not hold back a deploy, which is the release itself', async () => {
    const hub = fakePort('hub');
    const service = build({ hub, fence: { releaseId: 'rel9' } });
    await service.submit({
      operationId: 'd1',
      requestId: 'r',
      command: { kind: 'deploy', releaseId: 'rel9' },
    });
    expect(hub.calls).toEqual(['submit:hub:d1']);
  });
});

describe('inspect', () => {
  it('finds an operation by id on whichever supervisor holds it, hub first', async () => {
    const hub = fakePort('hub', { h1: job('h1') });
    const engine = fakePort('engine', {
      e1: job('e1', { state: 'failed', errorCode: 'administration_failed' }),
    });
    const service = build({ hub, engines: { [ENGINE]: engine } });
    expect(await service.inspect('h1')).toMatchObject({ operationId: 'h1' });
    expect(engine.calls).toEqual([]);
    expect(await service.inspect('e1')).toMatchObject({ state: 'failed' });
    await expect(service.inspect('nope')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('does not hide an unreachable supervisor behind not_found, but still finds the operation elsewhere', async () => {
    const engine = fakePort('engine', { e1: job('e1') });
    const downHub: AdministrationPort = {
      ...fakePort('hub'),
      inspect: vi.fn(async () => {
        throw unavailable('administration_unavailable', 'down');
      }),
    };
    const service = build({ hub: downHub, engines: { [ENGINE]: engine } });
    expect(await service.inspect('e1')).toMatchObject({ operationId: 'e1' });
    await expect(service.inspect('missing')).rejects.toMatchObject({ code: 'administration_unavailable' });
  });

  it('keeps an engine restart running until the registry reports the engine online again', async () => {
    const done = job('e1', {
      state: 'succeeded',
      result: { kind: 'restart', bootId: 'boot-2', version: null },
    });
    const engine = fakePort('engine', { e1: done });
    const offline = build({ engines: { [ENGINE]: engine }, online: [] });
    expect(await offline.inspect('e1')).toMatchObject({ state: 'running', result: null });
    const online = build({ engines: { [ENGINE]: engine }, online: [ENGINE] });
    expect(await online.inspect('e1')).toMatchObject({
      state: 'succeeded',
      result: { kind: 'restart', bootId: 'boot-2' },
    });
  });
});
