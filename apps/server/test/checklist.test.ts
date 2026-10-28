import { afterEach, expect, it } from 'vitest';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';

let h: DomainHarness;
afterEach(async () => {
  await h?.cleanup();
});

it.each([false, true])('initializes a base checklist with providerReady=%s', async (providerReady) => {
  h = await createDomainHarness();
  const checklist = await h.domain.checklist.get('AR');
  expect(checklist?.items).toHaveLength(11);
  expect(checklist?.items.find((item) => item.id === 'code')?.state).toBe('done');
  h.repos.db.prepare('DELETE FROM project_checklist_items WHERE project_key = ?').run('AR');
  h.repos.db.prepare('DELETE FROM project_checklists WHERE project_key = ?').run('AR');
  await h.domain.ctx.events.emit('project_created', { projectKey: 'AR', providerReady });
  const items = (await h.domain.checklist.get('AR'))!.items;
  expect(items.filter((item) => item.state === 'done').map((item) => item.id)).toEqual(
    providerReady ? ['code', 'engine', 'providers'] : ['code', 'engine'],
  );
});

it('reopens a completed conditional item after its reviewer disappears and refuses completion', async () => {
  h = await createDomainHarness();
  const service = h.domain.checklist;
  const item = (await service.get('AR'))!.items.find((item) => item.id === 'team')!;
  await service.put('AR', { ...item, state: 'done', condition: 'reviewer_member' });
  const reopened: unknown[] = [];
  h.domain.ctx.events.on('checklist_item_reopened', (event) => {
    reopened.push(event);
  });
  await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (config) => {
    config.team.members = config.team.members.filter((member) => member.handle !== 'cr');
    config.pipeline.stages = config.pipeline.stages.filter((stage) => stage.id !== 'code_review');
    for (const stage of config.pipeline.stages) {
      if (stage.gate)
        stage.gate.conditions = stage.gate.conditions.filter(
          (condition) => condition.label !== 'code-review-ok',
        );
    }
    return 'Remove reviewer';
  });
  const current = (await service.get('AR'))!;
  expect(current.items.find((item) => item.id === 'team')).toMatchObject({
    state: 'open',
    reopened: 'condition',
    updatedBy: 'system',
  });
  expect(current.items.find((item) => item.id === 'code')?.state).toBe('done');
  expect(reopened).toEqual([expect.objectContaining({ itemId: 'team', cause: 'condition' })]);
  await expect(
    service.put('AR', { ...item, state: 'done', condition: 'reviewer_member' }),
  ).rejects.toMatchObject({ code: 'checklist_condition_unmet' });
});

it('rechecks task conditions on cancellation but never completes open items automatically', async () => {
  h = await createDomainHarness();
  const service = h.domain.checklist;
  const task = await h.domain.tasks.create('AR', { title: 'First task' }, OWNER_ACTOR);
  const item = (await service.get('AR'))!.items.find((item) => item.id === 'first_task')!;
  expect(item).toMatchObject({ state: 'open', conditionHolds: true });
  await service.put('AR', { ...item, state: 'done' });
  // Cancellation is the event boundary; no other cancellation side effects are needed here.
  h.repos.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE key = ?").run(task.key);
  await h.domain.ctx.events.emit('task_cancelled', { ...task, status: 'cancelled' });
  expect((await service.get('AR'))!.items.find((item) => item.id === 'first_task')).toMatchObject({
    state: 'open',
    reopened: 'condition',
  });
});

it('leaves explicitly unnecessary items settled when their condition is false', async () => {
  h = await createDomainHarness();
  await h.domain.checklist.setState(
    'AR',
    'first_task',
    { state: 'not_needed', reason: 'No tasks required' },
    'owner',
  );
  await h.domain.checklist.recheck('AR');
  expect((await h.domain.checklist.get('AR'))!.items.find((item) => item.id === 'first_task')).toMatchObject({
    state: 'not_needed',
    reason: 'No tasks required',
    conditionHolds: false,
  });
});
