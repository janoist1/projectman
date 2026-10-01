import type { Actor, Task } from '@projectman/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiActor, humanActor } from '../src/domain';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/**
 * PM-202: relations between cards (part of, prerequisite, related, duplicate of): the rules, the
 * storage as links of the card that set them, the timelines of both cards, and who may mark a
 * duplicate. Cards AR-1 … AR-4 are created in the queue stage for each test.
 */
let h: DomainHarness;
const ADMIN = humanActor('admin-1');
const DEVELOPER = humanActor('dev-human');
const AI: Actor = aiActor('dev-1');

beforeEach(async () => {
  h = await createDomainHarness({
    adjust: (config) => {
      config.team.members.push(
        { kind: 'human', handle: 'admin-1', displayName: 'Admin', access: 'admin', roles: [] },
        { kind: 'human', handle: 'dev-human', displayName: 'Developer', access: 'developer', roles: [] },
      );
    },
  });
  for (const title of ['One', 'Two', 'Three', 'Four'])
    await h.domain.tasks.create('AR', { title }, OWNER_ACTOR);
});
afterEach(() => h.cleanup());

type Add = { kind: 'part_of' | 'prerequisite' | 'related' | 'duplicate_of'; key: string };
type Remove = { kind: string; key: string };
const relate = (key: string, add: Add[], remove: Remove[] = [], actor: Actor = OWNER_ACTOR) =>
  h.domain.tasks.update('AR', key, { relations: { add, remove: remove as never } }, actor);
const kinds = (key: string) =>
  h.domain.tasks.relationsOf('AR', key).map((relation) => `${relation.kind} ${relation.key}`);
const events = (key: string, ...types: string[]) =>
  h.domain.timeline
    .list('AR', { taskKey: key })
    .filter((event) => types.includes(event.type))
    .map((event) => `${event.type} ${String(event.data.kind)} ${String(event.data.ref)}`);
const snapshot = () => ({
  tasks: h.domain.tasks.list('AR').map((task) => ({ ...task, startWaiting: undefined })),
  timeline: h.domain.timeline.list('AR').length,
});

