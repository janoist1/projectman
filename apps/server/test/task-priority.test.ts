import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

describe('card priority', () => {
  let h: DomainHarness;
  beforeEach(async () => {
    h = await createDomainHarness();
    await h.domain.tasks.create('AR', { title: 'Checkout', repo: 'web' }, OWNER_ACTOR);
  });
  afterEach(() => h.cleanup());

  it('records set and clear, ignores unchanged values, broadcasts and preserves manual rank', async () => {
    const before = h.domain.tasks.get('AR', 'AR-1');
    expect(before.priority).toBeNull();
    const events: unknown[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    const set = await h.domain.tasks.update('AR', 'AR-1', { priority: 'high' }, OWNER_ACTOR);
    await h.domain.tasks.update('AR', 'AR-1', { priority: 'high' }, OWNER_ACTOR);
    const cleared = await h.domain.tasks.update('AR', 'AR-1', { priority: null }, OWNER_ACTOR);
    expect([set.boardRank, cleared.boardRank]).toEqual([before.boardRank, before.boardRank]);
    expect(events).toContainEqual({ type: 'task_upserted', projectKey: 'AR', task: set });
    const changes = h.domain.tasks
      .detail('AR', 'AR-1')
      .timeline.filter((event) => event.type === 'task_updated');
    expect(changes.map((event) => event.data)).toEqual([
      { fields: ['priority'], priority: 'high', previousPriority: null },
      { fields: ['priority'], priority: null, previousPriority: 'high' },
    ]);
    expect(changes.every((event) => event.actor.kind === 'human')).toBe(true);
  });

  it('refuses AI and system writes atomically, even when the value stays null', async () => {
    for (const actor of [aiActor('dev-1'), { kind: 'system' as const, handle: null }]) {
      await expect(
        h.domain.tasks.update('AR', 'AR-1', { priority: null, title: 'Changed' }, actor),
      ).rejects.toMatchObject({ status: 403, code: 'priority_humans_only' });
    }
    expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ title: 'Checkout', priority: null });
  });

  it('refuses priority on a theme', async () => {
    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    await expect(
      h.domain.tasks.update('AR', theme.key, { priority: 'urgent' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
  });

  it('allows a change during a live session and on closed cards', async () => {
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' });
    expect(await h.domain.tasks.update('AR', 'AR-1', { priority: 'urgent' }, OWNER_ACTOR)).toMatchObject({
      priority: 'urgent',
    });
    const task = h.domain.tasks.get('AR', 'AR-1');
    h.repos.tasks.update(task.id, { status: 'done' });
    expect(await h.domain.tasks.update('AR', 'AR-1', { priority: 'low' }, OWNER_ACTOR)).toMatchObject({
      priority: 'low',
      status: 'done',
      boardRank: task.boardRank,
    });
  });
});
