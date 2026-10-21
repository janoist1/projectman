import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { TODO_CANNOT_OPTION, TODO_DONE_OPTION } from '@projectman/shared';
import type { InboxOption, SuperActor, SuperCommand, SuperOperation } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { bindSuperPrincipal } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import { DomainError } from '../src/kernel';
import { relayOwnerAnswer } from '../src/services/super-operator';
import type { SuperCommandExecutor, SuperExecutorJob } from '../src/services/super-operator';

const SECRET = 'pmi_handoff_fixture';
const KEY = { id: 'ikey_handoff_1', prefix: 'pmi_handoff1' };
const SECOND_SECRET = 'pmi_handoff_second';
const SECOND_KEY = { id: 'ikey_handoff_2', prefix: 'pmi_handoff2' };
const HOUR = 60 * 60 * 1000;
const SUPER_ACTOR: SuperActor = {
  kind: 'ai',
  handle: 'operator',
  via: 'integrator',
  operatorMode: 'super',
  credential: { id: KEY.id, prefix: KEY.prefix },
};

// The Operator asks (no token); the integrator executes (with the owner's token). Fictional commands only.
const PAUSE: SuperCommand = { kind: 'operate', operation: { op: 'project_pause' } };
const RETIRE: SuperCommand = { kind: 'operate', operation: { op: 'member_retire', handle: 'dev-1' } };

