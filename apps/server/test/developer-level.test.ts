import { AiMemberConfig, type Actor, type Task } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor, humanActor } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-347: the recommended developer of a card and the Senior mark of an AI member: who may set
 * them, the reason a Senior card needs, the timeline and the domain event, and the storage.
 */
let h: DomainHarness;
const ARCHITECT: Actor = aiActor('arch');
const DEV: Actor = aiActor('dev-1');
const DEVELOPER_HUMAN = humanActor('dev-human');

beforeEach(async () => {
  h = await createDomainHarness({
    adjust: (config) => {
      config.team.members.push(
        { kind: 'human', handle: 'dev-human', displayName: 'Developer', access: 'developer', roles: [] },
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
const levelEvents = (key: string) =>
  h.domain.timeline.list('AR', { taskKey: key }).filter((event) => event.type === 'task_level_changed');
const setLevel = (key: string, level: 'senior' | 'any', reason?: string | null, actor: Actor = ARCHITECT) =>
  h.domain.tasks.update('AR', key, { developerLevel: { level, reason } }, actor);

describe('the recommended developer of a card', () => {
  it('is absent on a new card, which counts as any', async () => {
    const task = await create();
    expect(task.developerLevel).toBeUndefined();
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toBeUndefined();
  });

  it('is set by the architect with a reason, stored with who and when, and shown on the timeline', async () => {
    const task = await create();
    const updated = await setLevel(task.key, 'senior', '  the runner  ');
    expect(updated.developerLevel).toMatchObject({ level: 'senior', reason: 'the runner', setBy: 'arch' });
    expect(Date.parse(updated.developerLevel!.setAt)).not.toBeNaN();
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toEqual(updated.developerLevel);
    expect(levelEvents(task.key)).toHaveLength(1);
    expect(levelEvents(task.key)[0]).toMatchObject({
      actor: { kind: 'ai', handle: 'arch' },
      data: { level: 'senior', reason: 'the runner', previous: null },
    });
  });

  it('is set by the owner, and any needs no reason', async () => {
    const task = await create();
    const updated = await setLevel(task.key, 'any', 'a UI part', OWNER_ACTOR);
    expect(updated.developerLevel).toMatchObject({ level: 'any', reason: 'a UI part', setBy: 'owner' });
  });

  it('stores an explicit any on a bare card with one event, and the same again changes nothing', async () => {
    const task = await create();
    const first = await setLevel(task.key, 'any', null, OWNER_ACTOR);
    expect(first.developerLevel).toMatchObject({ level: 'any', reason: null, setBy: 'owner' });
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toEqual(first.developerLevel);
    expect(levelEvents(task.key).map((event) => event.data)).toEqual([
      { level: 'any', reason: null, previous: null },
    ]);
    const again = await setLevel(task.key, 'any', '  ', ARCHITECT);
    expect(again.developerLevel).toEqual(first.developerLevel);
    expect(levelEvents(task.key)).toHaveLength(1);
  });

  it('refuses a Senior card without a reason, whether it is missing, empty or blank', async () => {
    const task = await create();
    for (const reason of [undefined, null, '', '   '])
      await expect(setLevel(task.key, 'senior', reason)).rejects.toMatchObject({
        code: 'developer_level_reason_required',
        status: 400,
      });
    expect(levelEvents(task.key)).toHaveLength(0);
  });

  it('refuses a reason of more than 300 characters', async () => {
    const task = await create();
    await expect(setLevel(task.key, 'senior', 'x'.repeat(301))).rejects.toMatchObject({
      code: 'invalid_request',
    });
    expect((await setLevel(task.key, 'senior', 'x'.repeat(300))).developerLevel?.reason).toHaveLength(300);
  });

  it('is refused for a developer, a person without the right and a member without a planning duty', async () => {
    const task = await create();
    for (const actor of [DEV, DEVELOPER_HUMAN, aiActor('cr')])
      await expect(setLevel(task.key, 'senior', 'why', actor)).rejects.toMatchObject({
        code: 'developer_level_forbidden',
        status: 403,
      });
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toBeUndefined();
  });

  it('writes nothing and tells nobody when the level and the reason stay the same', async () => {
    const task = await create();
    const first = await setLevel(task.key, 'senior', 'the runner');
    const heard: string[] = [];
    h.domain.ctx.events.on('task_level_changed', (changed) => void heard.push(changed.task.key));
    const again = await setLevel(task.key, 'senior', ' the runner ', OWNER_ACTOR);
    await flush();
    expect(again.developerLevel).toEqual(first.developerLevel);
    expect(levelEvents(task.key)).toHaveLength(1);
    expect(heard).toEqual([]);
  });

  it('records a change with the previous level, and emits the domain event with the actor', async () => {
    const task = await create();
    const heard: Array<{ task: Task; actor: Actor }> = [];
    h.domain.ctx.events.on('task_level_changed', (changed) => void heard.push(changed));
    await setLevel(task.key, 'senior', 'the runner');
    await setLevel(task.key, 'any', null, OWNER_ACTOR);
    await flush();
    expect(levelEvents(task.key).map((event) => event.data)).toEqual([
      { level: 'senior', reason: 'the runner', previous: null },
      { level: 'any', reason: null, previous: { level: 'senior', reason: 'the runner' } },
    ]);
    expect(heard.map((item) => [item.task.developerLevel?.level, item.actor.handle])).toEqual([
      ['senior', 'arch'],
      ['any', 'owner'],
    ]);
  });

  it('changes together with the other fields of the same update', async () => {
    const task = await create();
    const updated = await h.domain.tasks.update(
      'AR',
      task.key,
      { title: 'Renamed', developerLevel: { level: 'senior', reason: 'security' } },
      OWNER_ACTOR,
    );
    expect(updated).toMatchObject({ title: 'Renamed', developerLevel: { level: 'senior' } });
    expect(levelEvents(task.key)).toHaveLength(1);
  });

  it('can be set when the card is created, by whoever may set it', async () => {
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Planned', developerLevel: { level: 'senior', reason: 'the sandbox' } },
      ARCHITECT,
    );
    expect(task.developerLevel).toMatchObject({ level: 'senior', reason: 'the sandbox', setBy: 'arch' });
    expect(levelEvents(task.key)).toHaveLength(1);
    const plain = await h.domain.tasks.create(
      'AR',
      { title: 'Plain', developerLevel: { level: 'any' } },
      ARCHITECT,
    );
    expect(plain.developerLevel).toMatchObject({ level: 'any', reason: null, setBy: 'arch' });
    expect(levelEvents(plain.key).map((event) => event.data)).toEqual([
      { level: 'any', reason: null, previous: null },
    ]);
    await expect(
      h.domain.tasks.create('AR', { title: 'Nope', developerLevel: { level: 'any' } }, DEV),
    ).rejects.toMatchObject({ code: 'developer_level_forbidden' });
    await expect(
      h.domain.tasks.create('AR', { title: 'Bare', developerLevel: { level: 'senior' } }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'developer_level_reason_required' });
  });

  it('is refused on a theme and on a closed card', async () => {
    const theme = await h.domain.tasks.create('AR', { title: 'Theme', kind: 'theme' }, OWNER_ACTOR);
    await expect(setLevel(theme.key, 'senior', 'why', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_is_theme',
    });
    await expect(
      h.domain.tasks.create(
        'AR',
        { title: 'Theme 2', kind: 'theme', developerLevel: { level: 'any' } },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
    const task = await create();
    await h.domain.tasks.cancel('AR', task.key, {}, OWNER_ACTOR);
    await expect(setLevel(task.key, 'senior', 'why', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_closed',
    });
  });

  it('can be changed on a started card without replacing its developer', async () => {
    const task = await create();
    await h.domain.tasks.update('AR', task.key, { stageId: 'development', assignee: 'dev-1' }, OWNER_ACTOR);
    const updated = await setLevel(task.key, 'senior', 'delicate concurrency');
    expect(updated).toMatchObject({ stageId: 'development', assignee: 'dev-1' });
    expect(updated.developerLevel?.level).toBe('senior');
  });

  it('reads an old card without the field and one with a broken value as having none', async () => {
    const task = await create();
    const db = h.repos.db;
    db.prepare('UPDATE tasks SET developer_level = ? WHERE key = ?').run('{not json', task.key);
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toBeUndefined();
    db.prepare('UPDATE tasks SET developer_level = ? WHERE key = ?').run('{"level":"boss"}', task.key);
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toBeUndefined();
    db.prepare('UPDATE tasks SET developer_level = NULL WHERE key = ?').run(task.key);
    expect(h.domain.tasks.get('AR', task.key).developerLevel).toBeUndefined();
  });
});

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

describe('the Senior mark of a member', () => {
  const by = () => ({ actor: OWNER_ACTOR, author: OWNER });
  const stored = async (handle: string) => {
    const member = (await h.domain.projects.config('AR')).team.members.find((m) => m.handle === handle);
    if (member?.kind !== 'ai') throw new Error('Expected an AI member');
    return member;
  };
  const view = async (handle: string) =>
    (await h.domain.members.roster('AR')).find((member) => member.handle === handle);

  it('is set and removed, and the roster shows it', async () => {
    expect(await view('dev-1')).toMatchObject({ senior: false });
    await h.domain.members.update('AR', 'dev-1', { senior: true }, by());
    expect((await stored('dev-1')).senior).toBe(true);
    expect(await view('dev-1')).toMatchObject({ senior: true });
    await h.domain.members.update('AR', 'dev-1', { senior: false }, by());
    expect(await stored('dev-1')).not.toHaveProperty('senior');
    expect(await view('dev-1')).toMatchObject({ senior: false });
  });

  it('is left alone when the field is omitted', async () => {
    await h.domain.members.update('AR', 'dev-1', { senior: true }, by());
    await h.domain.members.update('AR', 'dev-1', { displayName: 'Renamed' }, by());
    expect((await stored('dev-1')).senior).toBe(true);
  });

  it('is refused for a temp worker and for a person', async () => {
    await expect(h.domain.members.update('AR', 'tmp', { senior: true }, by())).rejects.toMatchObject({
      code: 'senior_not_allowed',
      status: 400,
    });
    await expect(h.domain.members.update('AR', 'dev-human', { senior: true }, by())).rejects.toMatchObject({
      code: 'senior_not_allowed',
    });
    expect(await stored('tmp')).not.toHaveProperty('senior');
  });
});
