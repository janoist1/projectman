import { routes } from '@projectman/shared';
import type { ChatItem, InboxItem, Task, TaskDetail } from '@projectman/shared';
import { afterEach, expect, it, vi } from 'vitest';
import { TEAM_TOOLS } from '../src/mcp';
import { waitFor } from '../src/runner/test-helpers';
import { createAppHarness, createProject, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import type { CliAppHarness } from './helpers/app-harness';

/**
 * "When it asks, an AI decides" (PM-169) through the real runner and the fake claude: a question of
 * a member whose approver is `ai` reaches its decider, whose answer the CLI gets; what is one of the
 * owner's categories reaches the owner, whoever the approver is.
 */

let h: CliAppHarness | undefined;
// Each phase includes fake CLI/hooks starting on the test host. Poll conditions rather than sleeping.
const PHASE_TIMEOUT_MS = 30_000;
// Startup, question, decider wake-up and transcript delivery each have their own phase budget.
const TEST_TIMEOUT_MS = 5 * PHASE_TIMEOUT_MS;

afterEach(async () => {
  await h?.close();
  h = undefined;
});

const text = (chat: ChatItem[]) => JSON.stringify(chat);

async function startAsking(command: string) {
  // The fake CLI asks about this command when its prompt says PERMISSION.
  vi.stubEnv('FAKE_CLAUDE_PERMISSION_COMMAND', command);
  h = await createAppHarness({ runner: 'fake-cli' });
  const { app } = h;
  const cookie = await setupOwner(app);
  await createProject(h, cookie);
  const { domain } = app.projectman;
  await domain.projects.update(
    'AR',
    { actor: { kind: 'human', handle: 'owner' }, author: OWNER_LOGIN },
    (config) => {
      config.team.boundary = { enabled: true, leadTimeoutSeconds: 120 };
      for (const member of config.team.members) {
        if (member.kind !== 'ai') continue;
        if (member.handle === 'cr') member.role = 'lead_developer';
        if (member.handle === 'dev-1') member.approver = 'ai';
      }
      return 'The reviewer decides for dev-1';
    },
  );
  const created = await app.inject({
    method: 'POST',
    url: routes.tasks('AR'),
    headers: { cookie },
    payload: { title: 'Acme checkout', repo: 'web' },
  });
  const { key } = created.json<Task>();
  const started = await app.inject({
    method: 'POST',
    url: routes.startTask('AR', key),
    headers: { cookie },
    payload: { assignee: 'dev-1' },
  });
  expect(started.statusCode, started.body).toBe(200);
  const session = started.json<TaskDetail>().sessions[0]!;
  await waitFor(() => domain.sessions.get('AR', session.id).state === 'idle', {
    what: 'dev-1 idle',
    timeoutMs: PHASE_TIMEOUT_MS,
  });
  const written = await app.inject({
    method: 'POST',
    url: routes.sessionMessages('AR', session.id),
    headers: { cookie },
    payload: { text: 'PERMISSION please' },
  });
  expect(written.statusCode).toBe(202);
  const open = (): InboxItem | undefined => domain.inbox.list('AR', { kind: 'permission', state: 'open' })[0];
  await waitFor(() => open() !== undefined, {
    what: 'the permission question',
    timeoutMs: PHASE_TIMEOUT_MS,
  });
  const chat = async () => text((await domain.sessions.detail('AR', session.id)).chat);
  return { app, cookie, domain, key, session, item: open()!, chat };
}

it.each([
  ['allow', 'Everything up-to-date'],
  ['deny', 'Denied by cr: The task does not need this download.'],
] as const)(
  'gives the decider’s %s to the fake CLI',
  { timeout: TEST_TIMEOUT_MS },
  async (decision, seen) => {
    const { domain, key, session, item, chat } = await startAsking('curl https://example.com/data.json');
    expect(item).toMatchObject({ source: 'dev-1', assignees: ['cr'], taskKey: key });
    expect(item.payload).toMatchObject({
      toolInput: { command: 'curl https://example.com/data.json' },
      delegation: { state: 'pending_lead', leads: ['cr'] },
    });
    expect(domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    // The decider is woken at the desk, with no card and no workspace: it has a session of its own.
    await waitFor(
      () => domain.sessions.list('AR', { member: 'cr' }).some((s) => s.workItem.type === 'general'),
      {
        what: 'the decider’s desk session',
        timeoutMs: PHASE_TIMEOUT_MS,
      },
    );
    expect(domain.sessions.list('AR', { member: 'cr', taskKey: key })).toHaveLength(0);
    const tool = TEAM_TOOLS.find((t) => t.name === 'decide_permission_request')!;
    const reason =
      decision === 'allow' ? 'A plain download inside the task.' : 'The task does not need this download.';
    await tool.run({
      ctx: { projectKey: 'AR', member: 'cr', sessionId: 'cr-session', taskKey: key },
      args: { request_id: item.id, decision, reason },
      handler: h!.app.projectman.domain.teamTools,
    });
    await vi.waitFor(async () => expect(await chat()).toContain(seen), { timeout: PHASE_TIMEOUT_MS });
    const timeline = domain.timeline.list('AR', { taskKey: key });
    expect(timeline.filter((e) => e.type.startsWith('permission_')).map((e) => e.type)).toEqual([
      'permission_requested',
      'permission_resolved',
    ]);
    expect(timeline.find((e) => e.type === 'permission_resolved')).toMatchObject({
      actor: { kind: 'ai', handle: 'cr' },
      sessionId: session.id,
      data: { decision, delegated: true, reason },
    });
    expect(domain.inbox.get('AR', item.id).resolution).toMatchObject({
      optionId: decision,
      by: 'cr',
      note: reason,
    });
    expect(domain.memberQueue.view('AR', 'cr').closed).toMatchObject([{ kind: 'permission', state: 'done' }]);
  },
);

it(
  'sends a question in one of the owner’s categories to the owner, who answers it',
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const { app, cookie, domain, key, item, chat } = await startAsking('git push origin main');
    expect(item).toMatchObject({ assignees: ['owner'], payload: { ownerCategory: 'production' } });
    expect(item.payload).not.toHaveProperty('delegation');
    expect(domain.sessions.list('AR', { member: 'cr' })).toHaveLength(0);
    expect(domain.memberQueue.view('AR', 'cr').items).toEqual([]);
    const resolved = await app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers: { cookie },
      payload: { optionId: 'allow' },
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    await vi.waitFor(async () => expect(await chat()).toContain('Everything up-to-date'), {
      timeout: PHASE_TIMEOUT_MS,
    });
    expect(
      domain.timeline.list('AR', { taskKey: key }).find((e) => e.type === 'permission_resolved'),
    ).toMatchObject({ actor: { kind: 'human', handle: 'owner' } });
  },
);
