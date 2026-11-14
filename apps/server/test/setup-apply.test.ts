import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_SENDER } from '@projectman/shared';
import type { ProjectManagerAgreementData, ProjectManagerOperation } from '@projectman/shared';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import type { ToolContext } from '../src/contracts';
import { DomainError } from '../src/kernel';

const NOW = '2026-11-14T10:00:00.000Z';
const REQUEST = 'opr_setup_1';
const AGREEMENT: ProjectManagerAgreementData = {
  summary: 'Small steps, weekly review.',
  involvement: 'important',
  extraCritical: [],
};

type SetupApply = Extract<ProjectManagerOperation, { op: 'setup_apply' }>;

/** A package of eleven items: four labels and the project manager's authority, five hires, one member change. */
const BIG: SetupApply = {
  op: 'setup_apply',
  title: 'Team setup',
  patch: {
    projectManagerAuthority: 'owner_request',
    labels: {
      'setup-a': { name: 'Setup A' },
      'setup-b': { name: 'Setup B' },
      'setup-c': { name: 'Setup C' },
      'setup-d': { name: 'Setup D' },
    },
  },
  hires: ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e'].map((handle) => ({ role: 'developer', handle })),
  updates: [{ handle: 'dev-1', changes: { capacity: 3 } }],
  agreement: AGREEMENT,
};