describe('adding relations', () => {
  it('stores a prerequisite, a related and a duplicate once, on the card that set them', async () => {
    await relate('AR-1', [
      { kind: 'prerequisite', key: 'AR-2' },
      { kind: 'related', key: 'AR-3' },
    ]);
    await relate('AR-4', [{ kind: 'duplicate_of', key: 'AR-3' }]);
    const links = (key: string) => h.domain.tasks.get('AR', key).links;
    expect(links('AR-1')).toEqual([
      { kind: 'prerequisite', ref: 'AR-2' },
      { kind: 'related', ref: 'AR-3' },
    ]);
    expect(links('AR-2')).toEqual([]);
    expect(links('AR-3')).toEqual([]);
    expect(links('AR-4')).toEqual([{ kind: 'duplicate_of', ref: 'AR-3' }]);
  });

  it('shows each relation on both cards, from the side of each', async () => {
    await relate('AR-1', [
      { kind: 'prerequisite', key: 'AR-2' },
      { kind: 'related', key: 'AR-3' },
    ]);
    await relate('AR-4', [{ kind: 'duplicate_of', key: 'AR-3' }]);
    expect(kinds('AR-1')).toEqual(['prerequisite AR-2', 'related AR-3']);
    expect(kinds('AR-2')).toEqual(['prerequisite_of AR-1']);
    expect(kinds('AR-3')).toEqual(['related AR-1', 'duplicated_by AR-4']);
    expect(kinds('AR-4')).toEqual(['duplicate_of AR-3']);
    expect(h.domain.tasks.relationsOf('AR', 'AR-1')[0]).toEqual({
      kind: 'prerequisite',
      key: 'AR-2',
      title: 'Two',
      stageId: 'backlog',
      status: 'active',
    });
  });

  it('puts the event on both timelines, each from its own side', async () => {
    await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);
    await relate('AR-3', [{ kind: 'related', key: 'AR-4' }]);
    expect(events('AR-1', 'task_relation_added')).toEqual(['task_relation_added prerequisite AR-2']);
    expect(events('AR-2', 'task_relation_added')).toEqual(['task_relation_added prerequisite_of AR-1']);
    expect(events('AR-3', 'task_relation_added')).toEqual(['task_relation_added related AR-4']);
    expect(events('AR-4', 'task_relation_added')).toEqual(['task_relation_added related AR-3']);
    const event = h.domain.timeline
      .list('AR', { taskKey: 'AR-2' })
      .find((e) => e.type === 'task_relation_added');
    expect(event).toMatchObject({ actor: OWNER_ACTOR, projectKey: 'AR' });
  });

  it('records no event and writes nothing when the relation is there already', async () => {
    await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);
    const before = snapshot();
    await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);
    expect(snapshot()).toEqual(before);
  });

  it('keeps a related pair once, whichever card sets it', async () => {
    await relate('AR-1', [{ kind: 'related', key: 'AR-2' }]);
    await relate('AR-2', [{ kind: 'related', key: 'AR-1' }]);
    expect(h.domain.tasks.get('AR', 'AR-1').links).toEqual([{ kind: 'related', ref: 'AR-2' }]);
    expect(h.domain.tasks.get('AR', 'AR-2').links).toEqual([]);
    expect(events('AR-1', 'task_relation_added')).toHaveLength(1);
    expect(kinds('AR-2')).toEqual(['related AR-1']);
  });

  it('sets the card as part of another with the subtask events and rules of today', async () => {
    await relate('AR-2', [{ kind: 'part_of', key: 'AR-1' }]);
    expect(h.domain.tasks.get('AR', 'AR-2').parentKey).toBe('AR-1');
    expect(kinds('AR-1')).toEqual(['has_part AR-2']);
    expect(kinds('AR-2')).toEqual(['part_of AR-1']);
    for (const key of ['AR-1', 'AR-2'])
      expect(events(key, 'task_subtask_added')).toEqual(['task_subtask_added undefined undefined']);
    expect(h.domain.tasks.detail('AR', 'AR-1').subtasks?.map((t) => t.key)).toEqual(['AR-2']);
    // The family used for messages stays the parent and its subtasks.
    expect(h.domain.tasks.family('AR', 'AR-2').map((t) => t.key)).toEqual(['AR-1']);
  });

  it('refuses a second parent, and moves the card when the call removes the first', async () => {
    await relate('AR-3', [{ kind: 'part_of', key: 'AR-1' }]);
    await expect(relate('AR-3', [{ kind: 'part_of', key: 'AR-2' }])).rejects.toMatchObject({
      code: 'relation_parent_exists',
    });
    await relate('AR-3', [{ kind: 'part_of', key: 'AR-2' }], [{ kind: 'part_of', key: 'AR-1' }]);
    expect(h.domain.tasks.get('AR', 'AR-3').parentKey).toBe('AR-2');
    expect(events('AR-1', 'task_subtask_added', 'task_subtask_removed')).toHaveLength(2);
  });

  it('is limited like the subtasks of today: one level', async () => {
    await relate('AR-2', [{ kind: 'part_of', key: 'AR-1' }]);
    await expect(relate('AR-3', [{ kind: 'part_of', key: 'AR-2' }])).rejects.toMatchObject({
      code: 'subtask_parent_is_subtask',
    });
    await expect(relate('AR-1', [{ kind: 'part_of', key: 'AR-3' }])).rejects.toMatchObject({
      code: 'subtask_has_children',
    });
  });
});

