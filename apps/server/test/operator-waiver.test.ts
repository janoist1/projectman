import { afterEach, describe, expect, it, vi } from 'vitest';
import { roleBundle, routes } from '@projectman/shared';
import type { OperatorOperation } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

let h: DomainHarness;
let app: AppHarness;
let ctx: ToolContext;
const by = { actor: OWNER_ACTOR, author: OWNER };
const owner = { handle: 'owner', access: 'owner' as const };
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
  await app?.close();
});

async function setup(enabled = true, persistent = false) {
  h = await createDomainHarness({ persistent });
  await h.domain.messaging.sendReporting(
    'AR',
    'owner',
    { to: ['operator'], text: 'Set up the agreement and requested changes.' },
    { awaitWake: true },
  );
  const session = h.domain.sessions.list('AR', { member: 'operator' })[0]!;
  ctx = { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null };
  const proposal = await h.domain.teamTools.proposeOperatorKnowledge(ctx, {
    expected_revision: 0,
    title: 'Agreement',
    operations: [],
    change: {
      kind: 'agreement_replace',
      agreement: {
        summary: 'Waive ordinary configuration approval',
        involvement: 'important',
        extraCritical: [],
      },
    },
  });
  await h.domain.inbox.resolve('AR', proposal.inbox_item_id, { optionId: 'approve' }, owner);
  if (enabled) await setWaiver(true);
}
async function setWaiver(enabled: boolean, agreementVersion = 1) {
  return h.domain.projects.setOperatorApprovalWaiver(
    'AR',
    {
      baseVersion: (await h.domain.projects.load('AR')).version,
      enabled,
      agreementVersion,
    },
    by,
  );
}
const rename = (): OperatorOperation => ({
  op: 'config_patch',
  patch: { project: { name: 'Changed name' } },
});
const operate = (operation: OperatorOperation = rename()) =>
  h.domain.teamTools.operate(ctx, { title: 'Requested change', operation });

