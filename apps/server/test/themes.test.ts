import type { Actor, ServerEvent, Task } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor, humanActor } from '../src/domain';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-205: the theme card kind. A theme has a key, a title, a description and a timeline, but no stage
 * to move through, no assignee, no work and no session: it is open or closed. Any card that is not a
 * theme belongs to at most one; a subtask reads its parent's.
 *
 * AR-1 and AR-2 are themes. AR-3 is a collecting card with the subtask AR-4; AR-5 and AR-6 are plain
 * cards.
 */
let h: DomainHarness;
const DEVELOPER = humanActor('dev-human');
const AI: Actor = aiActor('dev-1');

beforeEach(async () => {
  h = await createDomainHarness({
    adjust: (config) => {
      config.team.members.push({
        kind: 'human',
        handle: 'dev-human',
        displayName: 'Developer',
        access: 'developer',
        roles: [],
      });
    },
  });
  await h.domain.tasks.create('AR', { title: 'Epic one', kind: 'theme' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Epic two', kind: 'theme' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Collecting card' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Subtask', parentKey: 'AR-3' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Plain five' }, OWNER_ACTOR);
  await h.domain.tasks.create('AR', { title: 'Plain six' }, OWNER_ACTOR);
});
afterEach(async () => {
  await h.domain.stop();
  await h.cleanup();
});

const get = (key: string) => h.domain.tasks.get('AR', key);
const update = (
  key: string,
  change: Parameters<typeof h.domain.tasks.update>[2],
  actor: Actor = OWNER_ACTOR,
) => h.domain.tasks.update('AR', key, change, actor);
const setTheme = (key: string, themeKey: string | null, actor: Actor = OWNER_ACTOR) =>
  update(key, { themeKey }, actor);
const themeEvents = (key: string) =>
  h.domain.timeline
    .list('AR', { taskKey: key })
    .filter((event) => event.type === 'task_theme_changed')
    .map((event) => `${String(event.data.previous)} -> ${String(event.data.themeKey)}`);
/** What a refused call leaves: every card and the length of every timeline. */
const snapshot = () => ({
  tasks: h.domain.tasks.list('AR').map((task) => ({ ...task, startWaiting: undefined })),
  timeline: h.domain.timeline.list('AR').length,
});
/** The error code a synchronous call refuses with. */
const codeOf = (call: () => unknown): unknown => {
  try {
    call();
  } catch (err) {
    return (err as { code?: unknown }).code;
  }
  return undefined;
};

