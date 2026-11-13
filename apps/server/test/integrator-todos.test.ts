import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  TODO_DONE_OPTION,
  TODO_CANNOT_OPTION,
  inboxRecipientOf,
  isIntegratorTodo,
  questionPayloadOf,
  routes,
  connectedActorOf,
} from '@projectman/shared';
import type { InboxItem, ResolveIntegratorTodoRequest } from '@projectman/shared';
import { projectAccessFor } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import { resolveIntegratorTodo } from '../src/services/super';
import {
  addHostAsOwnerMember,
  createAppHarness,
  createOwnerAccountWithProject,
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
  function asked(
    payload: Record<string, unknown> = {},
    kind: InboxItem['kind'] = 'question',
    projectKey = 'AR',
  ) {
    return h.app.projectman.domain.inbox.create({
      projectKey,
      kind,
      // The project manager has machine access by role (decision 66); a developer does not.
      source: 'pm',
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
  async function opened(payload: Record<string, unknown> = {}, projectKey = 'AR') {
    const item = asked(payload, 'question', projectKey);
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

  it('ignores the recipient named for a todo and keeps decision and fallback with the owner (PM-1243)', async () => {
    const override = asked({ requestedRecipient: 'owner' });
    const released = await h.app.projectman.domain.inbox.releaseScreened(override.id, {
      outcome: 'todo',
      by: 'pm',
      todo: { ...step, recipient: 'owner' },
      ownerTopic: 'cost',
      note: 'Owner step',
    });
    expect(released!.payload).toMatchObject({ requestedRecipient: 'owner', recipient: 'integrator' });
    expect(released!.payload).not.toHaveProperty('ownerTopic');
    const decision = await h.app.projectman.domain.inbox.releaseScreened(
      asked({ requestedRecipient: 'integrator' }).id,
      { outcome: 'decision', by: 'pm', ownerTopic: 'cost' },
    );
    expect(decision!.payload.recipient).toBe('owner');
    expect(decision!.payload.integratorOpenedAt).toBeUndefined();
    // A skipped screening keeps the integrator the asker named, while one is live; an owner request stays.
    for (const fallback of ['timeout', 'unavailable'] as const) {
      const kept = await h.app.projectman.domain.inbox.releaseScreened(
        asked({ requestedRecipient: 'integrator' }).id,
        { fallback },
      );
      expect(isIntegratorTodo(kept!)).toBe(true);
      expect(questionPayloadOf(kept!)?.screening).toMatchObject({ fallback, outcome: 'todo' });
      const owner = await h.app.projectman.domain.inbox.releaseScreened(
        asked({ requestedRecipient: 'owner' }).id,
        { fallback },
      );
      expect(owner!.payload.recipient).toBe('owner');
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
        actor: { kind: 'human', handle: 'owner', through: { holder: 'owner' } },
        optionId,
        note: 'Measured',
      });
      expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
      expect(events('question_answered')).toHaveLength(1);
      expect(events('question_answered')[0]).toMatchObject({
        actor: { handle: 'owner', through: { holder: 'owner' } },
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

  it('keeps a todo in the integrator’s queue with or without a live super key, and never gives it to the owners (PM-1246)', async () => {
    const live = await opened();
    h.app.projectman.auth.revokeIntegratorAccessKey(
      h.app.projectman.repos.users.list()[0]!.id,
      superKey.key.id,
    );
    const item = await opened();
    for (const todo of [live, item]) {
      expect(todo.payload).toMatchObject({ recipient: 'integrator' });
      expect(todo.payload.screening).not.toHaveProperty('recipientRefusal');
      expect(todo.route).toMatchObject({
        kind: 'screened_todo',
        to: 'integrator_queue',
        reason: 'machine_work',
      });
    }
    expect(h.app.projectman.domain.inbox.countOpenFor('AR', 'owner')).toBe(0);
    expect(events('item_routed').map((e) => e.data)).toContainEqual({
      itemId: item.id,
      kind: 'screened_todo',
      requested: 'owner',
      to: 'integrator_queue',
      reason: 'machine_work',
    });
  });

  it('keeps the todo of a project whose owners have no key in the queue, whoever else has a key (PM-1063, PM-1246)', async () => {
    await createOwnerAccountWithProject(h, cookie, 'BR');
    await addHostAsOwnerMember(h, 'BR');
    expect((await opened({}, 'BR')).payload).toMatchObject({ recipient: 'integrator' });
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
      await h.app.projectman.domain.inbox.releaseScreened(item.id, {
        outcome: 'decision',
        by: 'pm',
        ownerTopic: 'cost',
      });
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
          superActor: connectedActorOf('owner', {
            id: superKey.key.id,
            prefix: superKey.key.prefix,
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access' });
  });
});

it('still queues the todo for the integrator when no integrator access adapter was provided (PM-1246)', async () => {
  const h = await createDomainHarness();
  try {
    const item = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'pm',
      assignees: ['owner'],
      title: 'Measure',
      state: 'screening',
      payload: { question: 'Measure', screening: { until: START } },
      options: [],
    });
    const result = await h.domain.inbox.releaseScreened(item.id, { outcome: 'todo', todo: step, by: 'pm' });
    expect(result!.payload).toMatchObject({ recipient: 'integrator' });
    expect(result!.payload.screening).not.toHaveProperty('recipientRefusal');
  } finally {
    await h.cleanup();
  }
});

describe('the machine access of the screening member decides, not the asker’s', () => {
  const releaseAskedByDev = async (screenerMachineAccess: boolean | undefined) => {
    const h = await createDomainHarness({
      integratorTodoAccess: { available: () => true },
      adjust: (config) => {
        const pm = config.team.members.find((m) => m.handle === 'pm');
        if (pm?.kind === 'ai' && screenerMachineAccess !== undefined)
          pm.machineAccess = screenerMachineAccess;
      },
    });
    try {
      const item = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        source: 'dev-1',
        assignees: ['owner'],
        title: 'Measure',
        state: 'screening',
        payload: { question: 'Measure', requestedRecipient: 'integrator', screening: { until: START } },
        options: [],
      });
      const result = await h.domain.inbox.releaseScreened(item.id, { outcome: 'todo', todo: step, by: 'pm' });
      return result!;
    } finally {
      await h.cleanup();
    }
  };

  it('gives an asker without machine access the integrator when the screening member has it', async () => {
    const result = await releaseAskedByDev(undefined);
    expect(inboxRecipientOf(result)).toBe('integrator');
    expect(result.payload).toMatchObject({ recipient: 'integrator' });
    expect(result.payload.screening).not.toHaveProperty('recipientRefusal');
  });

  it('refuses the todo when the screening member has no machine access, and does not give it to the owners (PM-1246)', async () => {
    await expect(releaseAskedByDev(false)).rejects.toMatchObject({ code: 'issuer_without_machine_access' });
  });
});