describe('Operator approval waiver execution', () => {
  it('keeps targeted role patches in waiver intents and preserves unrelated role edits before execution', async () => {
    await setup();
    const before = await h.domain.projects.load('AR');
    await h.domain.projects.patch(
      'AR',
      {
        baseVersion: before.version,
        roleOverrides: {
          developer: {
            ...roleBundle(before.config, 'developer'),
            instructions: 'Original.',
            summary: 'Original summary',
          },
          architect: { ...roleBundle(before.config, 'architect'), instructions: 'Original architect.' },
        },
      },
      by,
    );
    const read = await h.domain.teamTools.getRoleConfiguration(ctx, { role: 'developer' });
    const operation: OperatorOperation = {
      op: 'config_patch',
      patch: {
        roleOverrides: {
          developer: { ...read.effective, instructions: 'Original.\nAdded.', summary: 'Updated summary' },
        },
      },
    };
    const execute = h.domain.operatorActions.execute.bind(h.domain.operatorActions);
    vi.spyOn(h.domain.operatorActions, 'execute').mockImplementationOnce(async (...args) => {
      const loaded = await h.domain.projects.load('AR');
      await h.domain.projects.patch(
        'AR',
        {
          baseVersion: loaded.version,
          roleOverrides: {
            ...loaded.config.team.roleOverrides,
            architect: {
              ...roleBundle(loaded.config, 'architect'),
              instructions: 'Concurrent unrelated edit.',
            },
          },
        },
        by,
      );
      return execute(...args);
    });
    const result = await operate(operation);
    expect(result.status).toBe('done');
    expect(
      h.repos.operatorRequests.executions('AR').find((intent) => intent.id === result.step_id),
    ).toMatchObject({ status: 'committed', operation });
    const request = h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!;
    expect(
      h.repos.operatorRequests.steps(request.id).find((step) => step.id === result.step_id),
    ).toMatchObject({ approvalMode: 'waived' });
    const saved = (await h.domain.projects.config('AR')).team.roleOverrides!;
    expect(saved.developer).toEqual(
      operation.op === 'config_patch' && operation.patch.roleOverrides!.developer,
    );
    expect(saved.architect?.instructions).toBe('Concurrent unrelated edit.');
  });
  it.each([false, true])('keeps the original preview and executes only with waiver %s', async (enabled) => {
    await setup(enabled);
    const request = h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!;
    expect(await h.domain.operatorActions.preview('AR', 'operator', request, rename())).toMatchObject({
      level: 'approval',
      waiverEligible: true,
    });
    const result = await operate();
    expect(result.status).toBe(enabled ? 'done' : 'awaiting_approval');
    const step = h.repos.operatorRequests.steps(request.id).find((step) => step.id === result.step_id)!;
    expect(step).toMatchObject({
      agreementVersion: enabled ? 1 : null,
      approvalMode: enabled ? 'waived' : null,
    });
    if (!enabled) return;
    expect(
      h.domain.timeline.list('AR').filter((event) => event.type === 'operator_approval_waived'),
    ).toHaveLength(1);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operatorStepId: result.step_id,
      operatorRequestId: request.id,
      operatorAgreementVersion: 1,
      operatorApprovalMode: 'waived',
    });
    expect(h.repos.operatorRequests.executions('AR')).toMatchObject([
      { id: result.step_id, status: 'committed', changes: step.changes },
    ]);
    expect(
      h.repos.messages
        .list('AR', { member: 'operator' })
        .some((message) => message.body.includes('Changed name') && message.body.includes('->')),
    ).toBe(true);
    expect(await operate()).toMatchObject({ status: 'done', step_id: result.step_id });
    expect(h.repos.operatorRequests.executions('AR')).toHaveLength(1);
  });

  it.each([undefined, false] as const)(
    'waives only a hire with template network rights (%s)',
    async (outboundNetwork) => {
      await setup();
      const result = await operate({
        op: 'member_hire',
        request: {
          role: 'developer',
          handle: 'writer',
          ...(outboundNetwork !== undefined ? { outboundNetwork } : {}),
        },
      });
      expect(result.status).toBe(outboundNetwork === false ? 'awaiting_approval' : 'done');
    },
  );

  it.each([
    { op: 'member_update', handle: 'dev-1', changes: { outboundNetwork: false } },
    { op: 'member_update', handle: 'dev-1', changes: { approver: 'none' } },
    { op: 'member_update', handle: 'operator', changes: { model: 'sonnet' } },
    { op: 'config_patch', patch: { operatorWatch: 'drive' } },
    {
      op: 'config_patch',
      patch: {
        project: { name: 'Mixed' },
        pipeline: undefined,
        boundary: { enabled: true, leadTimeoutSeconds: 120 },
      },
    },
  ] satisfies OperatorOperation[])('keeps protected changes on the click path: %j', async (operation) => {
    await setup();
    expect((await operate(operation)).status).toBe('awaiting_approval');
    expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
  });

  it.each(['waiver', 'agreement', 'request'] as const)(
    'rechecks %s after preview and before commit',
    async (change) => {
      await setup();
      const original = h.domain.operatorActions.preview.bind(h.domain.operatorActions);
      vi.spyOn(h.domain.operatorActions, 'preview').mockImplementationOnce(async (...args) => {
        const preview = await original(...args);
        if (change === 'waiver') await setWaiver(false);
        if (change === 'request') h.repos.operatorRequests.close(args[2].id, new Date().toISOString());
        return preview;
      });
      if (change === 'agreement') {
        const execute = h.domain.operatorActions.execute.bind(h.domain.operatorActions);
        vi.spyOn(h.domain.operatorActions, 'execute').mockImplementationOnce(async (...args) => {
          const proposal = await h.domain.teamTools.proposeOperatorKnowledge(ctx, {
            expected_revision: 1,
            title: 'New agreement',
            operations: [],
            change: {
              kind: 'agreement_replace',
              agreement: {
                summary: 'A newer agreement',
                involvement: 'important',
                extraCritical: [],
              },
            },
          });
          await h.domain.inbox.resolve('AR', proposal.inbox_item_id, { optionId: 'approve' }, owner);
          return execute(...args);
        });
      }
      if (change === 'request') expect((await operate()).status).toBe('awaiting_approval');
      else
        await expect(operate()).rejects.toThrow(
          change === 'waiver' ? 'owner_approval_required' : 'operator_knowledge_stale',
        );
      expect((await h.domain.projects.config('AR')).project.name).not.toBe('Changed name');
      expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
    },
  );

  it('commits a concurrent retry only once for the same request and operation', async () => {
    await setup();
    const before = await h.domain.projects.history('AR');
    await Promise.allSettled([operate(), operate()]);
    expect((await h.domain.projects.history('AR')).length).toBe(before.length + 1);
    expect(
      h.repos.operatorRequests.executions('AR').filter((intent) => intent.status === 'committed'),
    ).toHaveLength(1);
    expect(
      h.domain.timeline.list('AR').filter((event) => event.type === 'operator_approval_waived'),
    ).toHaveLength(1);
  });

  it('records an actual protected approval with click attribution', async () => {
    await setup();
    const proposal = await operate({
      op: 'member_update',
      handle: 'dev-1',
      changes: { outboundNetwork: false },
    });
    await h.domain.inbox.resolve('AR', proposal.inbox_item_id!, { optionId: 'approve' }, owner);
    expect((await h.domain.projects.history('AR'))[0]).toMatchObject({
      operatorApprovalMode: 'click',
      operatorAgreementVersion: 1,
      operatorStepId: proposal.step_id,
    });
    expect(h.repos.operatorRequests.executions('AR')).toMatchObject([
      { approvalMode: 'click', status: 'committed' },
    ]);
    expect(
      h.domain.timeline.list('AR').filter((event) => event.type === 'operator_approval_waived'),
    ).toHaveLength(0);
  });

  it.each(['integrator', 'ai'] as const)(
    'rejects %s provenance for both the switch and waived execution',
    async (source) => {
      await setup();
      const actor =
        source === 'integrator'
          ? { ...OWNER_ACTOR, via: 'integrator' as const }
          : { kind: 'ai' as const, handle: 'operator' };
      await expect(
        h.domain.projects.setOperatorApprovalWaiver(
          'AR',
          { baseVersion: (await h.domain.projects.load('AR')).version, enabled: false, agreementVersion: 1 },
          { actor, author: OWNER },
        ),
      ).rejects.toMatchObject({ code: 'owner_approval_required' });
      const previous = h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!;
      const original = h.repos.messages.get(previous.messageId!)!;
      const message = {
        ...original,
        id: 'untrusted-message',
        ...(source === 'integrator' ? { via: 'integrator' as const } : { from: 'dev-1' }),
      };
      h.repos.messages.insert(message);
      h.repos.operatorRequests.close(previous.id, new Date().toISOString());
      h.repos.operatorRequests.insert({
        ...previous,
        id: 'untrusted-request',
        messageId: message.id,
        fromHandle: message.from,
      });
      if (source === 'ai') await expect(operate()).rejects.toThrow('operator_owner_only');
      else expect((await operate()).status).toBe('awaiting_approval');
      expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
    },
  );

  it.each(['project_pause', 'session_stop'] as const)(
    'keeps runtime %s on the click path while waiver is enabled',
    async (op) => {
      await setup();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const result = await h.domain.teamTools.operate(ctx, {
        title: 'Runtime change',
        operation: op === 'project_pause' ? { op } : { op, sessionId: session.id },
        plan: { why: 'Owner requested a runtime change', impact: 'Stops work', reversible: true },
      });
      expect(result.status).toBe('awaiting_approval');
      expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
    },
  );

  it('never treats a signal request as owner provenance, even with drive enabled', async () => {
    await setup();
    await h.domain.projects.patch(
      'AR',
      { baseVersion: (await h.domain.projects.load('AR')).version, operatorWatch: 'drive' },
      by,
    );
    const request = {
      ...h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!,
      id: 'signal-request',
      source: 'signal' as const,
      messageId: null,
    };
    h.repos.operatorRequests.insert(request);
    const result = await h.domain.operatorActions.run('AR', request.id, 'Signal change', rename());
    expect(result.status).toBe('awaiting_approval');
    expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
  });

  it('rejects waiver changes through save, mixed patch and revert', async () => {
    await setup(false);
    const before = await h.domain.projects.load('AR');
    await setWaiver(true);
    const current = await h.domain.projects.load('AR');
    const next = structuredClone(current.config);
    next.team.operatorApprovalWaiver = false;
    await expect(h.domain.projects.save('AR', next, by)).rejects.toMatchObject({
      code: 'owner_approval_required',
    });
    await expect(
      h.domain.projects.patch(
        'AR',
        { baseVersion: current.version, project: { name: 'Mixed' }, operatorApprovalWaiver: false } as never,
        by,
      ),
    ).rejects.toMatchObject({ code: 'owner_approval_required' });
    await expect(h.domain.projects.revert('AR', before.version, by)).rejects.toMatchObject({
      code: 'owner_approval_required',
    });
    await expect(operate({ op: 'config_revert', version: before.version })).rejects.toThrow(
      'owner_approval_required',
    );
    expect((await h.domain.projects.load('AR')).version).toBe(current.version);
  });

  it('rejects a mixed hire attempting to carry the protected waiver switch', async () => {
    await setup();
    await expect(
      operate({
        op: 'member_hire',
        request: { role: 'developer', handle: 'injected', operatorApprovalWaiver: false },
      } as never),
    ).rejects.toThrow('owner_approval_required');
    expect(
      (await h.domain.projects.config('AR')).team.members.some((member) => member.handle === 'injected'),
    ).toBe(false);
  });

  it('requires a current approved agreement for enable, but permits disable without it', async () => {
    await setup(false);
    await expect(setWaiver(true, 2)).rejects.toMatchObject({ code: 'operator_knowledge_stale' });
    await setWaiver(true);
    vi.spyOn(h.domain.operatorKnowledge, 'readKnowledge').mockResolvedValue({
      schemaVersion: 1,
      revision: 0,
      agreement: null,
      principles: [],
      appliedProposalIds: [],
    });
    await expect(setWaiver(false)).resolves.toMatchObject({ enabled: false });
    await expect(setWaiver(true)).rejects.toMatchObject({ code: 'operator_knowledge_stale' });
  });

  it('recovers a commit after the journal update was interrupted, without replay or duplicate audit', async () => {
    await setup(true, true);
    const finish = vi.spyOn(h.repos.operatorRequests, 'finishExecution').mockImplementationOnce(() => {
      throw new Error('interrupted journal update');
    });
    await expect(operate()).rejects.toThrow('interrupted journal update');
    finish.mockRestore();
    const intent = h.repos.operatorRequests.executions('AR')[0]!;
    expect(intent.status).toBe('prepared');
    h = await restartDomainHarness(h);
    expect(h.repos.operatorRequests.executions('AR')[0]).toMatchObject({
      status: 'committed',
      id: intent.id,
    });
    expect(
      h.repos.operatorRequests.steps(intent.requestId).find((step) => step.id === intent.id),
    ).toMatchObject({ status: 'done', approvalMode: 'waived', agreementVersion: 1 });
    const version = (await h.domain.projects.load('AR')).version;
    await h.domain.operatorActions.recover();
    expect((await h.domain.projects.load('AR')).version).toBe(version);
    expect(
      h.domain.timeline.list('AR').filter((event) => event.type === 'operator_approval_waived'),
    ).toHaveLength(1);
  });

  it('fails an uncommitted closed-request intent after restart and does not create a request', async () => {
    await setup(true, true);
    vi.spyOn(h.configStore, 'save').mockRejectedValueOnce(new Error('before commit'));
    await expect(operate()).rejects.toThrow('before commit');
    const intent = h.repos.operatorRequests.executions('AR')[0]!;
    h.repos.operatorRequests.close(intent.requestId, new Date().toISOString());
    h = await restartDomainHarness(h);
    expect(h.repos.operatorRequests.executions('AR')[0]).toMatchObject({
      status: 'failed',
      refusal: { code: 'operator_no_request' },
    });
    expect(h.repos.operatorRequests.openOfProject('AR')).toHaveLength(0);
    expect((await h.domain.projects.config('AR')).project.name).not.toBe('Changed name');
  });
});