describe('creating a theme', () => {
  it('is a card of its own kind in the first stage, open, with nobody on it', () => {
    const theme = get('AR-1');
    expect(theme).toMatchObject({
      kind: 'theme',
      title: 'Epic one',
      stageId: 'backlog',
      status: 'active',
      assignee: null,
      repo: null,
    });
    expect(theme.themeKey).toBeUndefined();
    expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' }).map((e) => e.type)).toEqual(['task_created']);
    // Any other card is a task, which a client that does not know kinds reads as before.
    expect(get('AR-5').kind).toBeUndefined();
  });

  it('is created by an AI member too, with a description', async () => {
    const theme = await h.domain.tasks.create(
      'AR',
      { title: 'Epic three', kind: 'theme', description: 'What it is for.' },
      AI,
    );
    expect(theme).toMatchObject({ kind: 'theme', description: 'What it is for.', createdBy: 'dev-1' });
  });

  it('takes no stage, repository, theme or parent of its own', async () => {
    const before = snapshot();
    for (const extra of [{ stageId: 'development' }, { stageId: 'backlog' }, { repo: 'web' }])
      await expect(
        h.domain.tasks.create('AR', { title: 'Bad', kind: 'theme', ...extra }, OWNER_ACTOR),
      ).rejects.toMatchObject({ code: 'task_is_theme' });
    await expect(
      h.domain.tasks.create('AR', { title: 'Bad', kind: 'theme', themeKey: 'AR-1' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'theme_on_theme' });
    await expect(
      h.domain.tasks.create('AR', { title: 'Bad', kind: 'theme', parentKey: 'AR-3' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'subtask_theme' });
    expect(snapshot()).toEqual(before);
  });

  it('has relations to related cards and duplicates of themes only', async () => {
    const created = await h.domain.tasks.create(
      'AR',
      { title: 'Epic three', kind: 'theme', relations: [{ kind: 'related', key: 'AR-5' }] },
      OWNER_ACTOR,
    );
    expect(h.domain.tasks.relationsOf('AR', created.key).map((r) => `${r.kind} ${r.key}`)).toEqual([
      'related AR-5',
    ]);
    await expect(
      h.domain.tasks.create(
        'AR',
        { title: 'Epic four', kind: 'theme', relations: [{ kind: 'prerequisite', key: 'AR-5' }] },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'relation_theme' });
  });
});

describe('a theme stays out of the pipeline', () => {
  it('does not move, by update or by moving', async () => {
    const before = snapshot();
    await expect(update('AR-1', { stageId: 'development' })).rejects.toMatchObject({ code: 'task_is_theme' });
    await expect(update('AR-1', { stageId: 'code_review' })).rejects.toMatchObject({
      code: 'task_is_theme',
    });
    await expect(h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_is_theme',
    });
    await expect(h.domain.tasks.moveToStage('AR', 'AR-1', 'backlog', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_is_theme',
    });
    expect(snapshot()).toEqual(before);
    // Leaving the stage it carries as it is, in a call that changes something else, is no move.
    await update('AR-1', { stageId: 'backlog', description: 'Written.' });
    expect(get('AR-1').description).toBe('Written.');
  });

  it('does not start: no assignee, no session, no worktree', async () => {
    const before = snapshot();
    await expect(
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER }),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
    await expect(
      h.domain.taskStarts.start('AR', 'AR-1', { actor: OWNER_ACTOR, author: OWNER, assignee: 'dev-1' }),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
    expect(h.runner.started).toEqual([]);
    expect(h.domain.sessions.list('AR', { taskKey: 'AR-1' })).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('has no session, whoever asks for one', async () => {
    await expect(
      h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }),
    ).rejects.toMatchObject({ code: 'task_is_theme' });
    expect(h.runner.started).toEqual([]);
    expect(h.domain.sessions.list('AR', { taskKey: 'AR-1' })).toEqual([]);
  });

  it('has no assignee and no repository, but clearing them is no change', async () => {
    const before = snapshot();
    await expect(update('AR-1', { assignee: 'dev-1' })).rejects.toMatchObject({ code: 'task_is_theme' });
    await expect(update('AR-1', { repo: 'web' })).rejects.toMatchObject({ code: 'task_is_theme' });
    expect(codeOf(() => h.domain.tasks.assign('AR', 'AR-1', 'dev-1', OWNER_ACTOR))).toBe('task_is_theme');
    expect(snapshot()).toEqual(before);
    await update('AR-1', { assignee: null, repo: null });
    expect(snapshot()).toEqual(before);
  });

  it('is closed with close, not cancelled', async () => {
    await expect(h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_is_theme',
    });
    expect(get('AR-1').status).toBe('active');
  });

  it('is neither the parent nor the part of a card, by parentKey or by relation', async () => {
    const before = snapshot();
    await expect(update('AR-5', { parentKey: 'AR-1' })).rejects.toMatchObject({ code: 'subtask_theme' });
    await expect(update('AR-1', { parentKey: 'AR-5' })).rejects.toMatchObject({ code: 'subtask_theme' });
    await expect(
      update('AR-5', { relations: { add: [{ kind: 'part_of', key: 'AR-1' }] } }),
    ).rejects.toMatchObject({ code: 'subtask_theme' });
    await expect(
      update('AR-1', { relations: { add: [{ kind: 'part_of', key: 'AR-5' }] } }),
    ).rejects.toMatchObject({ code: 'subtask_theme' });
    await expect(
      h.domain.tasks.create('AR', { title: 'Child', parentKey: 'AR-1' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'subtask_theme' });
    expect(snapshot()).toEqual(before);
  });

  it('has no prerequisite in either direction', async () => {
    const before = snapshot();
    await expect(
      update('AR-1', { relations: { add: [{ kind: 'prerequisite', key: 'AR-5' }] } }),
    ).rejects.toMatchObject({ code: 'relation_theme' });
    await expect(
      update('AR-5', { relations: { add: [{ kind: 'prerequisite', key: 'AR-1' }] } }),
    ).rejects.toMatchObject({ code: 'relation_theme' });
    expect(snapshot()).toEqual(before);
  });

  it('is related to any card, and a duplicate of a theme only', async () => {
    await update('AR-1', { relations: { add: [{ kind: 'related', key: 'AR-5' }] } });
    await update('AR-6', { relations: { add: [{ kind: 'related', key: 'AR-2' }] } });
    expect(h.domain.tasks.relationsOf('AR', 'AR-1').map((r) => `${r.kind} ${r.key}`)).toEqual([
      'related AR-5',
    ]);
    await expect(
      update('AR-5', { relations: { add: [{ kind: 'duplicate_of', key: 'AR-1' }] } }),
    ).rejects.toMatchObject({ code: 'relation_theme' });
    await expect(
      update('AR-1', { relations: { add: [{ kind: 'duplicate_of', key: 'AR-5' }] } }),
    ).rejects.toMatchObject({ code: 'relation_theme' });
    // A theme marked as the duplicate of a theme is closed, like a card.
    await update('AR-2', { relations: { add: [{ kind: 'duplicate_of', key: 'AR-1' }] } });
    expect(get('AR-2').status).toBe('cancelled');
    expect(h.domain.tasks.relationsOf('AR', 'AR-1').map((r) => `${r.kind} ${r.key}`)).toContain(
      'duplicated_by AR-2',
    );
  });

  it('gets its messages in the general chat of the recipient, open or closed', async () => {
    const send = async (taskKey: string) => {
      const message = await h.domain.messaging.send('AR', 'owner', {
        to: ['dev-2'],
        text: 'Fictional news.',
        taskKey,
      });
      await flush();
      return h.repos.messages.get(message.id)!;
    };
    const general = { type: 'general' } as const;

    const first = await send('AR-1');
    expect(first.receipts?.[0]).toMatchObject({ route: general });
    expect(h.domain.sessions.list('AR', { member: 'dev-2' }).map((s) => s.workItem)).toEqual([general]);
    expect(h.runner.lastStarted().initialMessage).toContain(
      '[team message from owner about AR-1]\nFictional news.',
    );

    await h.domain.tasks.closeTheme('AR', 'AR-1', OWNER_ACTOR);
    const second = await send('AR-1');
    expect(second.receipts?.[0]).toMatchObject({ route: general });
    // Never a session on the theme.
    expect(h.domain.sessions.list('AR', { taskKey: 'AR-1' })).toEqual([]);
    expect(h.repos.messages.pending('AR', 'dev-2')).toEqual([]);
  });

  it('is no work of anybody: a member is not carrying it and its stage is not occupied', async () => {
    const roster = h.domain.members.rosterFor(await h.domain.projects.config('AR'));
    expect(roster.flatMap((member) => member.currentTaskKeys)).not.toContain('AR-1');
  });
});

describe('a card in a theme', () => {
  it('is put into a theme, moved to another and taken out, each on the timelines it concerns', async () => {
    const put = await setTheme('AR-5', 'AR-1');
    expect(put.themeKey).toBe('AR-1');
    expect(get('AR-5').themeKey).toBe('AR-1');
    expect(h.domain.tasks.list('AR').find((t) => t.key === 'AR-5')!.themeKey).toBe('AR-1');
    expect(themeEvents('AR-5')).toEqual(['null -> AR-1']);
    expect(themeEvents('AR-1')).toEqual(['null -> AR-1']);

    await setTheme('AR-5', 'AR-2');
    expect(get('AR-5').themeKey).toBe('AR-2');
    expect(themeEvents('AR-5')).toEqual(['null -> AR-1', 'AR-1 -> AR-2']);
    expect(themeEvents('AR-1')).toEqual(['null -> AR-1', 'AR-1 -> AR-2']);
    expect(themeEvents('AR-2')).toEqual(['AR-1 -> AR-2']);

    const cleared = await setTheme('AR-5', null);
    expect(cleared.themeKey ?? null).toBeNull();
    expect(get('AR-5').themeKey).toBeUndefined();
    expect(themeEvents('AR-5')).toEqual(['null -> AR-1', 'AR-1 -> AR-2', 'AR-2 -> null']);
    expect(themeEvents('AR-2')).toEqual(['AR-1 -> AR-2', 'AR-2 -> null']);
  });

  it('records nothing for a theme it has already, or none when it has none', async () => {
    await setTheme('AR-5', 'AR-1');
    const before = snapshot();
    await setTheme('AR-5', 'AR-1');
    await setTheme('AR-6', null);
    expect(snapshot()).toEqual(before);
  });

  it('is put into a theme with the change of another field, all or nothing', async () => {
    await update('AR-5', { themeKey: 'AR-1', title: 'Renamed', note: 'In the epic.' });
    expect(get('AR-5')).toMatchObject({ themeKey: 'AR-1', title: 'Renamed' });
    const before = snapshot();
    await expect(update('AR-6', { themeKey: 'AR-1', title: 'Never', assignee: 'nobody' })).rejects.toThrow();
    await expect(update('AR-6', { themeKey: 'AR-9', title: 'Never' })).rejects.toMatchObject({
      code: 'theme_not_found',
    });
    expect(snapshot()).toEqual(before);
  });

  it('is put into a theme that exists, is a theme and is open', async () => {
    const before = snapshot();
    await expect(setTheme('AR-5', 'AR-99')).rejects.toMatchObject({ code: 'theme_not_found' });
    await expect(setTheme('AR-5', 'AR-6')).rejects.toMatchObject({ code: 'theme_not_a_theme' });
    expect(snapshot()).toEqual(before);

    await h.domain.tasks.closeTheme('AR', 'AR-2', OWNER_ACTOR);
    const afterClose = snapshot();
    await expect(setTheme('AR-5', 'AR-2')).rejects.toMatchObject({ code: 'theme_closed' });
    await expect(
      h.domain.tasks.create('AR', { title: 'New', themeKey: 'AR-2' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'theme_closed' });
    expect(snapshot()).toEqual(afterClose);
  });

  it('is created in a theme', async () => {
    const created = await h.domain.tasks.create('AR', { title: 'In a theme', themeKey: 'AR-1' }, OWNER_ACTOR);
    expect(created.themeKey).toBe('AR-1');
    expect(themeEvents(created.key)).toEqual(['null -> AR-1']);
    expect(themeEvents('AR-1')).toEqual(['null -> AR-1']);
  });

  it('is not a theme itself', async () => {
    await expect(setTheme('AR-1', 'AR-2')).rejects.toMatchObject({ code: 'theme_on_theme' });
    await setTheme('AR-1', null);
  });

  it('can have its theme taken out of a closed theme', async () => {
    await setTheme('AR-5', 'AR-1');
    await h.domain.tasks.closeTheme('AR', 'AR-1', OWNER_ACTOR);
    await setTheme('AR-5', null);
    expect(get('AR-5').themeKey).toBeUndefined();
  });
});

describe('subtasks and themes', () => {
  it('a subtask shows the theme of its collecting card and changes with it, with nothing written to it', async () => {
    expect(get('AR-4').themeKey).toBeUndefined();
    await setTheme('AR-3', 'AR-1');
    expect(get('AR-4').themeKey).toBe('AR-1');
    expect(h.repos.tasks.get('AR-4')!.themeKey).toBe('AR-1');
    const stored = h.repos.db.prepare('SELECT theme_key FROM tasks WHERE key = ?').get('AR-4') as {
      theme_key: string | null;
    };
    expect(stored.theme_key).toBeNull();

    await setTheme('AR-3', 'AR-2');
    expect(get('AR-4').themeKey).toBe('AR-2');
    await setTheme('AR-3', null);
    expect(get('AR-4').themeKey).toBeUndefined();
    // A subtask has no timeline entry of its own for this: the collecting card carries it.
    expect(themeEvents('AR-4')).toEqual([]);
    expect(themeEvents('AR-3')).toEqual(['null -> AR-1', 'AR-1 -> AR-2', 'AR-2 -> null']);
  });

  it('announces the subtasks and both themes when the collecting card changes theme', async () => {
    await setTheme('AR-3', 'AR-1');
    const events: ServerEvent[] = [];
    h.domain.bus.subscribe((event) => events.push(event));
    await setTheme('AR-3', 'AR-2');
    const upserted = events.flatMap((event) => (event.type === 'task_upserted' ? [event.task] : []));
    expect(upserted.map((task) => [task.key, task.themeKey])).toEqual(
      expect.arrayContaining([
        ['AR-3', 'AR-2'],
        ['AR-4', 'AR-2'],
        ['AR-1', undefined],
        ['AR-2', undefined],
      ]),
    );
  });

  it('is not given a theme of its own', async () => {
    const before = snapshot();
    await expect(setTheme('AR-4', 'AR-1')).rejects.toMatchObject({ code: 'theme_on_subtask' });
    await expect(
      h.domain.tasks.create('AR', { title: 'Child', parentKey: 'AR-3', themeKey: 'AR-1' }, OWNER_ACTOR),
    ).rejects.toMatchObject({ code: 'theme_on_subtask' });
    await expect(
      h.domain.tasks.create(
        'AR',
        { title: 'Child', themeKey: 'AR-1', relations: [{ kind: 'part_of', key: 'AR-3' }] },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'theme_on_subtask' });
    expect(snapshot()).toEqual(before);
    // Taking none away from it is no change.
    await setTheme('AR-4', null);
    expect(snapshot()).toEqual(before);
  });

  it('a subtask created under a themed card shows its theme at once', async () => {
    await setTheme('AR-3', 'AR-1');
    const child = await h.domain.tasks.create('AR', { title: 'Another', parentKey: 'AR-3' }, OWNER_ACTOR);
    expect(child.themeKey).toBe('AR-1');
    expect(get(child.key).themeKey).toBe('AR-1');
  });

  it.each([
    ['parentKey', { parentKey: 'AR-3' }],
    ['a part_of relation', { relations: { add: [{ kind: 'part_of' as const, key: 'AR-3' }] } }],
  ])('a card with a theme loses it when it becomes a subtask through %s', async (_how, change) => {
    await setTheme('AR-3', 'AR-2');
    await setTheme('AR-5', 'AR-1');

    const subtask = await update('AR-5', change);

    // From now on it shows its parent's theme; its own is gone, and the timelines say so.
    expect(subtask.themeKey).toBe('AR-2');
    expect(get('AR-5').themeKey).toBe('AR-2');
    expect(h.repos.db.prepare('SELECT theme_key FROM tasks WHERE key = ?').get('AR-5')).toEqual({
      theme_key: null,
    });
    expect(themeEvents('AR-5')).toEqual(['null -> AR-1', 'AR-1 -> null']);
    expect(themeEvents('AR-1')).toEqual(['null -> AR-1', 'AR-1 -> null']);
  });

  it('takes a card out of its theme with it when it leaves its collecting card: it has none then', async () => {
    await setTheme('AR-3', 'AR-1');
    await update('AR-4', { relations: { remove: [{ kind: 'part_of', key: 'AR-3' }] } });
    expect(get('AR-4').parentKey).toBeNull();
    expect(get('AR-4').themeKey).toBeUndefined();
    expect(get('AR-3').themeKey).toBe('AR-1');
  });

  it('can be given a theme once it leaves its collecting card, in the same call', async () => {
    await setTheme('AR-3', 'AR-1');
    await update('AR-4', {
      relations: { remove: [{ kind: 'part_of', key: 'AR-3' }] },
      themeKey: 'AR-2',
    });
    expect(get('AR-4')).toMatchObject({ parentKey: null, themeKey: 'AR-2' });
  });
});

describe('closing and reopening a theme', () => {
  it('closes without touching its cards, and reopens', async () => {
    await setTheme('AR-3', 'AR-1');
    await setTheme('AR-5', 'AR-1');
    const cards = () => ['AR-3', 'AR-4', 'AR-5'].map((key) => get(key));
    const before = cards();

    const closed = await h.domain.tasks.closeTheme('AR', 'AR-1', DEVELOPER);
    expect(closed).toMatchObject({ status: 'cancelled', kind: 'theme' });
    expect(closed.closedAt).toBeTruthy();
    expect(cards()).toEqual(before);
    expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' }).at(-1)).toMatchObject({
      type: 'task_updated',
      data: { action: 'closed', fields: ['status', 'closedAt'], previousStatus: 'active' },
    });

    const reopened = await h.domain.tasks.reopen('AR', 'AR-1', DEVELOPER);
    expect(reopened).toMatchObject({ status: 'active', closedAt: null });
    expect(cards()).toEqual(before);
  });

  it('is done by a person of developer access, not by an AI member, a viewer or for a card', async () => {
    await expect(h.domain.tasks.closeTheme('AR', 'AR-1', AI)).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    await expect(h.domain.tasks.closeTheme('AR', 'AR-5', OWNER_ACTOR)).rejects.toMatchObject({
      code: 'task_not_theme',
    });
    await h.domain.tasks.closeTheme('AR', 'AR-1', DEVELOPER);
    await expect(h.domain.tasks.closeTheme('AR', 'AR-1', DEVELOPER)).rejects.toMatchObject({
      code: 'task_closed',
    });
    await expect(h.domain.tasks.reopen('AR', 'AR-1', AI)).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    await expect(h.domain.tasks.reopen('AR', 'AR-2', DEVELOPER)).rejects.toMatchObject({
      code: 'task_not_cancelled',
    });
  });

  it('reopens a card as before: only an admin or the owner may', async () => {
    await h.domain.tasks.cancel('AR', 'AR-5', {}, OWNER_ACTOR);
    await expect(h.domain.tasks.reopen('AR', 'AR-5', DEVELOPER)).rejects.toMatchObject({
      code: 'insufficient_access',
    });
    await h.domain.tasks.reopen('AR', 'AR-5', OWNER_ACTOR);
    expect(get('AR-5').status).toBe('active');
  });

  it('keeps its cards after it is closed, and takes no new one', async () => {
    await setTheme('AR-5', 'AR-1');
    await h.domain.tasks.closeTheme('AR', 'AR-1', OWNER_ACTOR);
    expect(get('AR-5').themeKey).toBe('AR-1');
    await expect(setTheme('AR-6', 'AR-1')).rejects.toMatchObject({ code: 'theme_closed' });
    await h.domain.tasks.reopen('AR', 'AR-1', OWNER_ACTOR);
    await setTheme('AR-6', 'AR-1');
    expect(get('AR-6').themeKey).toBe('AR-1');
  });
});

