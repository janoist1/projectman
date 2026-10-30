import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_APP_CREDENTIAL_PREFIX } from '@projectman/shared';
import type { NewSuperCommand } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedOperatorRequest } from './helpers/operator-session';
import type { IntegratorPrincipal, ToolContext } from '../src/contracts';
import type { DomainContext } from '../src/core/base';
import { TEAM_TOOLS } from '../src/mcp/tools';
import { appRequestId, createOperatorAppSessions } from '../src/services/super-operator';

const NOW = '2026-10-20T10:00:00.000Z';
const REQUEST = 'opr_app_1';
const TASK: NewSuperCommand = { kind: 'task_create', request: { title: 'Made by the Operator' } };

describe('the in-app Operator on the shared super-operation path (PM-888)', () => {
  let h: DomainHarness;
  let ctx: ToolContext;
  let userId: string;
  afterEach(() => h?.cleanup());

  const openRequest = (
    sessionId: string,
    id = REQUEST,
    source: 'message' | 'answer' | 'approval' | 'queue' = 'message',
    fromHandle = 'owner',
  ) =>
    h.repos.operatorRequests.insert({
      id,
      projectKey: 'AR',
      sessionId,
      source,
      messageId: null,
      inboxItemId: null,
      fromHandle,
      quote: 'Do it.',
      openedAt: new Date().toISOString(),
    });

  const boot = async (member = 'pm') => {
    h = await createDomainHarness({
      adjust: (config) => {
        if (member === 'pm') {
          const pm = config.team.members.find((candidate) => candidate.handle === 'pm')!;
          if (pm.kind === 'ai') pm.onLeave = false;
        }
      },
    });
    userId = 'user-1';
    h.repos.users.insert({
      id: userId,
      name: OWNER.name,
      email: OWNER.email,
      passwordHash: 'unused-test-hash',
      createdAt: NOW,
    });
    const { session } = await h.domain.sessions.ensureSession('AR', member, { type: 'general' });
    ctx = { projectKey: 'AR', member, sessionId: session.id, taskKey: null };
    openRequest(session.id);
  };

  const execute = (requestKey: string, command: NewSuperCommand = TASK, as: ToolContext = ctx) =>
    h.domain.teamTools.executeOperation(as, { requestKey, command });

  describe('execute_operation', () => {
    beforeEach(() => boot());

    it('runs a routine command as the Operator with the app credential and logs the step', async () => {
      const { operation } = await execute('first');
      expect(operation).toMatchObject({ state: 'succeeded', projectKey: 'AR' });
      expect(h.repos.tasks.get('AR-1')?.title).toBe('Made by the Operator');
      const audit = h.repos.superAudit.ofRequest('AR', operation.requestId);
      expect(audit.length).toBeGreaterThan(0);
      expect(audit.every((entry) => entry.prefix === OPERATOR_APP_CREDENTIAL_PREFIX)).toBe(true);
      expect(audit.every((entry) => entry.keyId === ctx.sessionId)).toBe(true);
      expect(h.repos.operatorRequests.steps(REQUEST)).toMatchObject([
        { action: 'operation', operationId: operation.id, status: 'done' },
      ]);
    });

    it('treats the same request key as the same operation and another key as another one', async () => {
      const first = await execute('same');
      const again = await execute('same');
      expect(again.operation.id).toBe(first.operation.id);
      expect(h.repos.tasks.get('AR-2')).toBeNull();
      const other = await execute('other');
      expect(other.operation.id).not.toBe(first.operation.id);
    });

    it('is refused with no open owner request, and from an approval request', async () => {
      h.repos.operatorRequests.close(REQUEST, NOW);
      await expect(execute('closed')).rejects.toMatchObject({
        message: expect.stringContaining('operator_no_request'),
      });
      openRequest(ctx.sessionId, 'opr_app_approval', 'approval');
      await expect(execute('approval')).rejects.toMatchObject({ code: 'forbidden' });
      expect(h.repos.tasks.get('AR-1')).toBeNull();
    });

    it('sets no approval label on a member`s request, and sets it on an owner`s own (PM-1010)', async () => {
      await execute('card');
      h.repos.operatorRequests.close(REQUEST, NOW);
      openRequest(ctx.sessionId, 'opr_app_member', 'message', 'dev-1');
      const label: NewSuperCommand = { kind: 'task_labels', taskKey: 'AR-1', request: { add: ['merge-ok'] } };
      await expect(execute('label', label)).rejects.toMatchObject({ code: 'forbidden' });
      expect(h.repos.tasks.get('AR-1')?.labels).not.toContain('merge-ok');
      h.repos.operatorRequests.close('opr_app_member', NOW);
      openRequest(ctx.sessionId, 'opr_app_owner');
      expect((await execute('label-owner', label)).operation.state).toBe('succeeded');
      expect(h.repos.tasks.get('AR-1')?.labels).toContain('merge-ok');
    });

    it('is refused to a member who is not the Operator and in a guest conversation', async () => {
      await expect(execute('dev', TASK, { ...ctx, member: 'dev-1' })).rejects.toMatchObject({
        code: 'forbidden',
      });
      const guest = {
        ...h.repos.sessions.get(ctx.sessionId)!,
        id: 'ses_app_guest',
        workItem: { type: 'general', with: 'guest' } as const,
      };
      h.repos.sessions.insert(guest);
      openRequest(guest.id, 'opr_app_guest');
      await expect(execute('guest', TASK, { ...ctx, sessionId: guest.id })).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(h.repos.tasks.get('AR-1')).toBeNull();
    });
  });

  describe('the app credential', () => {
    beforeEach(() => boot());

    it('is not honoured when it was not issued by the server', async () => {
      const forged: IntegratorPrincipal = {
        kind: 'integrator',
        userId,
        keyId: ctx.sessionId,
        prefix: OPERATOR_APP_CREDENTIAL_PREFIX,
        mode: 'super',
        source: 'app',
      };
      const context = {
        principal: forged,
        email: OWNER.email,
        requestId: appRequestId(REQUEST, 'forged'),
        projectKey: 'AR',
      };
      await expect(async () =>
        h.domain.superOperator.run(context, async () => undefined),
      ).rejects.toMatchObject({ code: 'insufficient_access' });
    });

    it('is never active for the Operator, which has no app session (PM-1045)', () => {
      const sessions = createOperatorAppSessions({
        ctx: { repos: h.repos } as unknown as DomainContext,
        projects: h.domain.projects,
        hasOpenRequest: () => true,
      });
      const { session } = seedOperatorRequest(h, 'AR');
      expect(
        sessions.active({
          kind: 'integrator',
          userId,
          keyId: session.id,
          prefix: OPERATOR_APP_CREDENTIAL_PREFIX,
          mode: 'super',
          source: 'app',
          member: 'operator',
        }),
      ).toBe(false);
    });
  });

  describe('the project manager app path', () => {
    beforeEach(() => boot('pm'));

    it('executes and records a routine command as the PM', async () => {
      const { operation } = await execute('pm-create');
      expect(operation.state).toBe('succeeded');
      expect(h.domain.timeline.list('AR', { taskKey: 'AR-1' })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'task_created',
            actor: expect.objectContaining({
              kind: 'ai',
              handle: 'pm',
              via: 'integrator',
              operatorMode: 'super',
            }),
          }),
        ]),
      );
      expect((await h.domain.teamTools.getOperation(ctx, { operationId: operation.id })).operation.id).toBe(
        operation.id,
      );
    });

    it.each([
      { kind: 'credential_revoke', keyId: 'ikey_victim' },
      { kind: 'workspace_release', scopeId: 'scp_0123456789abcdef', reason: 'Checked' },
    ] satisfies NewSuperCommand[])('refuses a PM command of kind $kind', async (command) => {
      await expect(execute('pm-refused', command)).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining('command_not_for_project_manager'),
      });
    });

    it.each([true, false])('routes a refused PM command with machine access %s', async (machineAccess) => {
      await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
        const member = draft.team.members.find((candidate) => candidate.handle === 'pm');
        if (member?.kind === 'ai') member.machineAccess = machineAccess;
        return 'Set machine access';
      });
      await expect(
        execute('pm-route', { kind: 'credential_revoke', keyId: 'ikey_victim' }),
      ).rejects.toMatchObject({
        code: 'forbidden',
        message: expect.stringContaining(machineAccess ? 'open_integrator_todo' : 'ask_human'),
      });
    });

    it('requires an open owner request', async () => {
      h.repos.operatorRequests.close(REQUEST, NOW);
      await expect(execute('pm-closed')).rejects.toMatchObject({ code: 'forbidden' });
      openRequest(ctx.sessionId, 'opr_pm_guest', 'message', 'dev-1');
      await expect(execute('pm-guest')).rejects.toMatchObject({ code: 'forbidden' });
    });

    it('binds an app principal only to its own general session', () => {
      const sessions = createOperatorAppSessions({
        ctx: { repos: h.repos } as unknown as DomainContext,
        projects: h.domain.projects,
        hasOpenRequest: () => true,
      });
      const principal: IntegratorPrincipal = {
        kind: 'integrator',
        userId,
        keyId: ctx.sessionId,
        member: 'pm',
        prefix: OPERATOR_APP_CREDENTIAL_PREFIX,
        mode: 'super',
        source: 'app',
      };
      expect(sessions.active(principal)).toBe(true);
      expect(sessions.active({ ...principal, member: 'dev-1' })).toBe(false);
      expect(sessions.active({ ...principal, member: undefined })).toBe(false);
      const base = h.repos.sessions.get(ctx.sessionId)!;
      h.repos.sessions.insert({ ...base, id: 'ses_pm_guest', workItem: { type: 'general', with: 'owner' } });
      expect(sessions.active({ ...principal, keyId: 'ses_pm_guest' })).toBe(false);
    });

    it('waits for the owner before the PM changes its own instructions', async () => {
      const before = (await h.domain.projects.config('AR')).team.members.find(
        (member) => member.handle === 'pm',
      )!;
      const { operation } = await execute('pm-self-edit', {
        kind: 'member_update',
        handle: 'pm',
        request: { instructions: 'Updated coordination instructions' },
      });
      expect(operation.state).toBe('waiting_owner');
      expect(operation.ownerQuestionId).not.toBeNull();
      expect(
        (await h.domain.projects.config('AR')).team.members.find((member) => member.handle === 'pm'),
      ).toEqual(before);
    });

    it('waits for owner approval before granting machine access to another member', async () => {
      const { operation } = await execute('pm-grant-machine-access', {
        kind: 'member_update',
        handle: 'dev-1',
        request: { machineAccess: true },
      });
      expect(operation.state).toBe('waiting_owner');
      expect(operation.ownerQuestionId).not.toBeNull();
      expect(
        (await h.domain.projects.config('AR')).team.members.find((member) => member.handle === 'dev-1'),
      ).not.toMatchObject({ machineAccess: true });
    });

    it('uses the shared path for PM settings and resumes a K3 effect in the PM name', async () => {
      const result = await h.domain.teamTools.operate(ctx, {
        title: 'Change developer access',
        operation: { op: 'member_update', handle: 'dev-1', changes: { outboundNetwork: false } },
      });
      expect(result.status).toBe('awaiting_approval');
      const steps = h.repos.operatorRequests.steps(REQUEST);
      const operationId = steps[0]!.operationId!;
      expect(h.domain.superHandoffs.operation('AR', operationId).state).toBe('waiting_owner');
      h.repos.operatorRequests.close(REQUEST, NOW);
      h.repos.sessions.update(ctx.sessionId, { state: 'exited' });
      await h.domain.inbox.resolve(
        'AR',
        result.inbox_item_id!,
        { optionId: 'yes' },
        { handle: 'owner', access: 'owner' },
      );
      await vi.waitFor(() =>
        expect(['succeeded', 'failed']).toContain(h.domain.superHandoffs.operation('AR', operationId).state),
      );
      expect(h.domain.superHandoffs.operation('AR', operationId)).toMatchObject({
        state: 'succeeded',
        errorCode: null,
      });
      expect(
        h.domain.timeline
          .list('AR', {})
          .filter((event) => event.type === 'super_operation_changed')
          .every((event) => event.actor.kind !== 'ai' || event.actor.handle === 'pm'),
      ).toBe(true);
    });

    it('pauses with the PM as the recorded actor', async () => {
      const result = await h.domain.teamTools.operate(ctx, {
        title: 'Pause',
        operation: { op: 'project_pause' },
      });
      expect(result.status).toBe('done');
      expect(h.domain.timeline.list('AR', {})).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'team_paused',
            actor: expect.objectContaining({ kind: 'ai', handle: 'pm', operatorMode: 'super' }),
          }),
        ]),
      );
    });
  });

  describe('the tool set', () => {
    it('no longer has request_super_operation, and takes a bounded request key', () => {
      expect(TEAM_TOOLS.map((tool): string => tool.name)).not.toContain('request_super_operation');
      const tool = TEAM_TOOLS.find((t) => t.name === 'execute_operation')!;
      const input = (request_key: string) =>
        tool.inputSchema.safeParse({ request_key, command: TASK }).success;
      expect(input('retry-1.a_b')).toBe(true);
      expect(input('')).toBe(false);
      expect(input('has space')).toBe(false);
      expect(input('x'.repeat(101))).toBe(false);
    });

    it('derives the request id from the Operator request and the key: a stable UUID v8', () => {
      const id = appRequestId('opr_1', 'key');
      expect(id).toBe(appRequestId('opr_1', 'key'));
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(appRequestId('opr_2', 'key')).not.toBe(id);
      expect(appRequestId('opr_1', 'other')).not.toBe(id);
    });
  });
});
