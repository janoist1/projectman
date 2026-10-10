import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  DEFAULT_AGENT_PROVIDER,
  LOCAL_ENGINE_ID,
  isOnLeave,
} from '@projectman/shared';
import type { AgentProvider, EngineId, HumanMemberConfig, Task } from '@projectman/shared';
import type { ProviderStatus, EngineDirectory } from '../src/contracts';
import type { AutomaticStart } from '../src/domain/admission';
import { DeferredStarts } from '../src/domain/admission';
import { WorkOutages } from '../src/domain/outages';
import { createLocalEngine } from '../src/domain/engines';
import type { ProjectAccess } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { FakeWorktreeManager, capturingLogger, flush } from './helpers/fakes';

function status(
  provider: AgentProvider,
  loggedIn: boolean | null,
  problem?: ProviderStatus['problem'],
): ProviderStatus {
  return { provider, loggedIn, problem, method: null, checkedAt: '2026-10-10T20:00:00Z' };
}

describe('work outage watch', () => {
  let h: DomainHarness;
  let watch: WorkOutages;
  let deferred: DeferredStarts;
  let probe: ReturnType<typeof vi.fn>;
  let retry: ReturnType<typeof vi.fn>;
  let online: boolean;
  let engineId: EngineId | null;
  let directory: EngineDirectory;
  let engineListeners: Array<(id: EngineId, online: boolean) => void>;
  const remote = 'eng_abcdefghijkl';

  beforeEach(async () => {
    online = true;
    engineId = LOCAL_ENGINE_ID;
    engineListeners = [];
    const engine = createLocalEngine(
      { worktrees: new FakeWorktreeManager('/fictional'), workspacePath: () => null, claudeTmpRoots: [] },
      capturingLogger().logger,
    );
    directory = {
      get: () => (online ? engine : null),
      ids: () => (engineId ? [engineId] : []),
      engineFor: () => engineId,
      onChange: (listener) => {
        engineListeners.push(listener);
        return () => {
          engineListeners = engineListeners.filter((entry) => entry !== listener);
        };
      },
    };
    h = await createDomainHarness({ engines: directory });
    probe = vi.fn(async (provider: AgentProvider) => status(provider, false));
    Object.assign(h.runner, { providerStatus: probe });
    deferred = new DeferredStarts();
    retry = vi.fn();
    watch = new WorkOutages({
      ctx: h.domain.ctx,
      projects: h.domain.projects,
      inbox: h.domain.inbox,
      engines: directory,
      runner: h.runner,
      deferred,
      messaging: h.domain.messaging,
      members: h.domain.members,
      tasks: h.domain.tasks,
      retry,
      engineName: () => 'Mac mini',
    });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await watch.stop();
    await h.cleanup();
  });

  function alerts() {
    return h.domain.inbox
      .list('AR', { kind: 'alert' })
      .filter((item) => alertPayloadOf(item)?.alert === 'work_outage');
  }
  function access(handle = 'owner'): ProjectAccess {
    return {
      projectKey: 'AR',
      handle,
      access: 'owner',
      member: h.domain.projects.cachedConfig('AR')!.team.members[0] as HumanMemberConfig,
    };
  }
  function keep(
    task: Task,
    reason: 'provider_not_logged_in' | 'codex_setup_incomplete' | 'engine_offline' = 'provider_not_logged_in',
  ) {
    const start: AutomaticStart = {
      key: task.key,
      projectKey: 'AR',
      taskKey: task.key,
      spec: () => ({
        kind: 'provider_resume',
        projectKey: 'AR',
        taskKey: task.key,
        handle: 'dev-1',
        stageId: task.stageId,
      }),
      stillValid: (current) => current?.status === 'active',
      run: async () => {},
      retry: async () => {},
      waitsFor: () => 'dev-1',
      log: { deferred: 'deferred', retryFailed: 'failed', fields: () => ({}) },
    };
    deferred.keep({
      start,
      waiting: {
        reason,
        member: 'dev-1',
        ...(reason === 'engine_offline' && engineId ? { engine: engineId } : {}),
        since: task.createdAt,
      },
    });
  }

  it('warns without deferred tasks and records only failed active members', async () => {
    probe.mockImplementation(async (provider, opts) =>
      status(provider, opts.member === 'dev-1' ? false : true, 'cli_missing'),
    );
    await watch.check();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      assignees: ['owner'],
      source: 'system',
      payload: {
        alert: 'work_outage',
        members: ['dev-1'],
        tasks: [],
        outage: { provider: DEFAULT_AGENT_PROVIDER, problem: 'cli_missing', engine: null },
      },
    });
    expect(watch.forMember('AR', 'dev-1')?.kind).toBe('provider');
    expect(watch.forMember('AR', 'dev-2')).toBeUndefined();
    expect(probe).toHaveBeenCalledWith('claude', { member: 'dev-1', refresh: true });
  });

  it('updates affected cards, suppresses acknowledged repeats and starts a new episode after recovery', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Waiting work' }, OWNER_ACTOR);
    keep(task);
    await watch.check();
    const item = alerts()[0]!;
    const since = watch.forTask(task)?.since;
    expect(item.payload.tasks).toEqual([task.key]);
    expect(watch.forTask(task)?.id).toBe('provider:claude:local');
    const publish = vi.spyOn(h.domain.bus, 'publish');
    deferred.drop(task.key);
    await watch.check();
    expect(alerts()[0]!.payload.tasks).toEqual([]);
    expect(publish.mock.calls.some(([event]) => event.type === 'inbox_upserted')).toBe(true);
    publish.mockClear();
    await watch.check();
    expect(publish.mock.calls.some(([event]) => event.type === 'inbox_upserted')).toBe(false);
    await watch.observeRefusal('AR', 'dev-1', 'provider_not_logged_in');
    expect(alerts()).toHaveLength(1);
    await h.domain.inbox.resolve('AR', item.id, { optionId: 'seen' }, access());
    await watch.check();
    expect(alerts()).toHaveLength(1);
    expect(watch.forMember('AR', 'dev-1')?.since).toBe(since);
    probe.mockImplementation(async (provider) => status(provider, true));
    await watch.check();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(watch.forMember('AR', 'dev-1')).toBeUndefined();
    probe.mockImplementation(async (provider) => status(provider, false));
    await watch.check();
    expect(alerts()).toHaveLength(2);
  });

  it('resolves an open alert only after confirmed recovery, including a manual check', async () => {
    await watch.check();
    const item = alerts()[0]!;
    expect((await watch.checkNow('AR', item.id, access())).stillFailing).toBe(true);
    probe.mockImplementation(async (provider) => status(provider, null));
    expect((await watch.checkNow('AR', item.id, access())).stillFailing).toBe(true);
    expect(alerts()[0]!.state).toBe('open');
    probe.mockImplementation(async (provider) => status(provider, true));
    expect(await watch.checkNow('AR', item.id, access())).toMatchObject({
      stillFailing: false,
      item: {
        state: 'resolved',
        resolution: { rule: 'outage_ended' },
      },
    });
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not alert for unknown, failed or unused provider checks', async () => {
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    probe.mockRejectedValue(new Error('unavailable'));
    await watch.check();
    expect(alerts()).toEqual([]);
    expect(probe.mock.calls.every(([provider]) => provider === 'claude')).toBe(true);
  });

  it('cancels a warning when its last affected member goes on leave', async () => {
    probe.mockImplementation(async (provider, opts) => status(provider, opts.member !== 'dev-1'));
    await watch.check();
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const member = config.team.members.find((m) => m.handle === 'dev-1')!;
      if (member.kind === 'ai') member.onLeave = true;
      return 'Put member on leave';
    });
    await watch.check();
    expect(alerts()[0]!.state).toBe('cancelled');
    expect(retry).not.toHaveBeenCalled();
  });

  it('warns for a disconnected remote engine without probing its provider, then resolves it', async () => {
    engineId = remote;
    online = false;
    const task = await h.domain.tasks.create('AR', { title: 'Offline work' }, OWNER_ACTOR);
    keep(task, 'engine_offline');
    await watch.check();
    expect(probe).not.toHaveBeenCalled();
    expect(alerts()[0]).toMatchObject({
      title: 'Engine "Mac mini" is not connected',
      payload: {
        tasks: [task.key],
        outage: { kind: 'engine', engine: { id: remote, name: 'Mac mini' } },
      },
    });
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    const release = vi.spyOn(h.domain.messaging, 'releaseForEngine');
    await watch.recheck({ kind: 'engine', engineId: remote });
    expect(alerts()[0]).toMatchObject({ state: 'resolved', resolution: { rule: 'outage_ended' } });
    expect(release).toHaveBeenCalledWith(remote);
    expect(probe).not.toHaveBeenCalled();
  });

  it('carries remote provider identity and preserves its failure during an engine disconnect', async () => {
    engineId = remote;
    await watch.check();
    const item = alerts()[0]!;
    expect(item.payload.outage).toMatchObject({ kind: 'provider', engine: { id: remote, name: 'Mac mini' } });
    online = false;
    await watch.check();
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
  });

  it('includes cards with messages waiting for an engine, without deferred starts', async () => {
    engineId = remote;
    online = false;
    const task = await h.domain.tasks.create('AR', { title: 'Waiting message' }, OWNER_ACTOR);
    await h.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      taskKey: task.key,
      text: 'Please read this task',
    });
    expect(h.domain.messaging.pendingTaskKeys('AR', 'dev-1')).toEqual([task.key]);
    await watch.check();
    expect(alerts()[0]!.payload.tasks).toEqual([task.key]);
    expect(watch.forTask(task)).toMatchObject({ kind: 'engine', engine: { id: remote } });
    expect(deferred.list()).toEqual([]);
  });

  it('reacts to engine connection events through the domain hook', async () => {
    engineId = remote;
    online = false;
    for (const listener of engineListeners) listener(remote, false);
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    const item = alerts()[0]!;
    expect(item.payload.outage).toMatchObject({ kind: 'engine' });
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    for (const listener of engineListeners) listener(remote, true);
    await vi.waitFor(() => expect(h.domain.inbox.get('AR', item.id).resolution?.rule).toBe('outage_ended'));
  });

  it('rechecks auth errors on the session engine and retains version diagnostics', async () => {
    engineId = remote;
    probe.mockImplementation(async (provider) => ({
      ...status(provider, false, 'cli_too_old'),
      cliVersion: '1.0.0',
      minCliVersion: '2.0.0',
    }));
    await watch.observeAuthError('AR', 'dev-1', 'claude', remote);
    expect(probe).toHaveBeenCalledWith('claude', { member: 'dev-1', engineId: remote, refresh: true });
    expect(alerts()[0]!.payload.outage).toMatchObject({
      problem: 'cli_too_old',
      cliVersion: '1.0.0',
      minCliVersion: '2.0.0',
    });
  });

  it('recovers a no-engine warning when a connected engine is chosen', async () => {
    engineId = null;
    await watch.check();
    const item = alerts()[0]!;
    expect(item.title).toBe('No engine is connected');
    engineId = remote;
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.recheck({ kind: 'engine', engineId: remote });
    expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
      state: 'resolved',
      resolution: { rule: 'outage_ended' },
    });
  });

  it('opens setup failures even when login works and resolves them when the deferral ends', async () => {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const member = config.team.members.find((m) => m.handle === 'dev-1')!;
      if (member.kind === 'ai') member.provider = 'codex';
      return 'Use Codex';
    });
    probe.mockImplementation(async (provider) => status(provider, true));
    const task = await h.domain.tasks.create('AR', { title: 'Sandbox setup' }, OWNER_ACTOR);
    keep(task, 'codex_setup_incomplete');
    await watch.observeRefusal('AR', 'dev-1', 'codex_setup_incomplete', { problem: 'sandbox_config' });
    expect(alerts()[0]!.payload.outage).toMatchObject({ provider: 'codex', problem: 'setup_incomplete' });
    await watch.check();
    expect(alerts()[0]!.state).toBe('open');
    probe.mockImplementation(async (provider) => status(provider, false));
    await watch.check();
    probe.mockImplementation(async (provider) => status(provider, true));
    await watch.check();
    expect(alerts()[0]!.state).toBe('open');
    expect(alerts()[0]!.payload.outage).toMatchObject({ problem: 'setup_incomplete' });
    deferred.drop(task.key);
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    expect(alerts()[0]!.resolution?.rule).toBe('outage_ended');
  });

  it('retries a recovered member while another launcher login still fails', async () => {
    await watch.check();
    probe.mockImplementation(async (provider, opts) => status(provider, opts.member === 'dev-1'));
    await watch.check();
    expect(watch.forMember('AR', 'dev-1')).toBeUndefined();
    expect(watch.forMember('AR', 'dev-2')).toBeDefined();
    expect(alerts()[0]!.state).toBe('open');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shares the episode start across projects and resolves their warnings with one retry', async () => {
    await h.domain.projects.create(
      { key: 'BR', name: 'Other project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    await watch.check();
    const first = alerts()[0]!;
    const second = h.domain.inbox
      .list('BR', { state: 'open', kind: 'alert' })
      .find((item) => alertPayloadOf(item)?.alert === 'work_outage')!;
    expect(second.payload.outage).toEqual(first.payload.outage);
    probe.mockImplementation(async (provider) => status(provider, true));
    await watch.check();
    expect(h.domain.inbox.get('BR', second.id).resolution?.rule).toBe('outage_ended');
    expect(h.domain.inbox.get('AR', first.id).resolution?.rule).toBe('outage_ended');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('checks permissions and the alert kind before any probe', async () => {
    await watch.check();
    const item = alerts()[0]!;
    probe.mockClear();
    await expect(watch.checkNow('AR', item.id, access('someone'))).rejects.toMatchObject({
      status: 403,
      code: 'not_an_assignee',
    });
    const disk = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      assignees: ['owner'],
      source: 'system',
      title: 'Disk low',
      payload: { alert: 'disk_low', freeBytes: 1, thresholdBytes: 2 },
      options: [ALERT_SEEN_OPTION],
    });
    await expect(watch.checkNow('AR', disk.id, access())).rejects.toMatchObject({
      status: 409,
      code: 'not_an_outage_alert',
    });
    await expect(watch.checkNow('AR', 'missing', access())).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await h.domain.inbox.resolve('AR', item.id, { optionId: 'seen' }, access());
    await expect(watch.checkNow('AR', item.id, access())).rejects.toMatchObject({
      status: 409,
      code: 'inbox_item_closed',
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(['periodic', 'targeted'] as const)(
    'bounds %s checks at twenty seconds and skips overlapping ticks',
    async (kind) => {
      vi.useFakeTimers();
      probe.mockImplementation(() => new Promise(() => {}));
      const first = kind === 'periodic' ? watch.check() : watch.recheckProvider('claude');
      await Promise.resolve();
      await watch.check();
      await vi.advanceTimersByTimeAsync(20_000);
      await first;
      expect(alerts()).toEqual([]);
      expect(probe.mock.calls.length).toBe(
        h.domain.projects.cachedConfig('AR')!.team.members.filter((m) => m.kind === 'ai' && !isOnLeave(m))
          .length,
      );
    },
  );

  it('adopts the original start time of an open alert and does not close it on unknown checks', async () => {
    await watch.check();
    const item = alerts()[0]!;
    await watch.stop();
    watch = new WorkOutages({
      ctx: h.domain.ctx,
      projects: h.domain.projects,
      inbox: h.domain.inbox,
      engines: directory,
      runner: h.runner,
      deferred,
      messaging: h.domain.messaging,
      members: h.domain.members,
      tasks: h.domain.tasks,
      retry,
    });
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.state).toBe('open');
    expect(watch.forMember('AR', 'dev-1')?.since).toBe((item.payload.outage as { since: string }).since);
  });

  it('publishes member and task outages through the domain views after an admission refusal', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Unavailable provider' }, OWNER_ACTOR);
    await expect(
      h.domain.taskStarts.start('AR', task.key, { actor: OWNER_ACTOR, author: OWNER, assignee: 'dev-1' }),
    ).rejects.toMatchObject({ code: 'provider_not_logged_in' });
    await h.domain.outages.check();
    expect((await h.domain.members.roster('AR')).find((m) => m.handle === 'dev-1')?.outage).toMatchObject({
      kind: 'provider',
    });
    await flush();
  });
});