describe('refusals', () => {
  it('refuses a relation to the card itself, a missing card and a card of another project', async () => {
    const foreign: Task = {
      ...h.domain.tasks.get('AR', 'AR-2'),
      id: 'tsk_foreign',
      key: 'XY-1',
      projectKey: 'XY',
    };
    h.repos.projects.insert({
      key: 'XY',
      name: 'Example',
      templateId: null,
      configVersion: 'v1',
      createdAt: foreign.createdAt,
      updatedAt: foreign.updatedAt,
    });
    h.repos.tasks.insert(foreign);
    const before = snapshot();
    for (const kind of ['prerequisite', 'related', 'duplicate_of'] as const) {
      await expect(relate('AR-1', [{ kind, key: 'AR-1' }])).rejects.toMatchObject({ code: 'relation_self' });
      await expect(relate('AR-1', [{ kind, key: 'AR-99' }])).rejects.toMatchObject({
        code: 'relation_target_not_found',
      });
      await expect(relate('AR-1', [{ kind, key: 'XY-1' }])).rejects.toMatchObject({
        code: 'relation_target_project',
      });
    }
    expect(snapshot()).toEqual(before);
  });

  it('explains a loop of two cards, and one through three', async () => {
    await relate('AR-1', [{ kind: 'prerequisite', key: 'AR-2' }]);
    await expect(relate('AR-2', [{ kind: 'prerequisite', key: 'AR-1' }])).rejects.toMatchObject({
      code: 'relation_cycle',
      message: 'that would make a loop of prerequisites: AR-2 needs AR-1 needs AR-2',
      details: { path: ['AR-2', 'AR-1', 'AR-2'] },
    });
    await relate('AR-2', [{ kind: 'prerequisite', key: 'AR-3' }]);
    await expect(relate('AR-3', [{ kind: 'prerequisite', key: 'AR-1' }])).rejects.toMatchObject({
      code: 'relation_cycle',
      details: { path: ['AR-3', 'AR-1', 'AR-2', 'AR-3'] },
    });
  });

  it('does not let the two directions of one call close a loop', async () => {
    await expect(
      relate('AR-1', [
        { kind: 'prerequisite', key: 'AR-2' },
        { kind: 'prerequisite', key: 'AR-3' },
      ]),
    ).resolves.toBeDefined();
    // Two calls "at once": each reads the graph as the other left it, so the second is refused.
    const results = await Promise.allSettled([
      relate('AR-2', [{ kind: 'prerequisite', key: 'AR-4' }]),
      relate('AR-4', [{ kind: 'prerequisite', key: 'AR-2' }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: 'relation_cycle' });
  });

  it('is all or nothing: one refused relation leaves the rest of the call undone', async () => {
    const before = snapshot();
    await expect(
      h.domain.tasks.update(
        'AR',
        'AR-1',
        {
          title: 'Must not save',
          addLabels: ['hotfix'],
          note: 'Must not be recorded',
          relations: {
            add: [
              { kind: 'prerequisite', key: 'AR-2' },
              { kind: 'related', key: 'AR-3' },
              { kind: 'related', key: 'AR-1' },
            ],
          },
        },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'relation_self' });
    expect(snapshot()).toEqual(before);
    expect(h.domain.tasks.get('AR', 'AR-1').title).toBe('One');
    expect(kinds('AR-2')).toEqual([]);
  });

  it('refuses the parent in both parentKey and relations', async () => {
    await expect(
      h.domain.tasks.update(
        'AR',
        'AR-2',
        { parentKey: 'AR-1', relations: { add: [{ kind: 'part_of', key: 'AR-3' }] } },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('removing relations', () => {
  beforeEach(async () => {
    await relate('AR-1', [
      { kind: 'prerequisite', key: 'AR-2' },
      { kind: 'related', key: 'AR-3' },
    ]);
    await relate('AR-4', [{ kind: 'part_of', key: 'AR-3' }]);
  });

  it('removes a relation from the card that set it, and records it on both cards', async () => {
    await relate('AR-1', [], [{ kind: 'prerequisite', key: 'AR-2' }]);
    expect(kinds('AR-1')).toEqual(['related AR-3']);
    expect(kinds('AR-2')).toEqual([]);
    expect(events('AR-1', 'task_relation_removed')).toEqual(['task_relation_removed prerequisite AR-2']);
    expect(events('AR-2', 'task_relation_removed')).toEqual(['task_relation_removed prerequisite_of AR-1']);
  });

  it('removes the reverse of a stored relation from the other card', async () => {
    await relate('AR-2', [], [{ kind: 'prerequisite_of', key: 'AR-1' }]);
    expect(h.domain.tasks.get('AR', 'AR-1').links).toEqual([{ kind: 'related', ref: 'AR-3' }]);
    // A related pair is removable from either card.
    await relate('AR-3', [], [{ kind: 'related', key: 'AR-1' }]);
    expect(h.domain.tasks.get('AR', 'AR-1').links).toEqual([]);
    // The subtask is removed from its parent's side.
    await relate('AR-3', [], [{ kind: 'has_part', key: 'AR-4' }]);
    expect(h.domain.tasks.get('AR', 'AR-4').parentKey).toBeNull();
    expect(events('AR-3', 'task_subtask_removed')).toHaveLength(1);
  });

  it('refuses to remove a relation the cards do not have, and leaves the rest of the call undone', async () => {
    const before = snapshot();
    await expect(
      h.domain.tasks.update(
        'AR',
        'AR-1',
        {
          title: 'Must not save',
          relations: {
            remove: [
              { kind: 'related', key: 'AR-3' },
              { kind: 'prerequisite_of', key: 'AR-2' },
            ],
          },
        },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'relation_not_found' });
    expect(snapshot()).toEqual(before);
  });

  it('applies removals before additions, so one call can change the kind', async () => {
    await relate('AR-1', [{ kind: 'related', key: 'AR-2' }], [{ kind: 'prerequisite', key: 'AR-2' }]);
    expect(kinds('AR-1')).toEqual(['related AR-2', 'related AR-3']);
  });

  it('lets a removed prerequisite be set the other way round', async () => {
    await expect(relate('AR-2', [{ kind: 'prerequisite', key: 'AR-1' }])).rejects.toMatchObject({
      code: 'relation_cycle',
    });
    await relate('AR-2', [{ kind: 'prerequisite', key: 'AR-1' }], [{ kind: 'prerequisite_of', key: 'AR-1' }]);
    expect(kinds('AR-2')).toEqual(['prerequisite AR-1']);
  });
});

describe('creating a card with relations', () => {
  it('stores them and records both timelines in the creation', async () => {
    const task = await h.domain.tasks.create(
      'AR',
      {
        title: 'Follow-up',
        relations: [
          { kind: 'prerequisite', key: 'AR-1' },
          { kind: 'related', key: 'AR-2' },
          { kind: 'part_of', key: 'AR-3' },
        ],
      },
      AI,
    );
    expect(task.key).toBe('AR-5');
    expect(task.parentKey).toBe('AR-3');
    expect(kinds('AR-5')).toEqual(['part_of AR-3', 'prerequisite AR-1', 'related AR-2']);
    expect(events('AR-1', 'task_relation_added')).toEqual(['task_relation_added prerequisite_of AR-5']);
    expect(events('AR-5', 'task_relation_added')).toEqual([
      'task_relation_added prerequisite AR-1',
      'task_relation_added related AR-2',
    ]);
  });

  it('is refused whole when one relation is refused: no card, no event, no number used up', async () => {
    const before = snapshot();
    await expect(
      h.domain.tasks.create(
        'AR',
        {
          title: 'Refused',
          relations: [
            { kind: 'prerequisite', key: 'AR-1' },
            { kind: 'related', key: 'AR-99' },
          ],
        },
        AI,
      ),
    ).rejects.toMatchObject({ code: 'relation_target_not_found' });
    expect(snapshot()).toEqual(before);
    expect((await h.domain.tasks.create('AR', { title: 'Next' }, AI)).key).toBe('AR-5');
  });

  it('can mark the new card a duplicate, which closes it', async () => {
    const task = await h.domain.tasks.create(
      'AR',
      { title: 'Again', relations: [{ kind: 'duplicate_of', key: 'AR-1' }] },
      AI,
    );
    expect(task.status).toBe('cancelled');
    expect(kinds('AR-1')).toEqual(['duplicated_by AR-5']);
  });
});

describe('duplicates', () => {
  it('closes a card that has not started, pointing at the original, whoever marks it', async () => {
    for (const [key, actor] of [
      ['AR-1', AI],
      ['AR-2', DEVELOPER],
      ['AR-3', ADMIN],
    ] as const) {
      const closed = await relate(key, [{ kind: 'duplicate_of', key: 'AR-4' }], [], actor);
      expect(closed).toMatchObject({ status: 'cancelled', stageId: 'backlog' });
      expect(closed.closedAt).not.toBeNull();
      const cancelled = h.domain.timeline
        .list('AR', { taskKey: key })
        .find((event) => event.type === 'task_updated' && event.data.action === 'cancelled');
      expect(cancelled).toMatchObject({
        actor,
        data: { fields: ['status', 'closedAt'], reason: 'duplicate of AR-4', duplicateOf: 'AR-4' },
      });
    }
    expect(kinds('AR-4')).toEqual(['duplicated_by AR-1', 'duplicated_by AR-2', 'duplicated_by AR-3']);
    expect(h.domain.tasks.get('AR', 'AR-4').status).toBe('active');
    expect(events('AR-4', 'task_relation_added')).toHaveLength(3);
  });

  it('refuses a duplicate of a duplicate, and names the original', async () => {
    await relate('AR-1', [{ kind: 'duplicate_of', key: 'AR-2' }]);
    await expect(relate('AR-3', [{ kind: 'duplicate_of', key: 'AR-1' }])).rejects.toMatchObject({
      code: 'relation_duplicate_of_duplicate',
      message: 'the card AR-1 is a duplicate itself: point at its original, AR-2',
      details: { original: 'AR-2' },
    });
    expect(h.domain.tasks.get('AR', 'AR-3').status).toBe('active');
  });

  it('does not reopen the card when the relation is removed', async () => {
    await relate('AR-1', [{ kind: 'duplicate_of', key: 'AR-2' }]);
    await relate('AR-1', [], [{ kind: 'duplicate_of', key: 'AR-2' }]);
    expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ status: 'cancelled', links: [] });
    expect(kinds('AR-2')).toEqual([]);
    expect(events('AR-2', 'task_relation_removed')).toEqual(['task_relation_removed duplicated_by AR-1']);
  });

  it('closes a card in development with its session when an admin marks it; an AI member or a developer may not', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await flush();
    const session = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-1' }))
      .session;
    const before = snapshot();
    for (const actor of [AI, aiActor('dev-2'), DEVELOPER]) {
      await expect(relate('AR-1', [{ kind: 'duplicate_of', key: 'AR-2' }], [], actor)).rejects.toMatchObject({
        code: 'duplicate_not_allowed',
        status: 403,
        message: expect.stringContaining('only an admin or the owner can mark a card that has started'),
      });
    }
    expect(snapshot()).toEqual(before);

    await relate('AR-1', [{ kind: 'duplicate_of', key: 'AR-2' }], [], ADMIN);
    await flush();
    expect(h.domain.tasks.get('AR', 'AR-1').status).toBe('cancelled');
    expect(h.runner.stopped).toContain(session.id);
  });

  it('counts a card of a queue stage with a live session as started', async () => {
    const session = (await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'task', taskKey: 'AR-2' }))
      .session;
    expect(h.domain.tasks.get('AR', 'AR-2').stageId).toBe('backlog');
    await expect(relate('AR-2', [{ kind: 'duplicate_of', key: 'AR-1' }], [], AI)).rejects.toMatchObject({
      code: 'duplicate_not_allowed',
    });
    await relate('AR-2', [{ kind: 'duplicate_of', key: 'AR-1' }], [], OWNER_ACTOR);
    await flush();
    expect(h.runner.stopped).toContain(session.id);
  });

  it('only makes the relation on a card that is closed already, whoever marks it', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-1', {}, OWNER_ACTOR);
    await h.domain.tasks.cancel('AR', 'AR-3', {}, OWNER_ACTOR);
    const cancelEvents = () =>
      h.domain.timeline.list('AR', { taskKey: 'AR-1' }).filter((e) => e.data.action === 'cancelled').length;
    expect(cancelEvents()).toBe(1);
    const task = await relate('AR-1', [{ kind: 'duplicate_of', key: 'AR-2' }], [], AI);
    expect(task.status).toBe('cancelled');
    expect(kinds('AR-2')).toEqual(['duplicated_by AR-1']);
    expect(cancelEvents()).toBe(1);
    // A card that finished is no different.
    await relate('AR-3', [{ kind: 'duplicate_of', key: 'AR-2' }], [], DEVELOPER);
    expect(kinds('AR-2')).toEqual(['duplicated_by AR-1', 'duplicated_by AR-3']);
  });

  it('refuses a card that moves and is marked as a duplicate in the same call', async () => {
    await expect(
      h.domain.tasks.update(
        'AR',
        'AR-1',
        { stageId: 'development', relations: { add: [{ kind: 'duplicate_of', key: 'AR-2' }] } },
        OWNER_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(h.domain.tasks.get('AR', 'AR-1')).toMatchObject({ stageId: 'backlog', status: 'active' });
  });
});

describe('the existing readers of the links', () => {
  it('keeps what the family and the related sessions read, and lets related and duplicate stay out of them', async () => {
    await relate('AR-2', [{ kind: 'part_of', key: 'AR-1' }]);
    await relate('AR-3', [{ kind: 'prerequisite', key: 'AR-1' }]);
    await relate('AR-4', [
      { kind: 'related', key: 'AR-1' },
      { kind: 'duplicate_of', key: 'AR-1' },
    ]);
    for (const member of ['dev-1']) {
      for (const key of ['AR-2', 'AR-3', 'AR-4'])
        await h.domain.sessions.ensureSession('AR', member, { type: 'task', taskKey: key });
    }
    h.runner.started.length = 0;
    await flush();
    // The messages' family is the parent and its subtasks only.
    expect(h.domain.tasks.family('AR', 'AR-1').map((t) => t.key)).toEqual(['AR-2']);
    expect(h.domain.tasks.family('AR', 'AR-3')).toEqual([]);
    expect(h.domain.tasks.family('AR', 'AR-4')).toEqual([]);
  });
});

describe('team tools', () => {
  const ctx = (member = 'dev-1') => ({ projectKey: 'AR', member, sessionId: 'ses_example', taskKey: 'AR-1' });

  it('update_task adds and removes relations with the rest of the call, and get_task lists them', async () => {
    const { task } = await h.domain.teamTools.updateTask(ctx(), {
      taskKey: 'AR-1',
      note: 'Order of work.',
      relations: {
        add: [
          { kind: 'prerequisite', key: 'AR-2' },
          { kind: 'related', key: 'AR-3' },
        ],
      },
    });
    expect(task.links).toEqual([
      { kind: 'prerequisite', ref: 'AR-2' },
      { kind: 'related', ref: 'AR-3' },
    ]);
    const detail = await h.domain.teamTools.getTask(ctx(), { taskKey: 'AR-2' });
    expect(detail.relations).toEqual([
      { kind: 'prerequisite_of', key: 'AR-1', title: 'One', stageId: 'backlog', status: 'active' },
    ]);
    expect(
      h.domain.timeline.list('AR', { taskKey: 'AR-2' }).find((event) => event.type === 'task_relation_added'),
    ).toMatchObject({ sessionId: 'ses_example', actor: { kind: 'ai', handle: 'dev-1' } });
    await h.domain.teamTools.updateTask(ctx(), {
      taskKey: 'AR-1',
      relations: { add: [], remove: [{ kind: 'related', key: 'AR-3' }] },
    });
    expect((await h.domain.teamTools.getTask(ctx(), { taskKey: 'AR-3' })).relations).toEqual([]);
  });

  it('create_task starts a card with relations', async () => {
    const { task } = await h.domain.teamTools.createTask(ctx(), {
      title: 'Next step',
      relations: [{ kind: 'prerequisite', key: 'AR-1' }],
    });
    expect(task.links).toEqual([{ kind: 'prerequisite', ref: 'AR-1' }]);
  });

  it('answers a refusal in words the agent can act on', async () => {
    await h.domain.teamTools.updateTask(ctx(), {
      taskKey: 'AR-1',
      relations: { add: [{ kind: 'prerequisite', key: 'AR-2' }] },
    });
    await expect(
      h.domain.teamTools.updateTask(ctx(), {
        taskKey: 'AR-2',
        relations: { add: [{ kind: 'prerequisite', key: 'AR-1' }] },
      }),
    ).rejects.toMatchObject({
      code: 'invalid',
      message: 'that would make a loop of prerequisites: AR-2 needs AR-1 needs AR-2',
    });
  });

  it('refuses an AI member to mark a started card as a duplicate, as forbidden', async () => {
    await h.domain.tasks.moveToStage('AR', 'AR-1', 'development', OWNER_ACTOR);
    await expect(
      h.domain.teamTools.updateTask(ctx(), {
        taskKey: 'AR-1',
        relations: { add: [{ kind: 'duplicate_of', key: 'AR-2' }] },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(h.domain.tasks.get('AR', 'AR-1').status).toBe('active');
    // A card that has not started is theirs to mark.
    await h.domain.teamTools.updateTask(ctx(), {
      taskKey: 'AR-3',
      relations: { add: [{ kind: 'duplicate_of', key: 'AR-2' }] },
    });
    expect(h.domain.tasks.get('AR', 'AR-3').status).toBe('cancelled');
  });
});