describe('owner-only waiver API', () => {
  it('rejects admin and integrator, validates strict input and refuses mixed direct patches', async () => {
    app = await createAppHarness();
    const cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    const version = (await app.app.projectman.domain.projects.load('AR')).version;
    const body = { baseVersion: version, enabled: true, agreementVersion: 1 };
    const denied = await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), admin, body);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('owner_approval_required');
    const key = await inject(app.app, 'POST', routes.integratorKey(), cookie, undefined);
    const via = await app.app.inject({
      method: 'PUT',
      url: routes.operatorApprovalWaiver('AR'),
      headers: { authorization: `Bearer ${key.json().secret}` },
      payload: body,
    });
    expect(via.statusCode).toBe(403);
    expect(via.json().error.code).toBe('owner_approval_required');
    expect(
      (await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), cookie, { ...body, extra: true }))
        .statusCode,
    ).toBe(400);
    expect((await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), cookie, body)).statusCode).toBe(
      409,
    );
    const domain = app.app.projectman.domain;
    await domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['operator'], text: 'Agree to ordinary changes' },
      { awaitWake: true },
    );
    const session = domain.sessions.list('AR', { member: 'operator' })[0]!;
    const proposal = await domain.teamTools.proposeOperatorKnowledge(
      { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null },
      {
        expected_revision: 0,
        title: 'Agreement',
        operations: [],
        change: {
          kind: 'agreement_replace',
          agreement: {
            summary: 'Approved ordinary changes',
            involvement: 'important',
            extraCritical: [],
          },
        },
      },
    );
    await domain.inbox.resolve('AR', proposal.inbox_item_id, { optionId: 'approve' }, owner);
    const enabled = await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), cookie, body);
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ enabled: true, agreementVersion: 1 });
    const patch = await inject(app.app, 'PATCH', routes.config('AR'), cookie, {
      baseVersion: version,
      project: { name: 'Mixed' },
      operatorApprovalWaiver: true,
    });
    expect(patch.statusCode).toBe(403);
    expect(patch.json().error.code).toBe('owner_approval_required');
    const hire = await inject(app.app, 'POST', routes.members('AR'), cookie, {
      role: 'developer',
      handle: 'injected',
      operatorApprovalWaiver: false,
    });
    expect(hire.statusCode).toBe(403);
    expect(hire.json().error.code).toBe('owner_approval_required');
    const disabled = await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), cookie, {
      ...body,
      baseVersion: enabled.json().version,
      enabled: false,
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ enabled: false, agreementVersion: 1 });
  });
});
