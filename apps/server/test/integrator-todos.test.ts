import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TODO_DONE_OPTION,
  TODO_CANNOT_OPTION,
  questionPayloadOf,
  routes,
  superActorOf,
} from '@projectman/shared';
import type { InboxItem, ResolveIntegratorTodoRequest } from '@projectman/shared';
import { projectAccessFor } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import { resolveIntegratorTodo } from '../src/services/super-operator';
import {
  createAppHarness,
  createProject,
  setupOwner,
  addHumanAndLogin,
  asSuperIntegrator,
  OWNER_LOGIN,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { createDomainHarness, restartDomainHarness } from './helpers/domain-harness';

const START = '2026-10-18T10:00:00.000Z';
const step = {
  what: 'Measure the hub',
  where: 'Hub',
  expected: 'Latency report',
  recipient: 'integrator' as const,
};

describe('integrator todo REST and durable lifecycle', () => {
  let h: AppHarness;
  let now: Date;
  let cookie: string;
  let superKey: ReturnType<AppHarness['app']['projectman']['auth']['createIntegratorAccessKey']>;
  beforeEach(async () => {
    now = new Date(START);
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
    const { auth, repos } = h.app.projectman;
    superKey = auth.createIntegratorAccessKey(repos.users.list()[0]!.id, { mode: 'super', expiresInDays: 7 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });
  const headers = () => ({ authorization: `Bearer ${superKey.secret}` });
  const current = (id: string) => h.app.projectman.domain.inbox.get('AR', id);
  function asked(payload: Record<string, unknown> = {}, kind: InboxItem['kind'] = 'question') {
    return h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind,
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Measure the hub',
      payload: {
        question: 'Measure the hub',
        requestedRecipient: 'owner',
        recipient: 'owner',
        screening: { until: START },
        ...payload,
      },
      state: 'screening',
      options: [{ id: 'answer', label: 'Answer', style: 'primary' }],
    });
  }
  async function opened(payload: Record<string, unknown> = {}) {
    const item = asked(payload);
    return (await h.app.projectman.domain.inbox.releaseScreened(item.id, {
      outcome: 'todo',
      by: 'pm',
      note: 'External technical work',
      todo: step,
    }))!;
  }
  /** The service the MCP tool calls, with the super key's access. */
  const resolveWith = async (id: string, body: Record<string, unknown>, access?: ProjectAccess) => {
    const call = (bound: ProjectAccess) =>
      resolveIntegratorTodo(h.app.projectman.domain, 'AR', id, body as ResolveIntegratorTodoRequest, bound);
    return access ? call(access) : asSuperIntegrator(h, superKey.secret, call);
  };
  const resolve = (id: string, optionId = 'todo_done', note?: string) =>
    resolveWith(id, { optionId, ...(note !== undefined ? { note } : {}) });
  const refusal = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (error: { code?: string }) => error.code,
    );
  const events = (type: string) => h.app.projectman.domain.timeline.list('AR').filter((e) => e.type === type);
  const journal = (id: string) =>
    h.app.projectman.repos.db
      .prepare("SELECT count(*) AS n FROM project_change_events WHERE kind = 'inbox' AND entity_id = ?")
      .get(id) as { n: number };

  it('addresses a system obligation todo to the integrator through the real credential adapter', async () => {
    const result = await h.app.projectman.domain.inbox.openIntegratorTodo({
      projectKey: 'AR',
      taskKey: null,
      askedBy: 'system',
      question: 'The project manager has not started a card',
      todo: step,
      obligation: { id: 'obl_start', kind: 'start', responsible: 'pm', openedAt: START },
    });
    expect(result).toMatchObject({ recipient: 'integrator', recipientRefusal: null });
    expect(questionPayloadOf(current(result.itemId))).toMatchObject({
      recipient: 'integrator',
      obligation: { kind: 'start' },
      screening: { outcome: 'todo', todo: { recipient: 'integrator' } },
    });
    expect(h.app.projectman.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
  });

  it('opens for the integrator with the actual opening clock, hides human counts and journals the change', async () => {
    const item = asked();
    now = new Date(now.getTime() + 120_000);
    await h.app.projectman.domain.inbox.releaseScreened(item.id, {
      outcome: 'todo',
      by: 'pm',
      note: 'Technical step',
      todo: step,
    });
    expect(questionPayloadOf(current(item.id))).toMatchObject({
      requestedRecipient: 'owner',
      recipient: 'integrator',
      integratorOpenedAt: now.toISOString(),
      screening: { todo: step },
    });
    expect(h.app.projectman.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    expect(
      (await h.app.inject({ url: routes.inbox('AR') + '?mine=true', headers: { cookie } })).json().items,
    ).toHaveLength(0);
    expect(
      (await h.app.inject({ url: routes.inbox('AR'), headers: headers() }))
        .json()
        .items.map((i: InboxItem) => i.id),
    ).toContain(item.id);
    expect(journal(item.id).n).toBeGreaterThan(1);
  });

  it('lets screening override proposals in both directions and keeps decision and fallback with the owner', async () => {
    const override = asked({ requestedRecipient: 'integrator' });
    const released = await h.app.projectman.domain.inbox.releaseScreened(override.id, {
      outcome: 'todo',
      by: 'pm',
      todo: { ...step, recipient: 'owner' },
      note: 'Owner step',
    });
    expect(released!.payload).toMatchObject({ requestedRecipient: 'integrator', recipient: 'owner' });
    for (const release of [
      { outcome: 'decision' as const, by: 'pm' },
      { fallback: 'timeout' as const },
      { fallback: 'unavailable' as const },
    ]) {
      const item = asked({ requestedRecipient: 'integrator' });
      const result = await h.app.projectman.domain.inbox.releaseScreened(item.id, release);
      expect(result!.payload.recipient).toBe('owner');
      expect(result!.payload.integratorOpenedAt).toBeUndefined();
    }
    expect((await opened({ requestedRecipient: 'owner' })).payload.recipient).toBe('integrator');
  });

  it.each(['todo_done', 'todo_cannot'] as const)(
    'resolves %s as the authenticated super actor and sends its own result once',
    async (optionId) => {
      const item = await opened();
      const before = journal(item.id).n;
      const { item: resolved } = await resolve(item.id, optionId, 'Measured');
      expect(resolved.resolution).toMatchObject({
        integratorTodo: true,
        via: 'integrator',
        by: 'owner',
        actor: { kind: 'ai', handle: 'operator', operatorMode: 'super' },
        optionId,
        note: 'Measured',
      });
      expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
      expect(events('question_answered')).toHaveLength(1);
      expect(events('question_answered')[0]).toMatchObject({
        actor: { handle: 'operator', operatorMode: 'super' },
        data: { integratorTodo: { optionId, note: 'Measured' } },
      });
      const answer = h.app.projectman.repos.messages
        .list('AR')
        .find((m) => m.origin?.kind === 'answer' && m.origin.inboxItemId === item.id);
      expect(answer).toMatchObject({ origin: { kind: 'answer', integratorTodo: true } });
      expect(answer?.body).toContain('not an owner answer');
      expect(journal(item.id).n).toBeGreaterThan(before);
      expect(await refusal(resolve(item.id))).toBe('inbox_item_closed');
    },
  );

  it('requires a cannot reason, validates strict DTOs and permits an empty done result', async () => {
    const item = await opened();
    for (const note of [undefined, '   '])
      expect(await refusal(resolve(item.id, 'todo_cannot', note))).toBe('todo_reason_required');
    for (const body of [
      { optionId: 'answer' },
      { optionId: 'todo_done', attachmentIds: [] },
      { optionId: 'todo_done', integratorTodo: true },
    ])
      expect(await refusal(resolveWith(item.id, body))).toBe('invalid_request');
    expect((await resolve(item.id, 'todo_done', '  ')).item.resolution?.note).toBeNull();
  });

  it('releases the waiting label only after the last integrator question has an answer', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Latency report', labels: ['waiting-answer'] },
      { kind: 'human', handle: 'owner' },
    );
    const items = [1, 2].map(() =>
      domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        taskKey: task.key,
        assignees: ['owner'],
        title: 'Measure',
        options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
        payload: {
          question: 'Measure',
          autoLabel: true,
          recipient: 'integrator',
          integratorOpenedAt: START,
          screening: { until: START, outcome: 'todo', todo: step },
        },
      }),
    );
    await resolve(items[0]!.id);
    expect(domain.tasks.get('AR', task.key).labels).toContain('waiting-answer');
    await resolve(items[1]!.id);
    expect(domain.tasks.get('AR', task.key).labels).not.toContain('waiting-answer');
  });

  it('refuses an access without a super actor', async () => {
    const item = await opened();
    const config = await h.app.projectman.domain.projects.config('AR');
    const own = projectAccessFor(config, OWNER_LOGIN.email)!;
    expect(await refusal(resolveWith(item.id, { optionId: 'todo_done' }, own))).toBe(
      'integrator_not_allowed',
    );
    expect(current(item.id).state).toBe('open');
  });

  it('preserves a manual waiting label when an integrator todo carried no autoLabel claim', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Manual hold', labels: ['waiting-answer'] },
      { kind: 'human', handle: 'owner' },
    );
    const item = domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      taskKey: task.key,
      assignees: ['owner'],
      title: 'Measure',
      options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
      payload: {
        question: 'Measure',
        recipient: 'integrator',
        integratorOpenedAt: START,
        screening: { until: START, outcome: 'todo', todo: step },
      },
    });
    await resolve(item.id);
    expect(domain.tasks.get('AR', task.key).labels).toContain('waiting-answer');
  });

  it('keeps normal resolve and relay closed to integrator todos, and permits the owner login', async () => {
    const item = await opened();
    for (const auth of [headers()]) {
      const response = await h.app.inject({
        method: 'POST',
        url: routes.resolveInbox('AR', item.id),
        headers: auth,
        payload: { optionId: 'todo_done' },
      });
      expect(response.json().error.code).toBe('super_relay_refused');
    }
    const relay = await h.app.inject({
      method: 'POST',
      url: routes.relayOwnerAnswer('AR', item.id),
      headers: headers(),
      payload: { answer: 'Done' },
    });
    expect(relay.json().error.code).toBe('super_relay_refused');
    const own = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', item.id),
      headers: { cookie },
      payload: { optionId: 'todo_done' },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect(own.json().resolution.integratorTodo).toBeUndefined();
    expect(events('question_answered')[0]?.actor).toEqual({ kind: 'human', handle: 'owner' });
  });

  it.each([
    'approvalLabel',
    'superOperation',
    'gate',
    'release',
    'permission',
    'boundary',
    'approval',
    'operatorApproval',
    'operatorKnowledge',
  ])('rejects raw protected %s and leaves it with the owner', async (key) => {
    const item = await opened({ [key]: null });
    expect(questionPayloadOf(item)?.recipient ?? item.payload.recipient).toBe('owner');
    expect(item.payload.integratorOpenedAt).toBeUndefined();
    expect((item.payload.screening as { recipientRefusal: string }).recipientRefusal).toBe(
      'protected_question',
    );
    expect(await refusal(resolve(item.id))).toBe(
      key === 'operatorKnowledge' ? 'not_found' : 'owner_approval_required',
    );
  });

  it('falls back to owner when the project has no Operator', async () => {
    const projects = h.app.projectman.domain.projects;
    const config = structuredClone(await projects.config('AR'));
    config.team.members = config.team.members.filter(
      (member) => member.kind !== 'ai' || member.role !== 'ai_operator',
    );
    vi.spyOn(projects, 'config').mockResolvedValue(config);
    const item = await opened();
    expect(item.payload).toMatchObject({
      recipient: 'owner',
      screening: { recipientRefusal: 'integrator_unavailable' },
    });
    expect(await refusal(resolve(item.id))).toBe('insufficient_access');
  });

  it('keeps a todo for the Operator without any super access key', async () => {
    h.app.projectman.auth.revokeIntegratorAccessKey(
      h.app.projectman.repos.users.list()[0]!.id,
      superKey.key.id,
    );
    const item = await opened();
    expect(item.payload).toMatchObject({ recipient: 'integrator' });
    expect(item.payload.screening).not.toHaveProperty('recipientRefusal');
  });

  it('never delivers an integrator-origin item to other humans in REST or websocket projection', async () => {
    const item = await opened();
    for (const access of ['admin', 'developer', 'client', 'viewer'] as const) {
      const login = await addHumanAndLogin(h.app, {
        handle: `person-${access}`,
        email: `${access}@example.test`,
        name: access,
        access,
      });
      const response = await h.app.inject({ url: routes.inbox('AR'), headers: { cookie: login } });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().items.map((i: InboxItem) => i.id)).not.toContain(item.id);
    }
  });

  it('rolls back the answer, resolution, timeline and journal together on a failed close', async () => {
    const item = await opened();
    const { domain, repos } = h.app.projectman;
    const before = { journal: journal(item.id).n, messages: repos.messages.list('AR').length };
    const append = domain.timeline.append.bind(domain.timeline);
    vi.spyOn(domain.timeline, 'append').mockImplementation((input) => {
      if (input.type === 'question_answered') throw new Error('injected timeline failure');
      return append(input);
    });
    await expect(resolve(item.id)).rejects.toThrow('injected timeline failure');
    expect(current(item.id).state).toBe('open');
    expect(journal(item.id).n).toBe(before.journal);
    expect(repos.messages.list('AR')).toHaveLength(before.messages);
    expect(events('question_answered')).toHaveLength(0);
  });

  it('refuses old, plain information, decision and escalated todos with the original codes', async () => {
    for (const payload of [{}, { responsePurpose: 'information' }]) {
      const item = asked(payload);
      await h.app.projectman.domain.inbox.releaseScreened(item.id, { outcome: 'decision', by: 'pm' });
      expect(await refusal(resolve(item.id))).toBe('super_relay_refused');
    }
    const item = h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind: 'decision',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Approve',
      payload: {},
      options: [TODO_DONE_OPTION],
    });
    expect(await refusal(resolve(item.id))).toBe('owner_approval_required');
  });

  it('does not escalate a todo to the owners after a day: the Operator’s queue has no timeout', async () => {
    const item = await opened();
    now = new Date(now.getTime() + 86_400_000);
    await resolve(item.id);
    expect(events('question_recipient_escalated')).toHaveLength(0);
  });

  it('rechecks credentials immediately before durable closure and refuses forged actors', async () => {
    const item = await opened();
    const { domain, auth, repos } = h.app.projectman;
    domain.inbox.registerQuestionAnswer(async (_item, _attachments, close) => {
      auth.revokeIntegratorAccessKey(repos.users.list()[0]!.id, superKey.key.id);
      return close();
    });
    expect(await refusal(resolve(item.id))).toBe('integrator_key_invalid');
    expect(current(item.id).state).toBe('open');
    expect(events('question_answered')).toHaveLength(0);
    await expect(
      domain.inbox.resolveIntegratorTodo(
        'AR',
        item.id,
        { optionId: 'todo_done' },
        {
          handle: 'owner',
          access: 'owner',
          via: 'integrator',
          superActor: superActorOf(await domain.projects.config('AR'), {
            id: superKey.key.id,
            prefix: superKey.key.prefix,
          })!,
        },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
  });
});

it('defaults to unavailable when no integrator access adapter was provided', async () => {
  const h = await createDomainHarness();
  try {
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      title: 'Measure',
      state: 'screening',
      payload: { question: 'Measure', screening: { until: START } },
      options: [],
    });
    const result = await h.domain.inbox.releaseScreened(item.id, { outcome: 'todo', todo: step, by: 'pm' });
    expect(result!.payload).toMatchObject({
      recipient: 'owner',
      screening: { recipientRefusal: 'integrator_unavailable' },
    });
  } finally {
    await h.cleanup();
  }
});
