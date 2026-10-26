import { AiMemberConfig, type Actor, type Task } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

/**
 * PM-1001/PM-1006/PM-1007: the complexity points of a card and the complexity limit of a developer:
 * storage, the timeline and the domain event, and the roster. (The recommended developer and the
 * Senior mark they replace are gone.)
 */
let h: DomainHarness;
const ARCHITECT: Actor = aiActor('arch');

beforeEach(async () => {
  h = await createDomainHarness({
    adjust: (config) => {
      config.team.members.push(
        AiMemberConfig.parse({
          kind: 'ai',
          handle: 'arch',
          displayName: 'Architect',
          role: 'architect',
          sponsor: 'owner',
        }),
        AiMemberConfig.parse({
          kind: 'ai',
          handle: 'tmp',
          displayName: 'Temp',
          role: 'developer',
          sponsor: 'owner',
          temp: true,
        }),
        AiMemberConfig.parse({ kind: 'ai', handle: 'qa', displayName: 'QA', role: 'qa', sponsor: 'owner' }),
      );
    },
  });
});
afterEach(() => h.cleanup());

const create = (title = 'Card', actor: Actor = OWNER_ACTOR) => h.domain.tasks.create('AR', { title }, actor);

describe('task complexity storage and events', () => {
  it('creates, changes and removes points with committed events and SQL NULL', async () => {
    const heard: Array<{ task: Task; actor: string }> = [];
    h.domain.ctx.events.on('task_complexity_changed', (event) => {
      expect(h.repos.tasks.get(event.task.key)?.complexity).toEqual(event.task.complexity);
      heard.push(event);
    });
    const task = await h.domain.tasks.create('AR', { title: 'Scored', complexity: { points: 3 } }, ARCHITECT);
    expect(h.repos.tasks.get(task.key)?.complexity).toEqual(task.complexity);
    await h.domain.tasks.update(
      'AR',
      task.key,
      { complexity: { points: 8, reason: 'two modules' } },
      OWNER_ACTOR,
    );
    const removed = await h.domain.tasks.update(
      'AR',
      task.key,
      { complexity: { points: null } },
      OWNER_ACTOR,
    );
    expect(removed).not.toHaveProperty('complexity');
    expect(h.domain.tasks.get('AR', task.key)).not.toHaveProperty('complexity');
    expect(h.repos.db.prepare('SELECT complexity FROM tasks WHERE key = ?').get(task.key)).toEqual({
      complexity: null,
    });
    expect(
      h.domain.timeline
        .list('AR', { taskKey: task.key })
        .filter((e) => e.type === 'task_complexity_changed')
        .map((e) => e.data),
    ).toEqual([
      { points: 3, reason: null, previous: null },
      { points: 8, reason: 'two modules', previous: { points: 3, reason: null } },
      { points: null, reason: null, previous: { points: 8, reason: 'two modules' } },
    ]);
    expect(heard.map((e) => [e.task.complexity?.points, e.actor])).toEqual([
      [3, 'arch'],
      [8, 'owner'],
      [undefined, 'owner'],
    ]);
  });

  it('does not emit for an unchanged score or removing absent points', async () => {
    const task = await create();
    await h.domain.tasks.update('AR', task.key, { complexity: { points: null } }, ARCHITECT);
    const first = await h.domain.tasks.update('AR', task.key, { complexity: { points: 5 } }, ARCHITECT);
    const heard: string[] = [];
    h.domain.ctx.events.on('task_complexity_changed', (e) => void heard.push(e.task.key));
    const same = await h.domain.tasks.update(
      'AR',
      task.key,
      { complexity: { points: 5, reason: ' ' } },
      OWNER_ACTOR,
    );
    expect(same.complexity).toEqual(first.complexity);
    expect(heard).toEqual([]);
    expect(
      h.domain.timeline.list('AR', { taskKey: task.key }).filter((e) => e.type === 'task_complexity_changed'),
    ).toHaveLength(1);
  });

  it('refuses scoring a theme at creation', async () => {
    await expect(
      h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme', complexity: { points: 5 } }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
  });

  it('keeps the entire update unchanged when complexity is refused', async () => {
    const task = await create();
    await expect(
      h.domain.tasks.update('AR', task.key, { title: 'Changed', complexity: { points: 4 } }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'complexity_points_invalid' });
    expect(h.repos.tasks.get(task.key)?.title).toBe(task.title);
  });

  it.each(['{broken', '{"points":4}', null])(
    'safely reads invalid or absent stored complexity: %s',
    async (value) => {
      const task = await create();
      h.repos.db.prepare('UPDATE tasks SET complexity = ? WHERE key = ?').run(value, task.key);
      expect(h.repos.tasks.get(task.key)).not.toHaveProperty('complexity');
    },
  );
});

describe('member complexity limit', () => {
  it('persists a developer limit and clears it back to the default on the roster', async () => {
    const by = { actor: OWNER_ACTOR, author: OWNER };
    expect((await h.domain.members.update('AR', 'dev-1', { complexityLimit: 13 }, by)).complexityLimit).toBe(
      13,
    );
    const config = await h.domain.projects.config('AR');
    expect(config.team.members.find((m) => m.handle === 'dev-1')).toHaveProperty('complexityLimit', 13);
    expect(
      (await h.domain.members.update('AR', 'dev-1', { complexityLimit: null }, by)).complexityLimit,
    ).toBe(5);
    expect(
      (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === 'dev-1'),
    ).not.toHaveProperty('complexityLimit');
  });

  it.each(['qa', 'tmp', 'owner'])('refuses a limit for %s', async (handle) => {
    const draft = structuredClone(await h.domain.projects.config('AR'));
    expect(() => h.domain.members.prepareUpdate(draft, handle, { complexityLimit: 8 })).toThrowError(
      expect.objectContaining({ code: 'complexity_limit_not_developer' }),
    );
  });

  it('validates the scale in the domain', async () => {
    const draft = structuredClone(await h.domain.projects.config('AR'));
    expect(() => h.domain.members.prepareUpdate(draft, 'dev-1', { complexityLimit: 4 as 5 })).toThrowError(
      expect.objectContaining({ code: 'complexity_points_invalid' }),
    );
  });

  it('uses the updated role when deciding developer eligibility', async () => {
    const draft = structuredClone(await h.domain.projects.config('AR'));
    h.domain.members.prepareUpdate(draft, 'qa', { role: 'developer', complexityLimit: 8 });
    expect(draft.team.members.find((m) => m.handle === 'qa')).toHaveProperty('complexityLimit', 8);
    expect(() =>
      h.domain.members.prepareUpdate(draft, 'qa', { role: 'qa', complexityLimit: 3 }),
    ).toThrowError(expect.objectContaining({ code: 'complexity_limit_not_developer' }));
  });

  it('shows limits only for developers, with a fixed default for temporary developers', async () => {
    const draft = structuredClone(await h.domain.projects.config('AR'));
    const temp = draft.team.members.find((m) => m.handle === 'tmp');
    if (temp?.kind === 'ai') temp.complexityLimit = 13;
    const roster = h.domain.members.rosterFor(draft);
    expect(roster.find((m) => m.handle === 'tmp')?.complexityLimit).toBe(5);
    for (const handle of ['owner', 'qa'])
      expect(roster.find((m) => m.handle === handle)).not.toHaveProperty('complexityLimit');
  });
});
