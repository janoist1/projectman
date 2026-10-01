import { afterEach, beforeEach, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type { InboxItem, InboxView, TaskDetail } from '@projectman/shared';
import { TEAM_TOOLS } from '../src/mcp';
import { humanActor } from '../src/domain';
import { createAppHarness, createProject, inject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { flush } from './helpers/fakes';

/**
 * What the owner and the decider see of a delegated permission question through the REST routes and
 * the team tool (PM-169): the app around the domain rules of permission-delegation.test.ts.
 */

let h: AppHarness;
let owner: string;
let sessionId: string;
let now = new Date('2026-10-01T11:00:00.000Z');

beforeEach(async () => {
  now = new Date('2026-10-01T11:00:00.000Z');
  h = await createAppHarness({ now: () => now });
  owner = await setupOwner(h.app);
  await createProject(h, owner);
  const { domain } = h.app.projectman;
  await domain.projects.update('AR', { actor: humanActor('owner'), author: OWNER_LOGIN }, (config) => {
    config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
    for (const member of config.team.members) {
      if (member.kind !== 'ai') continue;
      if (member.handle === 'cr') member.role = 'lead_developer';
      if (member.handle === 'dev-1') member.approver = 'ai';
    }
    return 'The reviewer decides for dev-1';
  });
  await domain.tasks.create('AR', { title: 'Example task', repo: 'web' }, humanActor('owner'));
  const started = await domain.taskStarts.start('AR', 'AR-1', {
    actor: humanActor('owner'),
    author: OWNER_LOGIN,
  });
  sessionId = started.session!.id;
});
afterEach(() => h.close());

const ask = (command: string, signal = new AbortController().signal) =>
  h.runnerModule.broker().decide({ sessionId, toolName: 'Bash', toolInput: { command }, raw: {} }, signal);
const inboxOf = async (query = '?state=all') =>
  (await inject(h.app, 'GET', `${routes.inbox('AR')}${query}`, owner)).json<InboxView>().items;
const decideTool = TEAM_TOOLS.find((t) => t.name === 'decide_permission_request')!;
const run = (member: string, args: Record<string, unknown>) =>
  decideTool.run({
    ctx: { projectKey: 'AR', member, sessionId, taskKey: 'AR-1' },
    args,
    handler: h.app.projectman.domain.teamTools,
  });

it('shows the owner the question as the decider’s, and then who decided it and why', async () => {
  const pending = ask('curl https://example.com/data.json');
  await flush();
  const [waiting] = await inboxOf('?state=open&kind=permission');
  expect(waiting).toMatchObject({ assignees: ['cr'], payload: { delegation: { state: 'pending_lead' } } });
  // Not among the owner's own, but the owner can still see it.
  expect(await inboxOf('?state=open&mine=true')).toEqual([]);

  const reason = 'A plain download inside the task.';
  const answer = JSON.parse(await run('cr', { request_id: waiting!.id, decision: 'allow', reason }));
  expect(answer).toMatchObject({ requestId: waiting!.id, decision: 'allow' });
  expect(await pending).toEqual({ behavior: 'allow' });

  const [decided] = await inboxOf('?state=resolved&kind=permission');
  expect(decided).toMatchObject({
    id: waiting!.id,
    resolution: { optionId: 'allow', by: 'cr', note: reason },
  });
  expect(decided!.assignees).toContain('owner');
  const task = await inject(h.app, 'GET', routes.task('AR', 'AR-1'), owner);
  expect(task.json<TaskDetail>().timeline.find((e) => e.type === 'permission_resolved')).toMatchObject({
    actor: { kind: 'ai', handle: 'cr' },
    data: { decision: 'allow', delegated: true, reason },
  });
  // Nobody resolves a closed item again, the owner included.
  const again = await inject(h.app, 'POST', routes.resolveInbox('AR', waiting!.id), owner, {
    optionId: 'deny',
  });
  expect(again.statusCode).toBe(409);
});

it('keeps the question with the decider for no one else: the tool refuses others and a late answer', async () => {
  const controller = new AbortController();
  const pending = ask('curl https://example.com/data.json', controller.signal);
  await flush();
  const [waiting] = await inboxOf('?state=open&kind=permission');
  const args = { request_id: waiting!.id, decision: 'allow', reason: 'Fine.' };
  await expect(run('dev-2', args)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(run('dev-1', args)).rejects.toMatchObject({ code: 'forbidden' });
  now = new Date('2026-10-01T11:03:00.000Z');
  await expect(run('cr', args)).rejects.toMatchObject({ code: 'forbidden' });
  // The owner has it now, and no answer from anyone else made it allowed.
  const [handed] = await inboxOf('?state=open&mine=true');
  expect(handed).toMatchObject({ id: waiting!.id, assignees: ['owner'] });
  controller.abort();
  expect((await pending).behavior).toBe('deny');
  const [expired] = await inboxOf('?state=expired&kind=permission');
  expect((expired as InboxItem).id).toBe(waiting!.id);
});

it('rejects a decision without a reason and an unknown decision before the domain', async () => {
  const schema = decideTool.inputSchema;
  expect(schema.safeParse({ request_id: 'inb_1', decision: 'allow' }).success).toBe(false);
  expect(schema.safeParse({ request_id: 'inb_1', decision: 'allow', reason: '  ' }).success).toBe(false);
  expect(schema.safeParse({ request_id: 'inb_1', decision: 'maybe', reason: 'x' }).success).toBe(false);
  expect(schema.safeParse({ request_id: 'inb_1', decision: 'escalate', reason: 'x' }).success).toBe(true);
});
