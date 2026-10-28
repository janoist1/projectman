import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { OperatorOperation, OperatorPlan, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { DomainError } from '../src/kernel';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { seedOperatorRequest } from './helpers/operator-session';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

// The waiver covers what would wait for a click; an owner-asked change now goes through without one.
vi.mock('@projectman/shared', async (original) =>
  (await import('./helpers/operator-autonomy')).switchable(await original()),
);

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

/** The test template's project manager is on leave; the Operator tool surface is its alone (decision 66). */
const pmOnDuty = (config: ProjectConfig) => {
  for (const member of config.team.members)
    if (member.handle === 'pm' && member.kind === 'ai') member.onLeave = false;
};

async function setup(enabled = true) {
  h = await createDomainHarness({ adjust: pmOnDuty });
  const { session } = seedOperatorRequest(h, 'AR', {
    member: 'pm',
    text: 'Set up the agreement and requested changes.',
  });
  ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
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
/** The waiver rules live in the approval service; the `operate` tool no longer reaches it (decision 66). */
const operate = (operation: OperatorOperation = rename(), title = 'Requested change', plan?: OperatorPlan) =>
  h.domain.operatorActions
    .run('AR', h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!.id, title, operation, plan)
    .catch((err: unknown) => {
      if (err instanceof DomainError) throw new Error(`${err.code}: ${err.message}`);
      throw err;
    });

describe('Operator approval waiver execution', () => {
  it('previews an ordinary change as waiver eligible but waits for the click without a commit path', async () => {
    await setup(false);
    const request = h.repos.operatorRequests.openOfSession(ctx.sessionId)[0]!;
    expect(await h.domain.operatorActions.preview('AR', 'pm', request, rename())).toMatchObject({
      level: 'approval',
      waiverEligible: true,
    });
    const result = await operate();
    expect(result.status).toBe('awaiting_approval');
    expect(
      h.repos.operatorRequests.steps(request.id).find((step) => step.id === result.step_id),
    ).toMatchObject({ agreementVersion: null, approvalMode: null });
  });

  it('keeps a hire without network rights on the click path', async () => {
    await setup();
    const result = await operate({
      op: 'member_hire',
      request: { role: 'developer', handle: 'writer', outboundNetwork: false },
    });
    expect(result.status).toBe('awaiting_approval');
  });

  it.each([
    { op: 'member_update', handle: 'dev-1', changes: { outboundNetwork: false } },
    { op: 'member_update', handle: 'dev-1', changes: { approver: 'none' } },
    { op: 'member_update', handle: 'pm', changes: { model: 'sonnet' } },
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

  it('keeps a closed request on the click path after the preview', async () => {
    await setup();
    const original = h.domain.operatorActions.preview.bind(h.domain.operatorActions);
    vi.spyOn(h.domain.operatorActions, 'preview').mockImplementationOnce(async (...args) => {
      const preview = await original(...args);
      h.repos.operatorRequests.close(args[2].id, new Date().toISOString());
      return preview;
    });
    expect((await operate()).status).toBe('awaiting_approval');
    expect((await h.domain.projects.config('AR')).project.name).not.toBe('Changed name');
    expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
  });

  it.each(['integrator', 'ai'] as const)(
    'rejects %s provenance for both the switch and waived execution',
    async (source) => {
      await setup();
      const actor =
        source === 'integrator'
          ? { ...OWNER_ACTOR, via: 'integrator' as const }
          : { kind: 'ai' as const, handle: 'pm' };
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
      expect((await operate()).status).toBe('awaiting_approval');
      expect(h.repos.operatorRequests.executions('AR')).toHaveLength(0);
    },
  );

  it.each(['project_pause', 'session_stop'] as const)(
    'keeps runtime %s on the click path while waiver is enabled',
    async (op) => {
      await setup();
      const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
      const result = await operate(
        op === 'project_pause' ? { op } : { op, sessionId: session.id },
        'Runtime change',
        { why: 'Owner requested a runtime change', impact: 'Stops work', reversible: true },
      );
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
    const key = await inject(app.app, 'POST', routes.integratorKeys(), cookie, { mode: 'super' });
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
    await domain.members.update('AR', 'pm', { onLeave: false }, by);
    const { session } = seedOperatorRequest(app.app.projectman, 'AR', {
      member: 'pm',
      text: 'Agree to ordinary changes',
    });
    const proposal = await domain.teamTools.proposeOperatorKnowledge(
      { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null },
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
    const enabled = await inject(app.app, 'PUT', routes.operatorApprovalWaiver('AR'), cookie, {
      ...body,
      baseVersion: (await domain.projects.load('AR')).version,
    });
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