describe('the setup package (PM-1460)', () => {
  let h: DomainHarness;
  let ctx: ToolContext;
  afterEach(() => h?.cleanup());

  beforeEach(async () => {
    h = await createDomainHarness({
      adjust: (config) => {
        const pm = config.team.members.find((candidate) => candidate.handle === 'pm')!;
        if (pm.kind === 'ai') pm.onLeave = false;
      },
    });
    h.repos.users.insert({
      id: 'user-1',
      name: OWNER.name,
      email: OWNER.email,
      passwordHash: 'unused-test-hash',
      createdAt: NOW,
      language: 'hu',
    });
    const { session } = await h.domain.sessions.ensureSession('AR', 'pm', { type: 'general' });
    ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
    h.repos.projectManagerRequests.insert({
      id: REQUEST,
      projectKey: 'AR',
      sessionId: session.id,
      source: 'message',
      messageId: null,
      inboxItemId: null,
      fromHandle: 'owner',
      quote: 'Set the team up.',
      openedAt: new Date().toISOString(),
    });
  });

  const propose = async (operation: ProjectManagerOperation & { title?: string }) => {
    const result = await h.domain.teamTools.operate(ctx, {
      title: operation.title ?? 'Revert the setup',
      operation,
      plan: { why: 'The owner asked for it.', impact: 'The team changes.', reversible: true },
    });
    const operationId = h.repos.projectManagerRequests.steps(REQUEST).at(-1)!.operationId!;
    return { ...result, operationId };
  };
  const answer = (itemId: string, optionId: 'yes' | 'no') =>
    h.domain.inbox.resolve('AR', itemId, { optionId }, { handle: 'owner', access: 'owner' });
  const settled = async (operationId: string) => {
    await vi.waitFor(() =>
      expect(['succeeded', 'failed', 'cancelled', 'unknown']).toContain(
        h.domain.superHandoffs.operation('AR', operationId).state,
      ),
    );
    return h.domain.superHandoffs.operation('AR', operationId);
  };
  const config = () => h.domain.projects.cachedConfig('AR')!;
  const historyLength = async () => (await h.domain.projects.history('AR')).length;
  const pmNotices = () =>
    h.repos.messages
      .list('AR', { between: [SYSTEM_SENDER, 'pm'] })
      .filter((m) => m.from === SYSTEM_SENDER)
      .map((m) => m.body);
  const setupApplied = () =>
    h.domain.timeline.list('AR', {}).filter((event) => event.type === 'setup_applied');

  it('applies a package of more than ten items on one yes, in one configuration commit', async () => {
    const before = await historyLength();
    const proposed = await propose(BIG);
    expect(proposed.status).toBe('awaiting_approval');
    expect(config().team.members.some((m) => m.handle === 'dev-a')).toBe(false);

    await answer(proposed.inbox_item_id!, 'yes');
    expect(await settled(proposed.operationId)).toMatchObject({ state: 'succeeded', errorCode: null });

    expect(await historyLength()).toBe(before + 1);
    expect(
      config()
        .team.members.filter((m) => m.handle.startsWith('dev-'))
        .map((m) => m.handle),
    ).toEqual(expect.arrayContaining(['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e']));
    expect(config().team.members.find((m) => m.handle === 'dev-1')).toMatchObject({ capacity: 3 });
    expect(config().team.projectManagerAuthority).toBe('owner_request');
    expect(config().pipeline.labels.map((label) => label.id)).toEqual(
      expect.arrayContaining(['setup-a', 'setup-b', 'setup-c', 'setup-d']),
    );
    const knowledge = await h.domain.sharedProjectManagerKnowledge.read('AR');
    expect(knowledge.agreement).toMatchObject({ data: AGREEMENT, approvedBy: 'owner' });
    expect(setupApplied()).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          operationId: proposed.operationId,
          hired: ['dev-a', 'dev-b', 'dev-c', 'dev-d', 'dev-e'],
          updated: ['dev-1'],
          agreement: 'written',
        }),
      }),
    ]);
    expect(h.domain.timeline.list('AR', {}).filter((event) => event.type === 'member_hired')).toHaveLength(5);
    await vi.waitFor(() => expect(pmNotices()).toEqual([expect.stringContaining('applied')]));
  });

  it('keeps the configuration when the agreement cannot be written, and tells the project manager', async () => {
    vi.spyOn(h.domain.sharedProjectManagerKnowledge, 'writeAgreement').mockRejectedValue(
      new DomainError('operator_knowledge_stale', 'changed meanwhile', { status: 409 }),
    );
    const before = await historyLength();
    const proposed = await propose(BIG);
    await answer(proposed.inbox_item_id!, 'yes');
    expect(await settled(proposed.operationId)).toMatchObject({ state: 'succeeded' });
    expect(await historyLength()).toBe(before + 1);
    expect(setupApplied()[0]?.data).toMatchObject({
      agreement: 'not_written',
      agreementError: 'operator_knowledge_stale',
    });
    await vi.waitFor(() => expect(pmNotices()).toEqual([expect.stringContaining('NOT written')]));
  });

  it('applies nothing when the configuration changed after the yes was asked for', async () => {
    const proposed = await propose(BIG);
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.project.name = 'Renamed meanwhile';
      return 'Rename';
    });
    const before = await historyLength();
    await answer(proposed.inbox_item_id!, 'yes');
    expect(await settled(proposed.operationId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'super_operation_stale',
    });
    expect(await historyLength()).toBe(before);
    expect(config().team.members.some((m) => m.handle === 'dev-a')).toBe(false);
    await vi.waitFor(() => expect(pmNotices()).toEqual([expect.stringContaining('super_operation_stale')]));
  });

  it('refuses a stale package in its single commit with config_conflict', async () => {
    const stale = (await h.domain.projects.load('AR')).version;
    await h.domain.projects.update('AR', { actor: OWNER_ACTOR, author: OWNER }, (draft) => {
      draft.project.name = 'Renamed meanwhile';
      return 'Rename';
    });
    await expect(
      h.domain.members.applySetup(
        'AR',
        {
          expectedVersion: stale,
          hires: [{ role: 'developer', handle: 'dev-a' }],
          updates: [],
          message: 'x',
        },
        { actor: OWNER_ACTOR, author: OWNER, sponsor: 'owner' },
      ),
    ).rejects.toMatchObject({ code: 'config_conflict' });
    expect(config().team.members.some((m) => m.handle === 'dev-a')).toBe(false);
  });

  it('fails whole on a patch the settings PATCH refuses, applying nothing', async () => {
    const before = await historyLength();
    const proposed = await propose({
      ...BIG,
      title: 'With an unknown repository',
      patch: { repoDocs: [{ repo: 'ghost', docs: null }] },
    });
    await answer(proposed.inbox_item_id!, 'yes');
    expect(await settled(proposed.operationId)).toMatchObject({ state: 'failed', errorCode: 'unknown_repo' });
    expect(await historyLength()).toBe(before);
    expect(config().team.members.some((m) => m.handle === 'dev-a')).toBe(false);
    expect(setupApplied()).toEqual([]);
  });

  it.each<{ change: string; part: Partial<SetupApply> }>([
    { change: 'machine_access', part: { updates: [{ handle: 'dev-1', changes: { machineAccess: true } }] } },
    { change: 'permissions', part: { updates: [{ handle: 'dev-1', changes: { permissionMode: 'plan' } }] } },
    {
      change: 'boundary',
      part: {
        patch: {
          roleOverrides: {
            developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
          },
        },
      },
    },
  ])('refuses an owner-only $change change before recording anything', async ({ part }) => {
    const operation: SetupApply = { op: 'setup_apply', title: 'Owner only', hires: [], updates: [], ...part };
    await expect(propose(operation)).rejects.toMatchObject({
      message: expect.stringContaining('setup_owner_only_step'),
    });
    expect(h.repos.superHandoffs.openOperations()).toEqual([]);
    expect(h.repos.inbox.listOpen('question').filter((item) => item.projectKey === 'AR')).toEqual([]);
  });

  it('replaces the earlier waiting package: its question closes and its yes no longer runs it', async () => {
    const first = await propose({ ...BIG, title: 'First' });
    const second = await propose({ ...BIG, title: 'Second' });
    expect(h.domain.superHandoffs.operation('AR', first.operationId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'super_operation_superseded',
    });
    expect(h.repos.inbox.get(first.inbox_item_id!)?.state).not.toBe('open');
    await expect(answer(first.inbox_item_id!, 'yes')).rejects.toBeInstanceOf(Error);
    expect(h.domain.superHandoffs.operation('AR', second.operationId).state).toBe('waiting_owner');
    expect(pmNotices()).toEqual([]);
  });

  it('is undone by one config_revert to its previous version, the removal of its hire on the owner’s yes (PM-1463)', async () => {
    const before = await h.domain.projects.load('AR');
    const proposed = await propose({ ...BIG, hires: [{ role: 'developer', handle: 'dev-a' }] });
    await answer(proposed.inbox_item_id!, 'yes');
    expect(await settled(proposed.operationId)).toMatchObject({ state: 'succeeded' });
    await vi.waitFor(() => expect(pmNotices()).toEqual([expect.stringContaining(before.version)]));

    const reverted = await propose({ op: 'config_revert', version: before.version });
    expect(h.domain.superHandoffs.operation('AR', reverted.operationId).state).toBe('waiting_owner');
    await answer(reverted.inbox_item_id!, 'yes');
    expect(await settled(reverted.operationId)).toMatchObject({ state: 'succeeded' });
    expect(config().pipeline).toEqual(before.config.pipeline);
    expect(config().team.members).toEqual(before.config.team.members);
  });

  it('tells the project manager when the owner says no', async () => {
    const proposed = await propose(BIG);
    await answer(proposed.inbox_item_id!, 'no');
    expect(h.domain.superHandoffs.operation('AR', proposed.operationId)).toMatchObject({
      state: 'cancelled',
      errorCode: 'owner_declined',
    });
    await vi.waitFor(() => expect(pmNotices()).toEqual([expect.stringContaining('owner_declined')]));
  });
});
