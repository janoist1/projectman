import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectedActorOf, TODO_CANNOT_OPTION, TODO_DONE_OPTION } from '@projectman/shared';
import type { ConnectedActor, InboxOption, NewSuperCommand, SuperOperation } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { bindSuperPrincipal } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import { DomainError, integratorExecution, runIntegratorExecution } from '../src/kernel';
import { relayOwnerAnswer } from '../src/services/super-operator';
import type { SuperCommandExecutor, SuperExecutorJob } from '../src/services/super-operator';

const SECRET = 'pmi_handoff_fixture';
const KEY = { id: 'ikey_handoff_1', prefix: 'pmi_handoff1' };
const SECOND_SECRET = 'pmi_handoff_second';
const SECOND_KEY = { id: 'ikey_handoff_2', prefix: 'pmi_handoff2' };
const HOUR = 60 * 60 * 1000;
const SUPER_ACTOR: ConnectedActor = connectedActorOf('owner', { id: KEY.id, prefix: KEY.prefix });

// The integrator starts them with the owner's token. Fictional commands only.
const PAUSE: NewSuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };
const RESUME: NewSuperCommand = { kind: 'operate', operation: { op: 'project_resume' } };
const RETIRE: NewSuperCommand ={ kind: 'operate', operation: { op: 'member_retire', handle: 'dev-1' } };