describe('durable super-mode handoff (PM-762)', () => {
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
    opts: { secret?: string; key?: typeof KEY; requestId?: string; afterResolve?: () => void } = {},
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
      { principal, email: OWNER.email, requestId: opts.requestId ?? randomUUID(), projectKey: 'AR' },
      () => body(access),
    );
  };

  const request = (
    command: SuperCommand,
    extra: Partial<{
      requestId: string;
      reason: string;
      expectedConfigVersion: string;
      taskKey: string;
    }> = {},
  ) =>
    h.domain.superHandoffs.request(
      'AR',
      { kind: 'ai', handle: 'operator' },
      {
        reason: 'A fictional reason',
        command,
        requestId: randomUUID(),
        ...extra,
      },
    );

  const execute = (
    handoffId: string,
    requestId: string,
    opts: { secret?: string; key?: typeof KEY; afterResolve?: () => void } = {},
  ) => asIntegrator((access) => h.domain.superHandoffs.execute('AR', handoffId, requestId, access), opts);

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

  const stored = (id: string) => h.domain.superHandoffs.handoff('AR', id);

  describe('recording a handoff', () => {
    it('persists with no integrator running and needs no token', async () => {
      await boot();
      const handoff = await request(PAUSE, { taskKey: undefined });
      expect(handoff).toMatchObject({ state: 'pending', operationId: null, projectKey: 'AR' });
      expect(handoff.requestedBy).toEqual({ kind: 'ai', handle: 'operator' });
      expect(h.domain.superHandoffs.list('AR', { limit: 50 }).map((x) => x.id)).toEqual([handoff.id]);
      expect(h.repos.timeline.list('AR').some((e) => e.type === 'super_handoff_changed')).toBe(true);
    });

    it('is the same handoff for the same request id and content, a conflict for other content', async () => {
      await boot();
      const requestId = randomUUID();
      const first = await request(PAUSE, { requestId });
      const again = await request(PAUSE, { requestId });
      expect(again.id).toBe(first.id);
      expect(h.domain.superHandoffs.list('AR', { limit: 50 })).toHaveLength(1);
      await expect(
        request({ kind: 'operate', operation: { op: 'project_resume' } }, { requestId }),
      ).rejects.toMatchObject({
        code: 'super_request_conflict',
        status: 409,
      });
      await expect(request(PAUSE, { requestId, reason: 'Another fictional reason' })).rejects.toMatchObject({
        code: 'super_request_conflict',
      });
    });

    it('survives a restart and still waits for an integrator', async () => {
      await boot({ persistent: true });
      const handoff = await request(PAUSE);
      h = await restartDomainHarness(h, { now: () => clock });
      expect(h.domain.superHandoffs.handoff('AR', handoff.id)).toMatchObject({ state: 'pending' });
    });

    it('lists by state and gives nothing of another project', async () => {
      await boot();
      const handoff = await request(PAUSE);
      expect(h.domain.superHandoffs.list('AR', { state: 'pending', limit: 10 })).toHaveLength(1);
      expect(h.domain.superHandoffs.list('AR', { state: 'succeeded', limit: 10 })).toHaveLength(0);
      expect(() => h.domain.superHandoffs.handoff('ZZ', handoff.id)).toThrow(
        expect.objectContaining({ status: 404 }),
      );
    });
  });

  describe('executing without an owner-reserved effect', () => {
    it('runs on the integrator`s own power and is idempotent on the request id', async () => {
      await boot();
      withExecutors();
      const handoff = await request(PAUSE);
      const requestId = randomUUID();
      const operation = await execute(handoff.id, requestId);
      expect(operation).toMatchObject({
        state: 'succeeded',
        handoffId: handoff.id,
        requestId,
        ownerQuestionId: null,
      });
      expect(stored(handoff.id)).toMatchObject({ state: 'succeeded', operationId: operation.id });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.command).toEqual(PAUSE);
      // The same request again is the same result, never a second run.
      const again = await execute(handoff.id, requestId);
      expect(again.id).toBe(operation.id);
      expect(calls).toHaveLength(1);
      // A finished handoff takes no new request id.
      await expect(execute(handoff.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_closed' });
    });

    it('refuses a request id that belongs to another handoff', async () => {
      await boot();
      withExecutors();
      const first = await request(PAUSE);
      const second = await request({ kind: 'operate', operation: { op: 'project_resume' } });
      const requestId = randomUUID();
      await execute(first.id, requestId);
      await expect(execute(second.id, requestId)).rejects.toMatchObject({ code: 'super_request_conflict' });
      expect(calls).toHaveLength(1);
      expect(stored(second.id).state).toBe('pending');
    });

    it('is refused without the owner`s super token and without a bound access', async () => {
      await boot();
      withExecutors();
      const handoff = await request(PAUSE);
      const bare = { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess;
      await expect(
        h.domain.superHandoffs.execute('AR', handoff.id, randomUUID(), bare),
      ).rejects.toMatchObject({ code: 'integrator_not_allowed' });
      await expect(
        asIntegrator((access) =>
          h.domain.superHandoffs.execute('AR', handoff.id, randomUUID(), {
            ...access,
            superActor: undefined,
          }),
        ),
      ).rejects.toMatchObject({ code: 'integrator_not_allowed' });
      expect(calls).toHaveLength(0);
      expect(stored(handoff.id).state).toBe('pending');
    });

    it('answers 503 when this installation has no executor for the kind, and leaves the handoff pending', async () => {
      await boot();
      // `operate` has its real executor since PM-831; the administration adapter is not wired in this harness.
      const handoff = await request({
        kind: 'administration',
        request: { kind: 'deploy', releaseId: 'rel_1' },
      });
      await expect(execute(handoff.id, randomUUID())).rejects.toMatchObject({
        code: 'super_executor_unavailable',
        status: 503,
      });
      expect(stored(handoff.id)).toMatchObject({ state: 'pending', operationId: null });
    });

    it('refuses what it cannot classify, and runs nothing (fail closed)', async () => {
      await boot();
      withExecutors();
      const unknownMember = await request({
        kind: 'operate',
        operation: { op: 'member_update', handle: 'ghost', changes: { effort: 'high' } },
      });
      await expect(execute(unknownMember.id, randomUUID())).rejects.toMatchObject({
        code: 'integrator_not_allowed',
        status: 403,
      });
      expect(calls).toHaveLength(0);
      expect(stored(unknownMember.id)).toMatchObject({ state: 'pending', operationId: null });
    });

    it('records a refusal of the executor as failed and anything else as unknown', async () => {
      await boot();
      withExecutors(async () => {
        throw new DomainError('administration_failed', 'refused', { status: 409 });
      });
      const refused = await request(PAUSE);
      const failed = await execute(refused.id, randomUUID());
      expect(failed).toMatchObject({ state: 'failed', errorCode: 'administration_failed' });
      expect(stored(refused.id).state).toBe('failed');

      withExecutors(async () => {
        throw new Error('boom');
      });
      const broken = await request({ kind: 'operate', operation: { op: 'project_resume' } });
      const unknown = await execute(broken.id, randomUUID());
      expect(unknown).toMatchObject({ state: 'unknown', errorCode: 'operation_unknown' });
      expect(stored(broken.id).state).toBe('unknown');
      // What may have had an effect is never run again by itself.
      await expect(execute(broken.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_closed' });
    });

    it('refuses the handoff when the configuration changed since it was made', async () => {
      await boot();
      withExecutors();
      const seen = (await h.domain.projects.load('AR')).version;
      const stale = await request(PAUSE, { expectedConfigVersion: seen });
      await h.domain.projects.patch(
        'AR',
        { baseVersion: seen, project: { name: 'Fictional renamed project' } },
        {
          actor: OWNER_ACTOR,
          author: { ...OWNER },
        },
      );
      await expect(execute(stale.id, randomUUID())).rejects.toMatchObject({
        code: 'super_operation_stale',
        status: 409,
      });
      expect(calls).toHaveLength(0);
      expect(stored(stale.id).state).toBe('pending');
    });

    it('lets two consumers race: only one runs it, the other is told it is busy', async () => {
      await boot();
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      withExecutors(async (job) => {
        calls.push(job);
        await gate;
      });
      const handoff = await request(PAUSE);
      const first = execute(handoff.id, randomUUID());
      await flush();
      await expect(execute(handoff.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_busy' });
      expect(stored(handoff.id).state).toBe('running');
      release();
      expect((await first).state).toBe('succeeded');
      expect(calls).toHaveLength(1);
    });
  });

  describe('executing an owner-reserved effect', () => {
    const waiting = async () => {
      withExecutors();
      const handoff = await request(RETIRE);
      const requestId = randomUUID();
      const operation = await execute(handoff.id, requestId);
      return { handoff, requestId, operation };
    };

    it('opens a question for the owner and runs nothing before the owner`s yes', async () => {
      await boot();
      const { handoff, operation } = await waiting();
      expect(operation).toMatchObject({ state: 'waiting_owner' });
      expect(operation.ownerQuestionId).toBeTruthy();
      expect(calls).toHaveLength(0);
      expect(stored(handoff.id)).toMatchObject({ state: 'waiting_owner', operationId: operation.id });
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

    it('runs after the owner`s own yes, the same request id, and lets the reserved effect pass only then', async () => {
      await boot();
      const { handoff, requestId, operation } = await waiting();
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
      expect(h.domain.superHandoffs.operation('AR', operation.id).state).toBe('pending');
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
      const done = await execute(handoff.id, requestId);
      expect(done).toMatchObject({ id: operation.id, state: 'succeeded' });
      expect(inside).toBe(true);
      expect(calls).toHaveLength(1);
      expect(stored(handoff.id).state).toBe('succeeded');
      await expect(h.domain.superHandoffs.authorizer.assertAllowed(mutation)).rejects.toMatchObject({
        code: 'owner_approval_required',
      });
      // Repeating the request is the same result and no second run.
      expect((await execute(handoff.id, requestId)).id).toBe(operation.id);
      expect(calls).toHaveLength(1);
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
      expect(h.domain.superHandoffs.operation('AR', operation.id).state).toBe('waiting_owner');
    });

    it('cancels on the owner`s no and frees nothing to run', async () => {
      await boot();
      const { handoff, requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'no');
      expect(h.domain.superHandoffs.operation('AR', operation.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'owner_declined',
      });
      expect(stored(handoff.id).state).toBe('cancelled');
      expect((await execute(handoff.id, requestId)).state).toBe('cancelled');
      await expect(execute(handoff.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_closed' });
      expect(calls).toHaveLength(0);
    });

    it('does not let a second request id start while the first waits for the owner', async () => {
      await boot();
      const { handoff } = await waiting();
      await expect(execute(handoff.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_busy' });
    });

    it('expires after 24 hours: the question lapses and the handoff can start again', async () => {
      await boot();
      const { handoff, operation } = await waiting();
      clock = new Date(clock.getTime() + 24 * HOUR + 1000);
      // An answer that arrives after the deadline, before anything swept, is refused.
      await expect(answerAsOwner(operation.ownerQuestionId!, 'yes')).rejects.toMatchObject({
        code: 'super_operation_expired',
      });
      expect(h.domain.superHandoffs.list('AR', { limit: 10 })).toHaveLength(1);
      expect(h.domain.superHandoffs.operation('AR', operation.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'super_operation_expired',
      });
      expect(h.domain.inbox.get('AR', operation.ownerQuestionId!).state).toBe('expired');
      expect(stored(handoff.id)).toMatchObject({ state: 'pending', operationId: null });
      // The owner's late yes cannot revive it.
      await expect(answerAsOwner(operation.ownerQuestionId!, 'yes')).rejects.toMatchObject({
        code: 'inbox_item_closed',
      });
      // A new request id starts a fresh operation and a fresh question.
      const next = await execute(handoff.id, randomUUID());
      expect(next).toMatchObject({ state: 'waiting_owner' });
      expect(next.id).not.toBe(operation.id);
    });

    it('refuses the yes when the configuration changed after the owner was asked', async () => {
      await boot();
      const { handoff, requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      const version = (await h.domain.projects.load('AR')).version;
      await h.domain.projects.patch(
        'AR',
        { baseVersion: version, project: { name: 'Fictional renamed project' } },
        {
          actor: OWNER_ACTOR,
          author: { ...OWNER },
        },
      );
      withExecutors();
      await expect(execute(handoff.id, requestId)).rejects.toMatchObject({
        code: 'super_operation_stale',
        status: 409,
      });
      expect(calls).toHaveLength(0);
      expect(h.domain.superHandoffs.operation('AR', operation.id)).toMatchObject({
        state: 'cancelled',
        errorCode: 'super_operation_stale',
      });
      expect(stored(handoff.id)).toMatchObject({ state: 'pending', operationId: null });
    });

    it('refuses to start when the token was revoked, and a new token cannot use the old yes', async () => {
      await boot();
      const { handoff, requestId, operation } = await waiting();
      await answerAsOwner(operation.ownerQuestionId!, 'yes');
      // Revoked after the request was authenticated, before the start: the service checks the key again.
      withExecutors();
      await expect(
        execute(handoff.id, requestId, {
          afterResolve: () => h.repos.integratorKeys.revokeById('user-1', KEY.id, clock.toISOString()),
        }),
      ).rejects.toMatchObject({ code: 'integrator_key_invalid' });
      expect(calls).toHaveLength(0);
      expect(h.domain.superHandoffs.operation('AR', operation.id).state).toBe('pending');
      // Another token, even with the same request id, is not the one the owner agreed to.
      await expect(
        execute(handoff.id, requestId, { secret: SECOND_SECRET, key: SECOND_KEY }),
      ).rejects.toMatchObject({
        code: 'super_operation_stale',
      });
      expect(calls).toHaveLength(0);
      expect(stored(handoff.id)).toMatchObject({ state: 'pending', operationId: null });
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
      const running = await request(PAUSE);
      void execute(running.id, randomUUID()).catch(() => undefined);
      await hasStarted;
      expect(stored(running.id).state).toBe('running');

      withExecutors();
      const owner = await request(RETIRE);
      const waitingOp = await execute(owner.id, randomUUID());
      expect(waitingOp.state).toBe('waiting_owner');

      h = await restartDomainHarness(h, { now: () => clock });
      expect(h.domain.superHandoffs.handoff('AR', running.id).state).toBe('unknown');
      const op = h.repos.superHandoffs.operationsOfHandoff('AR', running.id)[0]!;
      expect(op).toMatchObject({ state: 'unknown', errorCode: 'operation_unknown' });
      expect(h.domain.superHandoffs.handoff('AR', owner.id).state).toBe('waiting_owner');

      withExecutors();
      await expect(execute(running.id, randomUUID())).rejects.toMatchObject({ code: 'super_handoff_closed' });
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
      const handoff = await request(RETIRE);
      const operation = await execute(handoff.id, randomUUID());
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
    const handoff = await request(PAUSE);
    const operation: SuperOperation = await execute(handoff.id, randomUUID());
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
