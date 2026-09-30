import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CreateTaskRequest, UpdateTaskRequest } from '@projectman/shared';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
beforeEach(async () => {
  h = await createDomainHarness();
});
afterEach(() => h.cleanup());
const create = (title: string, parentKey?: string) =>
  h.domain.tasks.create('AR', { title, parentKey }, OWNER_ACTOR);
const update = (key: string, parentKey: string | null) =>
  h.domain.tasks.update('AR', key, { parentKey }, OWNER_ACTOR);

describe('one-level subtasks', () => {
  it('accepts additive parent contracts, preserving omitted fields and clearing with null', async () => {
    expect(CreateTaskRequest.parse({ title: 'Child', parentKey: 'AR-1' }).parentKey).toBe('AR-1');
    expect(UpdateTaskRequest.parse({ parentKey: null })).toEqual({ parentKey: null });
    expect(CreateTaskRequest.safeParse({ title: 'Child', parentKey: null }).success).toBe(false);
    const parent = await create('Parent');
    const child = await create('Child', parent.key);
    expect(child.parentKey).toBe(parent.key);
    expect(h.repos.tasks.get(child.key)?.parentKey).toBe(parent.key);
    await h.domain.tasks.update('AR', child.key, { title: 'Renamed child' }, OWNER_ACTOR);
    expect(h.domain.tasks.get('AR', child.key).parentKey).toBe(parent.key);
    expect((await update(child.key, null)).parentKey).toBeNull();
    expect((await update(child.key, parent.key)).parentKey).toBe(parent.key);
    expect(h.domain.tasks.detail('AR', parent.key).subtasks).toEqual([h.domain.tasks.get('AR', child.key)]);
    expect(h.domain.tasks.detail('AR', child.key).parent?.key).toBe(parent.key);
    expect(h.runner.started).toHaveLength(0);
  });

  it('records attachment, detachment and reparenting on both tasks, without duplicate no-op events', async () => {
    const parent = await create('Parent');
    const other = await create('Other');
    const child = await create('Child', parent.key);
    await update(child.key, parent.key);
    await update(child.key, other.key);
    await update(child.key, null);
    const relations = h.domain.timeline.list('AR').filter((event) => event.type.startsWith('task_subtask_'));
    expect(relations).toHaveLength(8);
    for (const key of [parent.key, other.key]) {
      const events = relations.filter((event) => event.taskKey === key);
      expect(events.map((event) => event.type)).toEqual(['task_subtask_added', 'task_subtask_removed']);
      expect(
        events.every(
          (event) =>
            event.data.parentKey === key &&
            event.data.subtaskKey === child.key &&
            event.actor.handle === 'owner',
        ),
      ).toBe(true);
    }
    expect(relations.filter((event) => event.taskKey === child.key)).toHaveLength(4);
  });

  it('rejects every invalid hierarchy on create and update before changing fields or history', async () => {
    const parent = await create('Parent');
    const child = await create('Child', parent.key);
    const other = await create('Other');
    const foreign = { ...other, id: 'tsk_foreign', key: 'XY-1', projectKey: 'XY' };
    h.repos.projects.insert({
      key: 'XY',
      name: 'Example',
      templateId: null,
      configVersion: 'v1',
      createdAt: other.createdAt,
      updatedAt: other.updatedAt,
    });
    h.repos.tasks.insert(foreign);
    const cases = [
      [parent.key, parent.key, 'subtask_self_parent'],
      [other.key, 'AR-999', 'subtask_parent_not_found'],
      [other.key, foreign.key, 'subtask_parent_project'],
      [other.key, child.key, 'subtask_parent_is_subtask'],
      [parent.key, other.key, 'subtask_has_children'],
      [parent.key, child.key, 'subtask_parent_is_subtask'],
    ] as const;
    const before = h.domain.timeline.list('AR').length;
    for (const [key, parentKey, code] of cases) {
      await expect(
        h.domain.tasks.update(
          'AR',
          key,
          { parentKey, title: 'Must not save', stageId: 'development' },
          OWNER_ACTOR,
        ),
      ).rejects.toMatchObject({ code });
      expect(h.domain.tasks.get('AR', key).title).not.toBe('Must not save');
      expect(h.domain.tasks.get('AR', key).stageId).toBe(parent.stageId);
    }
    for (const [parentKey, code] of [
      ['AR-999', 'subtask_parent_not_found'],
      [foreign.key, 'subtask_parent_project'],
      [child.key, 'subtask_parent_is_subtask'],
    ] as const) {
      await expect(create('Invalid', parentKey)).rejects.toMatchObject({ code });
    }
    expect(h.domain.timeline.list('AR')).toHaveLength(before);
    expect(h.domain.tasks.list('AR')).toHaveLength(3);
  });

  it('team tools create subtasks and get their parent and children', async () => {
    const parent = await create('Parent');
    const ctx = { projectKey: 'AR', member: 'dev-1', sessionId: 'ses_example', taskKey: parent.key };
    const { task } = await h.domain.teamTools.createTask(ctx, { title: 'Child', parentKey: parent.key });
    expect(task).toMatchObject({ parentKey: parent.key, assignee: null, stageId: parent.stageId });
    const detail = await h.domain.teamTools.getTask(ctx, { taskKey: parent.key });
    expect(detail.subtasks).toEqual([task]);
    expect((await h.domain.teamTools.getTask(ctx, { taskKey: task.key })).parent).toEqual(parent);
    await expect(
      h.domain.teamTools.createTask(ctx, { title: 'Grandchild', parentKey: task.key }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(
      h.domain.timeline
        .list('AR', { taskKey: parent.key })
        .find((event) => event.type === 'task_subtask_added'),
    ).toMatchObject({ sessionId: ctx.sessionId, actor: { kind: 'ai', handle: 'dev-1' } });
  });
});