describe('the theme in a session', () => {
  it('reaches the context pack of a card in a theme, and of a subtask through its collecting card', async () => {
    await setTheme('AR-3', 'AR-1');
    await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-3' });
    await h.domain.sessions.ensureSession('AR', 'dev-2', { type: 'task', taskKey: 'AR-4' });
    await h.domain.sessions.ensureSession('AR', 'cr', { type: 'task', taskKey: 'AR-5' });
    const theme = (taskKey: string) =>
      h.contextBuilder.inputs.find((input) => input.task?.key === taskKey)?.theme;
    expect(theme('AR-3')).toEqual({ key: 'AR-1', title: 'Epic one', stageId: 'backlog', status: 'active' });
    expect(theme('AR-4')).toEqual(theme('AR-3'));
    expect(theme('AR-5')).toBeUndefined();
  });
});

describe('team tools', () => {
  const ctx = (member = 'dev-1') => ({
    projectKey: 'AR',
    member,
    sessionId: 'ses_example',
    taskKey: 'AR-5',
  });

  it('create_task creates a theme, and a card in one; update_task moves and clears it', async () => {
    const { task: theme } = await h.domain.teamTools.createTask(ctx(), { title: 'Epic', kind: 'theme' });
    expect(theme).toMatchObject({ kind: 'theme', createdBy: 'dev-1', stageId: 'backlog' });
    const { task } = await h.domain.teamTools.createTask(ctx(), { title: 'Card', themeKey: theme.key });
    expect(task.themeKey).toBe(theme.key);

    const moved = await h.domain.teamTools.updateTask(ctx(), { taskKey: 'AR-5', themeKey: 'AR-2' });
    expect(moved.task.themeKey).toBe('AR-2');
    expect(h.domain.timeline.list('AR', { taskKey: 'AR-5' }).at(-1)).toMatchObject({
      type: 'task_theme_changed',
      sessionId: 'ses_example',
      actor: { kind: 'ai', handle: 'dev-1' },
    });
    const cleared = await h.domain.teamTools.updateTask(ctx(), { taskKey: 'AR-5', themeKey: null });
    expect(cleared.task.themeKey ?? null).toBeNull();
  });

  it('refuses in words the agent can act on', async () => {
    await expect(
      h.domain.teamTools.updateTask(ctx(), { taskKey: 'AR-4', themeKey: 'AR-1' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('theme of its parent') });
    await expect(
      h.domain.teamTools.updateTask(ctx(), { taskKey: 'AR-1', stageId: 'development' }),
    ).rejects.toMatchObject({ message: expect.stringContaining('a theme cannot move between stages') });
  });

  it('list_tasks marks themes and leaves them out of a stage filter', async () => {
    const all = await h.domain.teamTools.listTasks(ctx(), {});
    expect(all.filter((entry) => entry.kind === 'theme').map((entry) => entry.key)).toEqual(
      expect.arrayContaining(['AR-1', 'AR-2']),
    );
    expect(all.find((entry) => entry.key === 'AR-5')).not.toHaveProperty('kind');
    const backlog = await h.domain.teamTools.listTasks(ctx(), { stage: 'backlog' });
    expect(backlog.map((entry) => entry.key)).toEqual(expect.arrayContaining(['AR-3', 'AR-5']));
    expect(backlog.map((entry) => entry.key)).not.toContain('AR-1');
  });

  it('get_task shows a card its theme, and a theme its cards and progress', async () => {
    await setTheme('AR-3', 'AR-1');
    await setTheme('AR-5', 'AR-1');
    const card = await h.domain.teamTools.getTask(ctx(), { taskKey: 'AR-4' });
    expect(card.theme).toEqual({ key: 'AR-1', title: 'Epic one', stageId: 'backlog', status: 'active' });
    expect(card.themeCards).toBeUndefined();
    const alone = await h.domain.teamTools.getTask(ctx(), { taskKey: 'AR-6' });
    expect(alone.theme).toBeUndefined();

    const theme = await h.domain.teamTools.getTask(ctx(), { taskKey: 'AR-1' });
    expect(theme.theme).toBeUndefined();
    expect(theme.themeCards?.map((c) => [c.key, c.subtasks.map((s) => s.key)])).toEqual([
      ['AR-3', ['AR-4']],
      ['AR-5', []],
    ]);
    expect(theme.themeProgress).toEqual({ done: 0, total: 3 });
  });
});

describe('what a theme shows', () => {
  it('lists its cards, collecting cards with their subtasks, and its progress', async () => {
    await setTheme('AR-3', 'AR-1');
    await setTheme('AR-5', 'AR-1');
    await setTheme('AR-6', 'AR-2');
    await h.domain.tasks.create('AR', { title: 'Seven', themeKey: 'AR-1' }, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-7', {}, OWNER_ACTOR);
    // AR-4 (the subtask) is done.
    h.repos.tasks.update(get('AR-4').id, { status: 'done', closedAt: '2026-01-02T00:00:00.000Z' });

    const view = h.domain.tasks.themeOf('AR', 'AR-1');

    expect(view.cards.map((card) => [card.key, card.subtasks.map((subtask) => subtask.key)])).toEqual([
      ['AR-3', ['AR-4']],
      ['AR-5', []],
      ['AR-7', []],
    ]);
    // The cancelled AR-7 counts neither way: AR-3 and AR-5 are open, AR-4 is done.
    expect(view.progress).toEqual({ done: 1, total: 3 });
    expect(h.domain.tasks.themeOf('AR', 'AR-2').progress).toEqual({ done: 0, total: 1 });
    expect(codeOf(() => h.domain.tasks.themeOf('AR', 'AR-5'))).toBe('task_not_theme');
  });
});

describe('a theme in the database', () => {
  it('is read back as a theme, its card with its theme, and a plain card as before', async () => {
    await h.domain.tasks.create('AR', { title: 'In a theme', themeKey: 'AR-1' }, OWNER_ACTOR);
    const task = (key: string): Task => h.repos.tasks.get(key)!;
    expect(task('AR-1').kind).toBe('theme');
    expect(task('AR-7').themeKey).toBe('AR-1');
    expect(task('AR-5').kind).toBeUndefined();
    expect(Object.keys(task('AR-5'))).not.toContain('themeKey');
  });
});
