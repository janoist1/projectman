import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@projectman/shared';
import { describeTaskWait, taskWaitShort } from '../src/agent-text';
import { createDomainContext } from '../src/core/base';
import { StartRound } from '../src/runtime/admission';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe('intentional ready waits', () => {
  let h: DomainHarness;
  let time = new Date('2026-10-18T10:00:00Z');
  afterEach(() => h?.cleanup());
  const roomy = (config: ProjectConfig) => {
    config.team.limits.maxConcurrentAi = 20;
  };
  const create = async (senior = false) =>
    h.domain.tasks.create(
      'AR',
      {
        title: 'Ready card',
        ...(senior ? { complexity: { points: 8 as const, reason: 'Runner' } } : {}),
      },
      OWNER_ACTOR,
    );
  const settle = () => h.domain.admission.retryDeferred();
  const hold = (key: string) => h.domain.tasks.get('AR', key).readyHold;

  it('shares concurrent rounds and ignores holds outside the active source queue', async () => {
    h = await createDomainHarness({ adjust: roomy });
    const card = await create();
    const config = await h.domain.projects.config('AR');
    config.team.limits.aiEnabled = false;
    let release!: (config: ProjectConfig) => void;
    const pending = new Promise<ProjectConfig>((resolve) => {
      release = resolve;
    });
    const projects = { config: vi.fn(() => pending) };
    const round = new StartRound({
      ctx: createDomainContext({
        repos: h.repos,
        logger: h.log.logger,
        now: () => time,
        bus: { publish: () => {}, subscribe: () => () => {} },
      }),
      projects,
      tasks: h.domain.tasks,
      focus: h.domain.projectFocus,
      seniorWaits: h.domain.seniorWaits,
      admission: h.domain.admission,
      messaging: h.domain.messaging,
      waits: h.domain.taskWaits,
    });
    expect(round.holdOf(card)).toBeUndefined();
    const first = round.run();
    expect(round.run()).toBe(first);
    release(config);
    await first;
    expect(projects.config).toHaveBeenCalledTimes(1);
    expect(round.holdOf(card)).toMatchObject({ reason: 'ai_disabled' });
    expect(round.holdOf({ ...card, status: 'done' })).toBeUndefined();
    expect(round.holdOf({ ...card, stageId: 'development' })).toBeUndefined();
    config.team.limits.aiEnabled = true;
    await round.run();
    expect(round.holdOf(card)).toBeUndefined();
  });

  it.each(['ai_disabled', 'team_paused', 'ai_limit_reached', 'no_free_member', 'engine_offline'] as const)(
    'shows the project frame %s without reading queue cards',
    async (reason) => {
      h = await createDomainHarness({
        adjust: (config) => {
          roomy(config);
          if (reason === 'ai_disabled') config.team.limits.aiEnabled = false;
          if (reason === 'ai_limit_reached') config.team.limits.maxConcurrentAi = 1;
          if (reason === 'no_free_member')
            for (const member of config.team.members)
              if (member.kind === 'ai' && member.role === 'developer') member.onLeave = true;
        },
      });
      if (reason === 'team_paused')
        await h.domain.pauses.pause(
          { scope: 'project', projectKey: 'AR' },
          { userId: null, source: 'system' },
        );
      if (reason === 'ai_limit_reached') vi.spyOn(h.domain.sessions, 'busyCount').mockReturnValue(1);
      const card = await create();
      if (reason === 'engine_offline')
        vi.spyOn(h.domain.admission, 'engineOffline').mockReturnValue({ engine: 'eng_missing' });
      const read = vi.spyOn(h.domain.tasks, 'readSchedulingTasks');
      await settle();
      expect(hold(card.key)).toMatchObject({ reason });
      if (reason === 'engine_offline') expect(hold(card.key)?.engine).toBe('eng_missing');
      expect(read.mock.calls.filter(([, query]) => query.kind === 'queue')).toEqual([]);
      expect(h.runner.started).toHaveLength(0);
      const wait = h.domain.taskWaits.ofCard(
        await h.domain.projects.config('AR'),
        h.domain.tasks.get('AR', card.key),
      );
      expect(wait).toMatchObject({ reason: 'ready', hold: { reason } });
      expect(taskWaitShort(wait!)).toBe(`ready, waits (${reason})`);
      expect(describeTaskWait(wait!)).toContain(`waits on purpose (${reason})`);
      expect(h.repos.tasks.get(card.key)).not.toHaveProperty('readyHold');
    },
  );

  it('keeps the timestamp while the reason holds and resets it after release', async () => {
    time = new Date('2026-10-18T10:00:00Z');
    h = await createDomainHarness({ adjust: roomy, now: () => time });
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    const card = await create();
    await settle();
    const since = hold(card.key)!.since;
    time = new Date('2026-10-18T10:05:00Z');
    await settle();
    expect(hold(card.key)!.since).toBe(since);
    await h.domain.pauses.resume({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    await settle();
    expect(hold(card.key)).toBeUndefined();
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    await settle();
    expect(hold(card.key)!.since).toBe(time.toISOString());
  });

  it('shows waits for a stronger developer and reserves a free developer for the earlier card', async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        roomy(config);
        const senior = config.team.members.find((member) => member.handle === 'dev-2');
        if (senior?.kind === 'ai') {
          senior.complexityLimit = 13;
          senior.onLeave = true;
        }
      },
    });
    const senior = await create(true);
    const first = await create();
    const second = await create();
    await h.domain.tasks.update('AR', first.key, { priority: 'high' }, OWNER_ACTOR);
    await settle();
    expect(hold(senior.key)).toMatchObject({ reason: 'senior_busy', seniors: ['dev-2'] });
    expect(hold(first.key)).toBeUndefined();
    expect(hold(second.key)).toMatchObject({ reason: 'focus_order' });
    expect(h.runner.started).toHaveLength(0);
    await h.domain.tasks.cancel('AR', second.key, { reason: 'Scope changed' }, OWNER_ACTOR);
    expect(hold(second.key)).toBeUndefined();
  });
});
