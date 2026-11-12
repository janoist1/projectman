import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALERT_SEEN_OPTION,
  alertPayloadOf,
  DEFAULT_AGENT_PROVIDER,
  LOCAL_ENGINE_ID,
  isOnLeave,
  isIntegratorTodo,
} from '@projectman/shared';
import type { AgentProvider, EngineId, HumanMemberConfig, Task, WorkOutageAlert } from '@projectman/shared';
import type { ProviderStatus, EngineDirectory } from '../src/contracts';
import type { AutomaticStart } from '../src/runtime/admission';
import { DeferredStarts } from '../src/runtime/admission';
import { WorkOutages } from '../src/runtime/watchers';
import { createDomainEvents } from '../src/core/base';
import { ENGINE_OFFLINE_AFTER_MS } from '../src/engine-link';
import { createLocalEngine } from '../src/engine-host';
import type { ProjectAccess } from '../src/core/members';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { FakeWorktreeManager, capturingLogger, flush } from './helpers/fakes';
import { systemNotices } from './helpers/notices';

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
  let startedAt: Date;
  let clock: number;
  /** Lets a failing provider's backoff (30 s at first) run out. */
  const waitOutBackoff = () => {
    clock += 5 * 60_000;
  };
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
      projectEngine: () => engineId,
      hostEngine: () => engineId,
      onChange: (listener) => {
        engineListeners.push(listener);
        return () => {
          engineListeners = engineListeners.filter((entry) => entry !== listener);
        };
      },
    };
    h = await createDomainHarness({ engines: directory });
    vi.spyOn(h.domain.inbox, 'raiseAlert');
    probe = vi.fn(async (provider: AgentProvider) => status(provider, false));
    Object.assign(h.runner, { providerStatus: probe });
    deferred = new DeferredStarts();
    retry = vi.fn();
    watch = new WorkOutages({
      // This watch owns different deferrals and engine names from the domain's watch. Keep its
      // notifications isolated so an Operator wake-up cannot invoke the domain's separate watch.
      ctx: {
        ...h.domain.ctx,
        now: () => h.domain.ctx.now(),
        events: createDomainEvents(h.domain.ctx.logger),
      },
      projects: h.domain.projects,
      inbox: h.domain.inbox,
      engines: directory,
      runner: h.runner,
      deferred,
      messageRouter: h.domain.messageRouter,
      members: h.domain.members,
      tasks: h.domain.tasks,
      retry,
      engineName: () => 'Mac mini',
    });
    startedAt = h.domain.ctx.now();
    clock = startedAt.getTime() + ENGINE_OFFLINE_AFTER_MS;
    vi.spyOn(h.domain.ctx, 'now').mockImplementation(() => new Date(clock));
  });
  afterEach(async () => {
    vi.useRealTimers();
    await watch.stop();
    await h.cleanup();
  });

  /** The outage alerts raised so far: a new outage opens no inbox item, the route rule sends it on (PM-1250). */
  function raised() {
    return vi
      .mocked(h.domain.inbox.raiseAlert)
      .mock.calls.map(([input]) => ({ ...input, payload: input.payload as WorkOutageAlert }));
  }
  /** The outage alert items an earlier version left open: the watch still adopts, updates and closes them. */
  function alerts() {
    return h.domain.inbox
      .list('AR', { kind: 'alert' })
      .filter((item) => alertPayloadOf(item)?.alert === 'work_outage');
  }
  function legacyAlert(outageId = raised()[0]!.payload.outage.id) {
    return h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'alert',
      assignees: ['owner'],
      source: 'system',
      title: raised()[0]!.title,
      payload: watch.factsOf('AR', outageId)!,
      options: [ALERT_SEEN_OPTION],
    });
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

  /** Moves a member to another provider, so that its login state differs from the other members'. */
  async function useProvider(handle: string, provider: AgentProvider) {
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
      const member = config.team.members.find((m) => m.handle === handle)!;
      if (member.kind === 'ai') member.provider = provider;
      return `Use ${provider}`;
    });
  }

  it('warns without deferred tasks and records only the members of a failed provider', async () => {
    await useProvider('dev-2', 'codex');
    probe.mockImplementation(async (provider) =>
      status(provider, provider === 'claude' ? false : true, 'cli_missing'),
    );
    await watch.check();
    expect(raised()).toHaveLength(1);
    expect(raised()[0]).toMatchObject({
      projectKey: 'AR',
      payload: {
        alert: 'work_outage',
        members: ['cr', 'dev-1'],
        tasks: [],
        outage: { provider: DEFAULT_AGENT_PROVIDER, problem: 'cli_missing', engine: null },
      },
    });
    expect(alerts()).toEqual([]);
    expect(watch.forMember('AR', 'dev-1')?.kind).toBe('provider');
    expect(watch.forMember('AR', 'dev-2')).toBeUndefined();
    expect(probe).toHaveBeenCalledWith('claude', { refresh: false });
  });

  it('updates affected cards, tells about an episode once and starts a new episode after recovery', async () => {
    const task = await h.domain.tasks.create('AR', { title: 'Waiting work' }, OWNER_ACTOR);
    keep(task);
    await watch.check();
    const id = 'provider:claude:local';
    const since = watch.forTask(task)?.since;
    expect(raised()[0]!.payload.tasks).toEqual([task.key]);
    expect(watch.forTask(task)?.id).toBe(id);
    deferred.drop(task.key);
    await watch.check();
    expect(watch.factsOf('AR', id)?.tasks).toEqual([]);
    await watch.check();
    await watch.observeRefusal('AR', 'dev-1', 'provider_not_logged_in');
    expect(raised()).toHaveLength(1);
    expect(watch.forMember('AR', 'dev-1')?.since).toBe(since);
    probe.mockImplementation(async (provider) => status(provider, true));
    waitOutBackoff();
    await watch.check();
    expect(retry).toHaveBeenCalledTimes(1);
    expect(watch.forMember('AR', 'dev-1')).toBeUndefined();
    expect(watch.factsOf('AR', id)).toBeNull();
    probe.mockImplementation(async (provider) => status(provider, false));
    await watch.check();
    expect(raised()).toHaveLength(2);
  });

  it('preserves engine login backoff for periodic checks and admission refusals', async () => {
    await watch.check();
    await watch.observeRefusal('AR', 'dev-1', 'provider_not_logged_in');
    expect(probe.mock.calls.every(([, opts]) => opts.refresh === false)).toBe(true);
    probe.mockClear();
    await watch.recheckProvider('claude');
    expect(probe.mock.calls.every(([, opts]) => opts.refresh === true)).toBe(true);
  });

  it('asks a failing provider once per backoff step, however many rounds and refusals come between', async () => {
    const roundsAndRefusals = async () => {
      for (let round = 0; round < 3; round++) {
        await watch.check();
        for (const handle of ['dev-1', 'dev-2', 'cr'])
          await watch.observeRefusal('AR', handle, 'provider_not_logged_in');
      }
    };
    await roundsAndRefusals();
    expect(probe).toHaveBeenCalledTimes(1);
    let asked = 1;
    for (const step of [30_000, 60_000, 120_000, 300_000, 300_000]) {
      clock += step - 1;
      await roundsAndRefusals();
      expect(probe).toHaveBeenCalledTimes(asked);
      clock += 1;
      await roundsAndRefusals();
      expect(probe).toHaveBeenCalledTimes(++asked);
    }
    expect(probe.mock.calls.every(([, opts]) => opts.refresh === false)).toBe(true);
  });

  it('asks a provider once per round for all its members and keeps providers apart', async () => {
    await useProvider('dev-2', 'codex');
    await watch.check();
    expect(probe.mock.calls.map(([provider]) => provider).sort()).toEqual(['claude', 'codex']);
  });

  it('merges the queued checks of one refusal into a single check', async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => watch.observeRefusal('AR', 'dev-1', 'provider_not_logged_in')),
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(raised()).toHaveLength(1);
  });

  it.each([
    ['an auth error', () => watch.observeAuthError('AR', 'dev-1', 'claude', LOCAL_ENGINE_ID)],
    // "Check now" rechecks the outage's target.
    ['a check now', () => watch.recheck({ kind: 'provider', provider: 'claude', engineId: null })],
  ])('checks at once on %s and starts the backoff steps over', async (_name, ask) => {
    await watch.check();
    clock += 30_000;
    await watch.check();
    expect(probe).toHaveBeenCalledTimes(2);
    await ask();
    expect(probe).toHaveBeenCalledTimes(3);
    expect(probe).toHaveBeenLastCalledWith('claude', { refresh: true });
    clock += 30_000;
    await watch.check();
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it.each(['provider', 'engine'] as const)(
    'routes a %s outage affecting the project manager to the integrator and informs the owner once',
    async (kind) => {
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
        const pm = config.team.members.find((member) => member.handle === 'pm');
        if (pm?.kind === 'ai') pm.onLeave = false;
        return 'Activate the project manager';
      });
      const signals = { raise: vi.fn() };
      h.domain.inbox.registerAlertPmSignals(signals);
      if (kind === 'engine') {
        engineId = remote;
        online = false;
      }
      await watch.observeRefusal(
        'AR',
        'pm',
        kind === 'provider' ? 'provider_not_logged_in' : 'engine_offline',
      );
      await watch.check();
      const todos = h.domain.inbox.list('AR', { state: 'open', kind: 'question' });
      expect(todos).toHaveLength(1);
      expect(todos[0]).toMatchObject({
        kind: 'question',
        payload: { recipient: 'integrator' },
        route: { kind: 'alert:work_outage', to: 'integrator_queue', reason: 'pm_affected' },
      });
      expect(isIntegratorTodo(todos[0]!)).toBe(true);
      expect(signals.raise).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(systemNotices(h, 'work_outage')).toHaveLength(1));
      expect(systemNotices(h, 'work_outage')[0]).toMatchObject({ to: ['owner'], kind: 'info' });
      expect(systemNotices(h, 'work_outage')[0]?.origin.params).toMatchObject({
        since: raised()[0]!.payload.outage.since,
        problem: kind === 'provider' ? 'not_logged_in' : 'engine',
      });
      online = true;
      probe.mockImplementation(async (provider) => status(provider, true));
      waitOutBackoff();
      await watch.check();
      expect(h.domain.inbox.list('AR', { state: 'open', kind: 'question' })).toEqual([]);
    },
  );

  it('resolves an open alert only after confirmed recovery, including a manual check', async () => {
    await watch.check();
    const item = legacyAlert();
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
    expect(watch.activeIds('AR')!.size).toBe(0);
    expect(retry).not.toHaveBeenCalled();
  });

  it('warns for a disconnected remote engine without probing its provider, then resolves it', async () => {
    engineId = remote;
    online = false;
    const task = await h.domain.tasks.create('AR', { title: 'Offline work' }, OWNER_ACTOR);
    keep(task, 'engine_offline');
    await watch.check();
    expect(probe).not.toHaveBeenCalled();
    expect(raised()[0]).toMatchObject({
      title: 'Engine "Mac mini" is not connected',
      payload: {
        tasks: [task.key],
        outage: { kind: 'engine', engine: { id: remote, name: 'Mac mini' } },
      },
    });
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    const release = vi.spyOn(h.domain.messageRouter, 'releaseForEngine');
    await watch.recheck({ kind: 'engine', engineId: remote });
    expect(watch.activeIds('AR')!.size).toBe(0);
    expect(release).toHaveBeenCalledWith(remote);
    expect(probe).not.toHaveBeenCalled();
  });

  it('allows a remote engine to reconnect after startup before opening an alert', async () => {
    engineId = remote;
    online = false;
    vi.mocked(h.domain.ctx.now).mockReturnValue(startedAt);
    await h.domain.outages.check();
    await h.domain.outages.observeRefusal('AR', 'dev-1', 'engine_offline');
    expect(raised()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
    vi.mocked(h.domain.ctx.now).mockReturnValue(new Date(startedAt.getTime() + ENGINE_OFFLINE_AFTER_MS));
    await h.domain.outages.check();
    expect(raised()).toHaveLength(1);
    expect(raised()[0]!.payload.outage).toMatchObject({ kind: 'engine', engine: { id: remote } });
  });

  it('preserves adopted engine alerts during startup grace and manual checks', async () => {
    engineId = remote;
    online = false;
    await watch.check();
    const item = legacyAlert();
    vi.mocked(h.domain.ctx.now).mockReturnValue(startedAt);
    await watch.stop();
    watch = new WorkOutages({
      ctx: h.domain.ctx,
      projects: h.domain.projects,
      inbox: h.domain.inbox,
      engines: directory,
      runner: h.runner,
      deferred,
      messageRouter: h.domain.messageRouter,
      members: h.domain.members,
      tasks: h.domain.tasks,
      retry,
    });
    const result = await watch.checkNow('AR', item.id, access());
    expect(result).toMatchObject({ stillFailing: true, item: { state: 'open' } });
    expect(result.item.payload.outage).toEqual(item.payload.outage);
  });

  it('releases waiting work on reconnect even when outage publication fails', async () => {
    engineId = remote;
    online = false;
    await watch.check();
    online = true;
    const release = vi.spyOn(h.domain.messageRouter, 'releaseForEngine').mockResolvedValue(undefined);
    vi.spyOn(h.domain.members, 'publishMembers').mockRejectedValueOnce(new Error('Publication failed'));
    await expect(watch.engineChanged(remote, true)).rejects.toThrow('Publication failed');
    expect(release).toHaveBeenCalledWith(remote);
    expect(retry).toHaveBeenCalledOnce();
  });

  it('detects disconnection during startup grace once the engine has connected', async () => {
    engineId = remote;
    vi.mocked(h.domain.ctx.now).mockReturnValue(startedAt);
    probe.mockImplementation(async (provider) => status(provider, true));
    await watch.check();
    online = false;
    await watch.check();
    expect(raised()).toHaveLength(1);
    expect(raised()[0]!.payload.outage).toMatchObject({ kind: 'engine' });
  });

  it('carries remote provider identity and preserves its failure during an engine disconnect', async () => {
    engineId = remote;
    await watch.check();
    const { outage } = raised()[0]!.payload;
    expect(outage).toMatchObject({ kind: 'provider', engine: { id: remote, name: 'Mac mini' } });
    online = false;
    await watch.check();
    expect(watch.factsOf('AR', outage.id)).not.toBeNull();
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    expect(watch.factsOf('AR', outage.id)).not.toBeNull();
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
    expect(h.domain.messageRouter.pendingTaskKeys('AR', 'dev-1')).toEqual([task.key]);
    await watch.check();
    expect(raised()[0]!.payload.tasks).toEqual([task.key]);
    expect(watch.forTask(task)).toMatchObject({ kind: 'engine', engine: { id: remote } });
    expect(deferred.list()).toEqual([]);
  });

  describe('waiting-message keys across a task list', () => {
    async function waitingCards() {
      engineId = remote;
      online = false;
      const tasks: Task[] = [];
      for (let index = 0; index < 5; index++)
        tasks.push(await h.domain.tasks.create('AR', { title: `Card ${index}` }, OWNER_ACTOR));
      for (const task of tasks.slice(0, 2))
        await h.domain.messaging.send('AR', 'owner', { to: ['dev-1'], taskKey: task.key, text: 'Read this' });
      await watch.check();
      return tasks;
    }
    /** What a task list does: ask every card, with other work awaited between the cards. */
    async function markAll(tasks: Task[]) {
      const marked: boolean[] = [];
      for (const task of tasks) {
        marked.push(watch.forTask(task)?.kind === 'engine');
        await flush();
      }
      return marked;
    }

    it('reads each outage member once per window, across awaited card work', async () => {
      const tasks = await waitingCards();
      const read = vi.spyOn(h.domain.messageRouter, 'pendingTaskKeys');
      expect(await markAll(tasks)).toEqual([true, true, false, false, false]);
      const members = read.mock.calls.map(([project, handle]) => `${project}:${handle}`);
      expect(members.length).toBeGreaterThan(0);
      expect(new Set(members).size).toBe(members.length);
      await markAll(tasks);
      expect(read).toHaveBeenCalledTimes(members.length);
    });

    it('keeps an empty result for the window and refreshes after it', async () => {
      engineId = remote;
      online = false;
      const [first, second] = [
        await h.domain.tasks.create('AR', { title: 'First' }, OWNER_ACTOR),
        await h.domain.tasks.create('AR', { title: 'Second' }, OWNER_ACTOR),
      ];
      await watch.check();
      const read = vi.spyOn(h.domain.messageRouter, 'pendingTaskKeys');
      expect(await markAll([first!, second!])).toEqual([false, false]);
      const reads = read.mock.calls.length;
      const members = read.mock.calls.map(([project, handle]) => `${project}:${handle}`);
      expect(reads).toBeGreaterThan(0);
      expect(new Set(members).size).toBe(reads);

      await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-1'],
        taskKey: first!.key,
        text: 'Now waiting',
      });
      expect(watch.forTask(first!)).toBeUndefined();
      expect(read).toHaveBeenCalledTimes(reads);

      const now = h.domain.ctx.now().getTime();
      vi.mocked(h.domain.ctx.now).mockReturnValue(new Date(now + 1_999));
      expect(watch.forTask(first!)).toBeUndefined();
      vi.mocked(h.domain.ctx.now).mockReturnValue(new Date(now + 2_000));
      expect(watch.forTask(first!)).toMatchObject({ kind: 'engine' });
      expect(watch.forTask(second!)).toBeUndefined();
    });

    it('does not mark a card once its message is delivered and the window has passed', async () => {
      const tasks = await waitingCards();
      expect(watch.forTask(tasks[0]!)).toMatchObject({ kind: 'engine' });
      online = true;
      probe.mockImplementation(async (provider) => status(provider, null));
      await watch.check();
      vi.mocked(h.domain.ctx.now).mockReturnValue(new Date(h.domain.ctx.now().getTime() + 2_000));
      expect(watch.forTask(tasks[0]!)).toBeUndefined();
    });
  });

  it('reacts to engine connection events through the domain hook', async () => {
    engineId = remote;
    online = false;
    for (const listener of engineListeners) listener(remote, false);
    await vi.waitFor(() => expect(raised()).toHaveLength(1));
    expect(raised()[0]!.payload.outage).toMatchObject({ kind: 'engine' });
    online = true;
    probe.mockImplementation(async (provider) => status(provider, null));
    for (const listener of engineListeners) listener(remote, true);
    await vi.waitFor(() => expect(h.domain.outages.activeIds('AR')!.size).toBe(0));
  });

  it('rechecks auth errors on the session engine and retains version diagnostics', async () => {
    engineId = remote;
    probe.mockImplementation(async (provider) => ({
      ...status(provider, false, 'cli_too_old'),
      cliVersion: '1.0.0',
      minCliVersion: '2.0.0',
    }));
    await watch.observeAuthError('AR', 'dev-1', 'claude', remote);
    expect(probe).toHaveBeenCalledWith('claude', { engineId: remote, refresh: true });
    expect(raised()[0]!.payload.outage).toMatchObject({
      problem: 'cli_too_old',
      cliVersion: '1.0.0',
      minCliVersion: '2.0.0',
    });
  });

  it('recovers a no-engine warning when a connected engine is chosen', async () => {
    engineId = null;
    await watch.check();
    expect(raised()[0]!.title).toBe('No engine is connected');
    engineId = remote;
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.recheck({ kind: 'engine', engineId: remote });
    expect(watch.activeIds('AR')!.size).toBe(0);
  });

  it('opens setup failures even when login works and resolves them when the deferral ends', async () => {
    await useProvider('dev-1', 'codex');
    probe.mockImplementation(async (provider) => status(provider, true));
    const task = await h.domain.tasks.create('AR', { title: 'Sandbox setup' }, OWNER_ACTOR);
    keep(task, 'codex_setup_incomplete');
    await watch.observeRefusal('AR', 'dev-1', 'codex_setup_incomplete', { problem: 'sandbox_config' });
    const { outage } = raised()[0]!.payload;
    expect(outage).toMatchObject({ provider: 'codex', problem: 'setup_incomplete' });
    await watch.check();
    expect(watch.factsOf('AR', outage.id)).not.toBeNull();
    probe.mockImplementation(async (provider) => status(provider, false));
    await watch.check();
    probe.mockImplementation(async (provider) => status(provider, true));
    waitOutBackoff();
    await watch.check();
    expect(watch.factsOf('AR', outage.id)?.outage).toMatchObject({ problem: 'setup_incomplete' });
    deferred.drop(task.key);
    probe.mockImplementation(async (provider) => status(provider, null));
    await watch.check();
    expect(watch.factsOf('AR', outage.id)).toBeNull();
  });

  it('retries a recovered member while another launcher login still fails', async () => {
    await useProvider('dev-2', 'codex');
    await watch.check();
    probe.mockImplementation(async (provider) => status(provider, provider === 'claude'));
    waitOutBackoff();
    await watch.check();
    expect(watch.forMember('AR', 'dev-1')).toBeUndefined();
    expect(watch.forMember('AR', 'dev-2')).toBeDefined();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('shares the episode start across projects and resolves their warnings with one retry', async () => {
    await h.domain.projects.create(
      { key: 'BR', name: 'Other project', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    await watch.check();
    const first = raised().find(({ projectKey }) => projectKey === 'AR')!;
    const second = raised().find(({ projectKey }) => projectKey === 'BR')!;
    expect(second.payload.outage).toEqual(first.payload.outage);
    probe.mockImplementation(async (provider) => status(provider, true));
    waitOutBackoff();
    await watch.check();
    expect(watch.activeIds('BR')!.size).toBe(0);
    expect(watch.activeIds('AR')!.size).toBe(0);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('checks permissions and the alert kind before any probe', async () => {
    await watch.check();
    const item = legacyAlert();
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
      expect(raised()).toEqual([]);
      // Every member here uses Claude on the local engine: one question for the pair.
      expect(probe.mock.calls.length).toBe(1);
    },
  );

  it.each(['legacy', 'integrator'] as const)(
    'adopts an open %s outage after restart and preserves it on unknown checks',
    async (kind) => {
      if (kind === 'integrator') {
        await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
          const pm = config.team.members.find((member) => member.handle === 'pm');
          if (pm?.kind === 'ai') pm.onLeave = false;
          return 'Activate the project manager';
        });
      }
      await watch.check();
      const item =
        kind === 'legacy'
          ? legacyAlert()
          : h.domain.inbox.list('AR', { state: 'open', kind: 'question' })[0]!;
      const since = raised()[0]!.payload.outage.since;
      await watch.stop();
      watch = new WorkOutages({
        ctx: h.domain.ctx,
        projects: h.domain.projects,
        inbox: h.domain.inbox,
        engines: directory,
        runner: h.runner,
        deferred,
        messageRouter: h.domain.messageRouter,
        members: h.domain.members,
        tasks: h.domain.tasks,
        retry,
      });
      probe.mockImplementation(async (provider) => status(provider, null));
      await watch.check();
      expect(h.domain.inbox.get('AR', item.id).state).toBe('open');
      expect(watch.forMember('AR', 'dev-1')?.since).toBe(since);
      expect(raised()).toHaveLength(1);
      probe.mockImplementation(async (provider) => status(provider, true));
      await watch.check();
      expect(h.domain.inbox.get('AR', item.id)).toMatchObject({
        state: 'resolved',
        resolution: { rule: 'outage_ended' },
      });
    },
  );

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
