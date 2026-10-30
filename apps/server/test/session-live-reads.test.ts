import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { statementCount } from '../src/db';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe('the live session reads (PM-1120)', () => {
  let h: DomainHarness;
  let now: Date;
  beforeEach(async () => {
    now = new Date('2026-10-20T08:00:00.000Z');
    h = await createDomainHarness({ now: () => now });
  });
  afterEach(async () => {
    await h.cleanup();
  });

  async function liveSession() {
    const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
    h.repos.tasks.update(card.id, { stageId: 'development', status: 'active', assignee: 'dev-1' });
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', {
      type: 'task',
      taskKey: card.key,
    });
    return { card, session };
  }

  /** Closed sessions of the same member on other cards: history that must not matter to a live read. */
  function addHistory(template: ReturnType<typeof h.repos.sessions.get>, count: number) {
    for (let i = 0; i < count; i++)
      h.repos.sessions.insert({
        ...template!,
        id: `ses_old_${i}`,
        state: 'exited',
        startedAt: new Date(now.getTime() - (i + 2) * 60_000).toISOString(),
        endedAt: new Date(now.getTime() - (i + 1) * 60_000).toISOString(),
        workItem: { type: 'task', taskKey: `AR-${1000 + i}` },
      });
  }

  it('lists only the live sessions, the members once and the latest activity per card and member', async () => {
    const { card, session } = await liveSession();
    addHistory(h.repos.sessions.get(session.id), 5);
    expect(h.repos.sessions.listLive('AR').map((s) => s.id)).toEqual([session.id]);
    expect(h.repos.sessions.listLive('AR', 'dev-2')).toEqual([]);
    expect(h.repos.sessions.members('AR')).toEqual(['dev-1']);
    const activity = h.repos.sessions.taskActivity('AR');
    expect(activity).toHaveLength(6);
    expect(activity.find((row) => row.taskKey === card.key)).toMatchObject({
      member: 'dev-1',
      endedAt: null,
    });
  });

  it('gives the same capacity holders and member load however many closed sessions there are', async () => {
    const { session } = await liveSession();
    const config = h.domain.projects.cachedConfig('AR')!;
    const before = {
      holders: h.domain.admission.holders(config, 'dev-1'),
      load: h.domain.admission.memberLoad(config, 'dev-1'),
    };
    addHistory(h.repos.sessions.get(session.id), 40);
    expect(h.domain.admission.holders(config, 'dev-1')).toEqual(before.holders);
    expect(h.domain.admission.memberLoad(config, 'dev-1')).toBe(before.load);
  });

  it('runs the same number of statements for a runner state event with or without history', async () => {
    const { session } = await liveSession();
    const event = async (state: 'working' | 'idle') => {
      const from = statementCount();
      h.runner.setState(session.id, state);
      await Promise.resolve();
      return statementCount() - from;
    };
    await event('working');
    const without = await event('idle');
    addHistory(h.repos.sessions.get(session.id), 40);
    await event('working');
    expect(await event('idle')).toBe(without);
  });
});