describe('super-mode operations (PM-762, PM-764)', () => {
  let h: DomainHarness;
  let clock: Date;
  const created = new Set<string>();
  afterEach(() => h?.cleanup());

  const boot = async (opts: Parameters<typeof createDomainHarness>[0] = {}) => {
    created.clear();
    clock = new Date('2026-10-17T10:00:00.000Z');
    h = await createDomainHarness({ now: () => clock, ...opts });
    return h;
  };

  const ensureKey = (secret = SECRET, key = KEY) => {
    let user = h.repos.users.list()[0];
    if (!user) {
      user = {
        id: 'user-1',
        name: OWNER.name,
        email: OWNER.email,
        passwordHash: 'unused-test-hash',
        createdAt: clock.toISOString(),
      };
      h.repos.users.insert(user);
    }
    // A revoked key stays revoked: only a key never created here is created.
    if (!created.has(key.id)) {
      created.add(key.id);
      h.repos.integratorKeys.create({
        id: key.id,
        userId: user.id,
        prefix: key.prefix,
        hash: createHash('sha256').update(secret).digest('hex'),
        mode: 'super',
        at: clock.toISOString(),
        expiresAt: null,
      });
    }
    return secret;
  };

  /** Runs `body` as the integrator: authenticated by the owner's token, bound to the owner's access. */
  const asIntegrator = async <T>(
    body: (access: ProjectAccess) => Promise<T>,
    opts: {
      secret?: string;
      key?: typeof KEY;
      afterResolve?: () => void;
      requestOrigin?: 'owner' | 'member';
    } = {},
  ): Promise<T> => {
    const secret = ensureKey(opts.secret ?? SECRET, opts.key ?? KEY);
    const principal = h.auth.resolveIntegratorCredential(secret, 'rest')!;
    opts.afterResolve?.();
    const config = await h.domain.projects.config('AR');
    const access = bindSuperPrincipal(
      config,
      { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess,
      principal,
    );
    return h.domain.superOperator.run(
      { principal, email: OWNER.email, requestId: randomUUID(), projectKey: 'AR' },
      () => {
        const { requestOrigin } = opts;
        const context = integratorExecution();
        if (!requestOrigin || !context) return body(access);
        // The stored-key principal is frozen and registered as issued: the origin an app session's open request
        // gives is put on a scope nested inside it.
        return runIntegratorExecution(
          {
            active: true,
            context: { ...context, principal: { ...context.principal, requestOrigin } },
            actorFor: () => context.actor,
            assertAccess: () => undefined,
            assertMutation: () => {},
            authorizeMutation: async () => {},
          },
          () => body(access),
        );
      },
    );
  };

  const operate = (
    command: NewSuperCommand,
    requestId: string = randomUUID(),
    opts: Parameters<typeof asIntegrator>[1] = {},
  ) => asIntegrator((access) => h.domain.superHandoffs.operate('AR', { requestId, command }, access), opts);

  const answerAsOwner = (itemId: string, optionId: 'yes' | 'no') =>
    h.domain.inbox.resolve('AR', itemId, { optionId }, { handle: 'owner', access: 'owner' });

  const calls: SuperExecutorJob[] = [];
  const succeed: SuperCommandExecutor = async (job) => {
    calls.push(job);
  };
  const withExecutors = (executor: SuperCommandExecutor = succeed) => {
    calls.length = 0;
    h.domain.superHandoffs.registerExecutor('operate', executor);
  };

  const stored = (id: string) => h.domain.superHandoffs.operation('AR', id);

  describe('without an owner-reserved effect', () => {
    it('runs on the integrator`s own power and is idempotent on the request id', async () => {
      await boot();
      withExecutors();
      const requestId = randomUUID();
      const operation = await operate(PAUSE, requestId);
      expect(operation).toMatchObject({
        state: 'succeeded',
        handoffId: null,
        requestId,
        ownerQuestionId: null,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toEqual(PAUSE);
      // The same request again is the same result, never a second run.
      expect((await operate(PAUSE, requestId)).id).toBe(operation.id);
      expect(calls).toHaveLength(1);
      expect(h.repos.timeline.list('AR').some((e) => e.type === 'super_operation_changed')).toBe(true);
    });

    it('refuses another command under a used request id', async () => {
      await boot();
      withExecutors();
      const requestId = randomUUID();
      await operate(PAUSE, requestId);
      await expect(operate(RESUME, requestId)).rejects.toMatchObject({
        code: 'super_request_conflict',
        status: 409,
      });
      expect(calls).toHaveLength(1);
    });

    it('is refused without the owner`s super token and without a bound access', async () => {
      await boot();
      withExecutors();
      const bare = { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess;
      const input = { requestId: randomUUID(), command: PAUSE };
      await expect(h.domain.superHandoffs.operate('AR', input, bare)).rejects.toMatchObject({
        code: 'integrator_not_allowed',
      });
      await expect(
        asIntegrator((access) =>
          h.domain.superHandoffs.operate('AR', input, { ...access, superActor: undefined }),
        ),
      ).rejects.toMatchObject({ code: 'integrator_not_allowed' });
      expect(calls).toHaveLength(0);
    });

    it('refuses what it cannot classify, and runs nothing (fail closed)', async () => {
      await boot();
      withExecutors();
      await expect(
        operate({
          kind: 'operate',
          operation: { op: 'member_update', handle: 'ghost', changes: { effort: 'high' } },
        }),
      ).rejects.toMatchObject({ code: 'integrator_not_allowed', status: 403 });
      expect(calls).toHaveLength(0);
    });

    it('records a refusal of the executor as failed and anything else as unknown', async () => {
      await boot();
      withExecutors(async () => {
        throw new DomainError('administration_failed', 'refused', { status: 409 });
      });
      expect(await operate(PAUSE)).toMatchObject({ state: 'failed', errorCode: 'administration_failed' });

      withExecutors(async () => {
        throw new Error('boom');
      });
      const requestId = randomUUID();
      expect(await operate(RESUME, requestId)).toMatchObject({
        state: 'unknown',
        errorCode: 'operation_unknown',
      });
      // What may have had an effect is never run again by itself.
      withExecutors();
      expect((await operate(RESUME, requestId)).state).toBe('unknown');
      expect(calls).toHaveLength(0);
    });
  });

  describe('an owner-reserved effect', () => {
    const waiting = async () => {
      withExecutors();
      const requestId = randomUUID();
      const operation = await operate(RETIRE, requestId);
      return { requestId, operation };
    };

    it('opens a question for the owner and runs nothing before the owner`s yes', async () => {
      await boot();
      const { operation } = await waiting();
      expect(operation).toMatchObject({ state: 'waiting_owner' });
      expect(operation.ownerQuestionId).toBeTruthy();
      expect(calls).toHaveLength(0);
      const question = h.domain.inbox.get('AR', operation.ownerQuestionId!);
      expect(question).toMatchObject({ kind: 'question', state: 'open', assignees: ['owner'] });
      expect(question.payload).toMatchObject({
        responsePurpose: 'owner_decision',
        superOperation: { operationId: operation.id },
      });
      const bound = (
        question.payload as { superOperation: { expiresAt: string; expectedConfigVersion: string } }
      ).superOperation;
      expect(Date.parse(bound.expiresAt)).toBe(clock.getTime() + 24 * HOUR);
      expect(bound.expectedConfigVersion).toBe((await h.domain.projects.load('AR')).version);
    });

    describe('a change of who holds an approval (PM-1010)', () => {
      // The test template's `code-review-ok` is set by the code review duty.
      const GIVE_DEVELOPERS_REVIEW: NewSuperCommand = {
        kind: 'operate',
        operation: {
          op: 'config_patch',
          patch: {
            roleOverrides: { developer: { duties: ['implementation', 'code_review'], instructions: '' } },
          },
        },
      };

      it('waits for the owner when a member`s request would make a role hold an approval', async () => {
        await boot();
        withExecutors();
        const operation = await operate(GIVE_DEVELOPERS_REVIEW, randomUUID(), { requestOrigin: 'member' });
        expect(operation).toMatchObject({ state: 'waiting_owner' });
        expect(calls).toHaveLength(0);
      });

      it('runs it on the owner`s own request', async () => {
        await boot();
        withExecutors();
        const operation = await operate(GIVE_DEVELOPERS_REVIEW, randomUUID(), { requestOrigin: 'owner' });
        expect(operation).toMatchObject({ state: 'succeeded' });
        expect(calls).toHaveLength(1);
      });
    });

    it('runs after the owner`s own yes, the same request id, and lets the reserved effect pass only then', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      const config = await h.domain.projects.config('AR');
      const mutation = {
        projectKey: 'AR',
        actor: SUPER_ACTOR,
        previous: config,
        command: { kind: 'remove' as const, resource: 'member' as const, id: 'dev-1' },
      };
      await expect(h.domain.superHandoffs.authorizer.assertAllowed(mutation)).rejects.toMatchObject({
        code: 'owner_approval_required',
      });

      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      expect(stored(operation.id).state).toBe('pending');
      expect(calls).toHaveLength(0);

      let inside = false;
      withExecutors(async (job) => {
        calls.push(job);
        await h.domain.superHandoffs.authorizer.assertAllowed(mutation);
        // Another effect, or another project, is still refused inside the grant.
        await expect(
          h.domain.superHandoffs.authorizer.assertAllowed({ ...mutation, projectKey: 'ZZ' }),
        ).rejects.toMatchObject({ code: 'owner_approval_required' });
        inside = true;
      });
      const done = await operate(RETIRE, requestId);
      expect(done).toMatchObject({ id: operation.id, state: 'succeeded' });
      expect(inside).toBe(true);
      expect(calls).toHaveLength(1);
      await expect(h.domain.superHandoffs.authorizer.assertAllowed(mutation)).rejects.toMatchObject({
        code: 'owner_approval_required',
      });
      // Repeating the request is the same result and no second run.
      expect((await operate(RETIRE, requestId)).id).toBe(operation.id);
      expect(calls).toHaveLength(1);
    });

    it('lets two clients resuming at once run it only once', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      withExecutors(async (job) => {
        calls.push(job);
        await gate;
      });
      const first = operate(RETIRE, requestId);
      const second = operate(RETIRE, requestId).catch((error: unknown) => error);
      await flush();
      release();
      expect((await first).state).toBe('succeeded');
      await second;
      expect(calls).toHaveLength(1);
    });

    it('carries the approver on the step that runs after the owner`s yes, and only then', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      await operate(RETIRE, requestId);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.access.superActor).toMatchObject({
        through: { holder: 'owner' },
        approvedBy: 'owner',
      });

      await operate(PAUSE);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.access.superActor?.through?.holder).toBe('owner');
      expect(calls[1]!.access.superActor?.approvedBy).toBeUndefined();
    });

    it('is not answered by the token, a relay or anyone but an owner`s own login', async () => {
      await boot();
      const { operation } = await waiting();
      const id = operation.ownerQuestionId!;
      const resolve = (by: Parameters<typeof h.domain.inbox.resolve>[3]) =>
        h.domain.inbox.resolve('AR', id, { optionId: 'yes' }, by);
      await expect(
        asIntegrator(() =>
          resolve({ handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER_ACTOR }),
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
      await expect(
        asIntegrator(() => resolve({ handle: 'owner', access: 'owner', via: 'integrator' })),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
      await expect(resolve({ handle: 'dev-1', access: 'developer' })).rejects.toBeInstanceOf(DomainError);
      expect(h.domain.inbox.get('AR', id).state).toBe('open');
      expect(stored(operation.id).state).toBe('waiting_owner');
    });

    it('cancels on the owner`s no and frees nothing to run', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'no');
      expect(stored(operation.id)).toMatchObject({ state: 'cancelled', errorCode: 'owner_declined' });
      expect((await operate(RETIRE, requestId)).state).toBe('cancelled');
      expect(calls).toHaveLength(0);
    });

    it('expires after 24 hours: the question lapses and a new request id asks again', async () => {
      await boot();
      const { operation } = await waiting();
      clock = new Date(clock.getTime() + 24 * HOUR + 1000);
      // An answer that arrives after the deadline, before anything swept, is refused.
      await expect(answerAsOwner(operation.ownerQuestionId!, 'yes')).rejects.toMatchObject({
        code: 'super_operation_expired',
      });
      h.domain.superHandoffs.sweep();
      expect(stored(operation.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'super_operation_expired',
      });
      expect(h.domain.inbox.get('AR', operation.ownerQuestionId!).state).toBe('expired');
      // The owner's late yes cannot revive it.
      await expect(answerAsOwner(operation.ownerQuestionId!, 'yes')).rejects.toMatchObject({
        code: 'inbox_item_closed',
      });
      const next = await operate(RETIRE);
      expect(next).toMatchObject({ state: 'waiting_owner' });
      expect(next.id).not.toBe(operation.id);
    });

    it('refuses the yes when the configuration changed after the owner was asked', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      const version = (await h.domain.projects.load('AR')).version;
      await h.domain.projects.patch(
        'AR',
        { baseVersion: version, project: { name: 'Fictional renamed project' } },
        { actor: OWNER_ACTOR, author: { ...OWNER } },
      );
      withExecutors();
      await expect(operate(RETIRE, requestId)).rejects.toMatchObject({
        code: 'super_operation_stale',
        status: 409,
      });
      expect(calls).toHaveLength(0);
      expect(stored(operation.id)).toMatchObject({ state: 'cancelled', errorCode: 'super_operation_stale' });
    });

    it('refuses to start when the token was revoked, and a new token cannot use the old yes', async () => {
      await boot();
      const { requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      // Revoked after the request was authenticated, before the start: the service checks the key again.
      withExecutors();
      await expect(
        operate(RETIRE, requestId, {
          afterResolve: () => h.repos.integratorKeys.revokeById('user-1', KEY.id, clock.toISOString()),
        }),
      ).rejects.toMatchObject({ code: 'integrator_key_invalid' });
      expect(calls).toHaveLength(0);
      expect(stored(operation.id).state).toBe('pending');
      // Another token, even with the same request id, is not the one the owner agreed to.
      expect(await operate(RETIRE, requestId, { secret: SECOND_SECRET, key: SECOND_KEY })).toMatchObject({
        state: 'waiting_owner',
      });
      expect(calls).toHaveLength(0);
      expect(stored(operation.id).state).toBe('pending');
    });
  });

  describe('restart', () => {
    it('marks what was running unknown, never runs it again, and keeps a waiting operation waiting', async () => {
      await boot({ persistent: true });
      let started: () => void = () => undefined;
      const hasStarted = new Promise<void>((resolve) => (started = resolve));
      withExecutors(async () => {
        started();
        await new Promise<void>(() => undefined);
      });
      const requestId = randomUUID();
      void operate(PAUSE, requestId).catch(() => undefined);
      await hasStarted;
      const running = h.repos.superHandoffs.operationByRequest('AR', KEY.id, requestId)!;
      expect(running.state).toBe('running');

      withExecutors();
      const waitingOp = await operate(RETIRE);
      expect(waitingOp.state).toBe('waiting_owner');

      h = await restartDomainHarness(h, { now: () => clock });
      expect(stored(running.id)).toMatchObject({ state: 'unknown', errorCode: 'operation_unknown' });
      expect(stored(waitingOp.id).state).toBe('waiting_owner');

      withExecutors();
      expect((await operate(PAUSE, requestId)).state).toBe('unknown');
      expect(calls).toHaveLength(0);
    });
  });

  describe('Operator decisions and information relays', () => {
    const ask = (
      payload: Record<string, unknown>,
      options: InboxOption[] = [{ id: 'answer', label: 'answer', style: 'primary' }],
    ) =>
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        title: 'Fictional question',
        payload: { question: 'Which fictional port?', ...payload },
        options,
      });

    it('is marked relayed and does not count as the owner`s own decision', async () => {
      await boot();
      const question = ask({ responsePurpose: 'information' });
      const relayed = await asIntegrator(() =>
        h.domain.inbox.resolve(
          'AR',
          question.id,
          { optionId: 'answer', note: 'Port 4700.' },
          { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER_ACTOR },
        ),
      );
      expect(relayed.resolution).toMatchObject({ ownerAnswerRelayed: true, via: 'integrator' });
      await flush();
      const own = ask({ responsePurpose: 'information' });
      const decided = await h.domain.inbox.resolve(
        'AR',
        own.id,
        { optionId: 'answer', note: 'Port 4700.' },
        { handle: 'owner', access: 'owner' },
      );
      expect(decided.resolution?.ownerAnswerRelayed).toBeUndefined();
    });

    const resolveAsOperator = (id: string, optionId = 'answer') =>
      asIntegrator(() =>
        h.domain.inbox.resolve(
          'AR',
          id,
          { optionId, note: 'A fictional answer.' },
          { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER_ACTOR },
        ),
      );

    const nonRelayQuestions = [
      {
        name: 'an approval label',
        payload: { responsePurpose: 'information', approvalLabel: 'qa-ok' },
        options: undefined,
      },
      {
        name: 'a screened todo',
        payload: {
          responsePurpose: 'information',
          screening: {
            until: '2026-01-01T00:00:00.000Z',
            outcome: 'todo',
            todo: { what: 'Fictional step', where: 'Fictional place', expected: 'Fictional result' },
          },
        },
        options: undefined,
      },
      {
        name: 'todo options',
        payload: { responsePurpose: 'information' },
        options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
      },
    ];

    it.each(nonRelayQuestions)(
      'decides a question with $name as the Operator',
      async ({ payload, options }) => {
        await boot();
        const question = ask(payload, options);
        const resolved = await resolveAsOperator(question.id, question.options[0]!.id);
        expect(resolved).toMatchObject({
          state: 'resolved',
          resolution: { by: 'owner', via: 'integrator', actor: SUPER_ACTOR, superDecision: true },
        });
        expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
      },
    );

    it.each(nonRelayQuestions)('refuses to relay a question with $name', async ({ payload, options }) => {
      await boot();
      const question = ask(payload, options);
      await expect(
        asIntegrator((access) =>
          relayOwnerAnswer(
            { inbox: h.domain.inbox, tasks: h.domain.tasks },
            'AR',
            question.id,
            'A fictional answer.',
            access,
          ),
        ),
      ).rejects.toMatchObject({ code: 'super_relay_refused' });
      expect(h.domain.inbox.get('AR', question.id).state).toBe('open');
    });

    it('closes an owner decision question group with the same Operator decision', async () => {
      await boot();
      const decision = ask({ responsePurpose: 'owner_decision' });
      const unmarked = ask({});
      const itemIds = [decision.id, unmarked.id];
      const question = 'Fictional combined question';
      h.repos.inbox.createGroup({
        primaryItemId: decision.id,
        projectKey: 'AR',
        question,
        by: 'pm',
        note: 'Both questions need the same owner decision.',
        itemIds,
        at: '2026-01-01T00:00:00.000Z',
      });
      const resolved = await resolveAsOperator(decision.id);
      expect(resolved.resolution).toMatchObject({
        by: 'owner',
        via: 'integrator',
        actor: SUPER_ACTOR,
        superDecision: true,
      });
      expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
      for (const id of itemIds)
        expect(h.domain.inbox.get('AR', id)).toMatchObject({
          state: 'resolved',
          resolution: resolved.resolution,
        });
    });

    it('cannot answer the owner`s question about a super operation, whatever its purpose says', async () => {
      await boot();
      withExecutors();
      const operation = await operate(RETIRE);
      await expect(
        asIntegrator(() =>
          h.domain.inbox.resolve(
            'AR',
            operation.ownerQuestionId!,
            { optionId: 'yes' },
            { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER_ACTOR },
          ),
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
    });
  });

  it('exposes the operation record without secrets', async () => {
    await boot();
    withExecutors();
    const operation: SuperOperation = await operate(PAUSE);
    expect(JSON.stringify(operation)).not.toContain(SECRET);
    expect(Object.keys(operation).sort()).toEqual(
      [
        'command',
        'createdAt',
        'errorCode',
        'handoffId',
        'id',
        'ownerQuestionId',
        'projectKey',
        'requestId',
        'state',
        'taskKey',
        'updatedAt',
      ].sort(),
    );
  });
});
