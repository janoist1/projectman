import { afterEach, expect, it } from 'vitest';
import { checklistLane } from '../src/runtime/member-queue';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { settle } from './helpers/fakes';

let h: DomainHarness;
afterEach(async () => {
  await h?.domain.stop();
  await h?.cleanup();
});

it('keeps the greeting queued until the provider login becomes available', async () => {
  h = await createDomainHarness({ pmOnDuty: true });
  let loggedIn = false;
  Object.assign(h.runner, {
    providerStatus: async () => ({
      provider: 'claude',
      loggedIn,
      method: loggedIn ? 'subscription' : 'none',
      checkedAt: '2026-10-23T10:00:00.000Z',
    }),
  });
  const config = await h.domain.projects.config('AR');
  await h.domain.projects.create(
    { key: 'NEW', name: 'New project', workspacePath: config.project.workspacePath, templateId: 'test' },
    OWNER,
  );
  await h.domain.memberQueueDriver.ensure('NEW', 'pm');
  const checklistItems = () =>
    h.repos.memberQueue.listOpen('NEW', 'pm').filter((item) => item.kind === 'checklist');
  expect(checklistItems()).toEqual([
    expect.objectContaining({
      kind: 'checklist',
      wait: expect.objectContaining({ code: 'provider_not_logged_in' }),
    }),
  ]);
  expect(h.runner.started).toEqual([]);
  loggedIn = true;
  await h.domain.memberQueueDriver.sweep();
  expect(h.runner.started).toContainEqual(expect.objectContaining({ member: 'pm' }));
  expect(checklistItems()).toEqual([]);
});

it('wakes the project manager after project creation without an owner message and completes delivery', async () => {
  h = await createDomainHarness({ onboarding: true, pmOnDuty: true });
  await settle();
  await h.domain.memberQueueDriver.ensure('AR', 'pm');
  const view = h.domain.memberQueue.view('AR', 'pm');
  expect(view.closed).toContainEqual(
    expect.objectContaining({
      kind: 'checklist',
      source: { type: 'checklist', noticeId: 'onboarding' },
      wake: true,
      state: 'done',
      closeReason: 'delivered',
      place: { type: 'general' },
    }),
  );
  expect(h.runner.started).toContainEqual(
    expect.objectContaining({
      member: 'pm',
      initialMessage: expect.stringContaining('get_checklist'),
    }),
  );
  expect(
    h.contextBuilder.inputs.find((input) => input.member.handle === 'pm')?.checklist?.items,
  ).toHaveLength(11);
  expect(h.repos.memberQueue.listOpen('AR', 'operator')).toEqual([]);
});

it('cancels an onboarding notice when the checklist has no remaining items', async () => {
  h = await createDomainHarness({ pmOnDuty: true });
  const lane = checklistLane({
    ctx: h.domain.ctx,
    projects: h.domain.projects,
    memberQueue: h.domain.memberQueue,
  });
  h.domain.memberQueue.add({
    projectKey: 'AR',
    member: 'pm',
    kind: 'checklist',
    source: { type: 'checklist', id: 'onboarding' },
    place: { type: 'general' },
    wake: false,
    taskKey: null,
    title: 'Onboarding',
    from: null,
  });
  const item = h.repos.memberQueue.listOpen('AR', 'pm')[0]!;
  expect(lane.stillOwed(item)).toBe(true);
  h.repos.db
    .prepare(
      "UPDATE project_checklist_items SET state = 'not_needed', reason = 'Already configured' WHERE project_key = 'AR'",
    )
    .run();
  expect(lane.stillOwed(item)).toBe(false);
  await h.domain.memberQueueDriver.ensure('AR', 'pm');
  expect(h.domain.memberQueue.get(item.id)?.state).toBe('cancelled');
});

it.each(['owner', 'condition'] as const)('delivers and closes a %s reopening notice', async (cause) => {
  h = await createDomainHarness({ pmOnDuty: true });
  const item = (await h.domain.checklist.get('AR'))!.items.find((entry) => entry.id === 'team')!;
  if (cause === 'owner') {
    await h.domain.checklist.setState('AR', 'team', { state: 'not_needed', reason: 'Later' }, 'owner');
    await h.domain.checklist.setState('AR', 'team', { state: 'open' }, 'owner');
  } else {
    const task = await h.domain.tasks.create('AR', { title: 'First task' }, OWNER_ACTOR);
    await h.domain.checklist.put('AR', { ...item, state: 'done', condition: 'task_exists' });
    h.repos.db.prepare("UPDATE tasks SET status = 'cancelled' WHERE key = ?").run(task.key);
    await h.domain.ctx.events.emit('task_cancelled', { ...task, status: 'cancelled' });
  }
  await settle();
  await h.domain.memberQueueDriver.ensure('AR', 'pm');
  const current = (await h.domain.checklist.get('AR'))!.items.find((entry) => entry.id === 'team')!;
  expect(h.domain.memberQueue.view('AR', 'pm').closed).toContainEqual(
    expect.objectContaining({
      source: { type: 'checklist', noticeId: `reopen:team@${current.updatedAt}` },
      state: 'done',
      closeReason: 'delivered',
    }),
  );
  expect(h.runner.lastStarted().initialMessage).toContain(item.title);
});
