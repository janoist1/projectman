import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_OPERATOR_PREFERENCE,
  memberOf,
  operatorKnowledgeApprovalOf,
  operatorKnowledgeContinuationMessageId,
  ProposeOperatorKnowledgeRequest,
  roleBundle,
} from '@projectman/shared';
import type { AiMemberConfig, OperatorKnowledgeChange, OperatorOperation, Session } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createContextPackBuilder } from '../src/context';
import { humanActor } from '../src/kernel';
import { OperatorRequests } from '../src/services/operator';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush, settle } from './helpers/fakes';

let h: DomainHarness;
let ctx: ToolContext;
const owner = { handle: 'owner', access: 'owner' as const };
const agreement: OperatorKnowledgeChange = {
  kind: 'agreement_replace',
  agreement: {
    summary: 'Ask before critical steps. PRIVATE_AGREEMENT',
    involvement: 'important',
    extraCritical: ['Release'],
  },
};
const principle: OperatorKnowledgeChange = {
  kind: 'principle_put',
  principle: {
    id: null,
    example: 'A concrete example',
    principle: 'PRIVATE_PRINCIPLE',
    effect: 'Explain partial results',
  },
};
const network: OperatorOperation = {
  op: 'member_update',
  handle: 'dev-1',
  changes: { outboundNetwork: false },
};
const immediate: OperatorOperation = { op: 'member_update', handle: 'dev-1', changes: { model: 'sonnet' } };
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(persistent = false) {
  h = await createDomainHarness({
    persistent,
    adjust(config) {
      config.team.members.push({
        kind: 'human',
        handle: 'ada',
        displayName: 'Ada',
        access: 'admin',
        roles: [],
        email: 'ada@example.test',
      });
      config.team.members.push({
        kind: 'human',
        handle: 'cleo',
        displayName: 'Cleo',
        access: 'client',
        roles: [],
        email: 'cleo@example.test',
      });
    },
  });
  await h.domain.messaging.sendReporting(
    'AR',
    'owner',
    { to: ['operator'], text: 'Propose an agreement' },
    { awaitWake: true },
  );
  await flush();
  const session = h.domain.sessions.list('AR', { member: 'operator' })[0]!;
  ctx = { projectKey: 'AR', member: 'operator', sessionId: session.id, taskKey: null };
}
function propose(change = agreement, operations: OperatorOperation[] = [], revision = 0) {
  return h.domain.teamTools.proposeOperatorKnowledge(ctx, {
    expected_revision: revision,
    title: 'Proposed knowledge',
    change,
    operations,
  });
}
const resolve = (id: string, optionId = 'approve', by = owner) =>
  h.domain.inbox.resolve('AR', id, { optionId }, by);
const document = () => h.domain.operatorKnowledge.readKnowledge('AR');
const payload = (id: string) => operatorKnowledgeApprovalOf(h.domain.inbox.get('AR', id))!;

describe('owner-approved Operator knowledge', () => {
  it('stores targeted agreement operations and replays them against fresh unrelated role overrides', async () => {
    await setup();
    const before = await h.domain.projects.load('AR');
    await h.domain.projects.patch(
      'AR',
      {
        baseVersion: before.version,
        roleOverrides: {
          developer: { ...roleBundle(before.config, 'developer'), instructions: 'Original instructions.' },
          architect: { ...roleBundle(before.config, 'architect'), instructions: 'Original architect.' },
        },
      },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    const read = await h.domain.teamTools.getRoleConfiguration(ctx, { role: 'developer' });
    const operation: OperatorOperation = {
      op: 'config_patch',
      patch: {
        roleOverrides: {
          developer: { ...read.effective, instructions: read.effective.instructions + '\nAdded rule.' },
        },
      },
    };
    const proposal = await propose(agreement, [operation]);
    expect(payload(proposal.inbox_item_id).operations).toEqual([operation]);
    await resolve(proposal.inbox_item_id);
    const approved = payload(proposal.inbox_item_id);
    const loaded = await h.domain.projects.load('AR');
    await h.domain.projects.patch(
      'AR',
      {
        baseVersion: loaded.version,
        roleOverrides: {
          ...loaded.config.team.roleOverrides,
          architect: {
            ...roleBundle(loaded.config, 'architect'),
            instructions: 'Changed after agreement approval.',
          },
        },
      },
      { actor: OWNER_ACTOR, author: OWNER },
    );
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    h.domain.messages.markRecipientDelivered(operatorKnowledgeContinuationMessageId(approved.id), 'operator');
    expect(
      await h.domain.teamTools.operate(ctx, { title: 'Extend developer instructions', operation }),
    ).toMatchObject({ status: 'done' });
    const saved = (await h.domain.projects.config('AR')).team.roleOverrides!;
    expect(saved.developer?.instructions).toBe('Original instructions.\nAdded rule.');
    expect(saved.architect?.instructions).toBe('Changed after agreement approval.');
    expect(payload(proposal.inbox_item_id).operations).toEqual([operation]);
  });
  it('does not load or lock projects without pending knowledge approvals during recovery', async () => {
    await setup();
    const lock = vi.spyOn(h.domain.projects, 'withConfigurationLock');
    await h.domain.sharedOperatorKnowledge.recover();
    expect(lock).not.toHaveBeenCalled();
  });

  it('recovers a committed approval even when another project cannot load its configuration', async () => {
    await setup();
    const proposal = await propose();
    const apply = h.domain.operatorKnowledge.compareAndSwapKnowledge.bind(h.domain.operatorKnowledge);
    const crash = vi
      .spyOn(h.domain.operatorKnowledge, 'compareAndSwapKnowledge')
      .mockImplementationOnce(async (...args) => {
        await apply(...args);
        throw new Error('crash after file write');
      });
    await expect(resolve(proposal.inbox_item_id)).rejects.toThrow('crash after file write');
    crash.mockRestore();
    await h.domain.projects.create(
      { key: 'BR', name: 'broken', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    const item = h.domain.inbox.get('AR', proposal.inbox_item_id);
    h.domain.inbox.create({ ...item, id: undefined, projectKey: 'BR', state: 'open' });
    const summaries = h.domain.projects.summaries();
    vi.spyOn(h.domain.projects, 'summaries').mockReturnValue(
      [...summaries].sort((a, b) => b.key.localeCompare(a.key)),
    );
    const lock = h.domain.projects.withConfigurationLock.bind(h.domain.projects);
    vi.spyOn(h.domain.projects, 'withConfigurationLock').mockImplementation((key, work) => {
      if (key === 'BR') return Promise.reject(new Error('broken project configuration'));
      return lock(key, work);
    });

    await h.domain.sharedOperatorKnowledge.recover();
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id)).toMatchObject({
      state: 'resolved',
      resolution: { by: 'owner', optionId: 'approve' },
    });
    expect((await document()).revision).toBe(1);
    expect(h.log.warnings).toContainEqual([
      { err: expect.any(Error), projectKey: 'BR' },
      'could not recover operator knowledge',
    ]);
  });

  it('starts the server when a stored project configuration is unavailable', async () => {
    await setup(true);
    const proposal = await propose();
    h = await restartDomainHarness(h, {
      configStore: (inner) => ({
        ...inner,
        async load(key) {
          if (key === 'AR') throw new Error('unavailable project configuration');
          return inner.load(key);
        },
      }),
    });
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id).state).toBe('open');
    expect(h.log.errors).toEqual([
      [{ err: expect.any(Error), projectKey: 'AR' }, 'could not load project configuration'],
    ]);
    h.log.errors.length = 0;
    for (const message of ['could not recover operator knowledge', 'operator continuation wake failed'])
      expect(h.log.warnings).toContainEqual([{ err: expect.any(Error), projectKey: 'AR' }, message]);
  });

  it('persists nothing before approval and blocks even immediate operations of its pending request', async () => {
    await setup();
    const before = await h.domain.projects.load('AR');
    const proposal = await propose(agreement, [immediate, network]);
    expect(await document()).toMatchObject({ revision: 0, agreement: null, principles: [] });
    await expect(access(join(h.dir, 'operator-data/AR/knowledge.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await h.domain.projects.load('AR')).toEqual(before);
    expect(payload(proposal.inbox_item_id)).toMatchObject({
      applying: null,
      baseRevision: 0,
      baseConfigVersion: before.version,
      changes: [
        expect.objectContaining({ field: 'model', after: 'sonnet', level: 'now' }),
        expect.objectContaining({ field: 'outboundNetwork', after: 'false', level: 'approval' }),
      ],
    });
    await expect(h.domain.teamTools.operate(ctx, { title: 'Model', operation: immediate })).rejects.toThrow(
      'operator_agreement_pending',
    );
    await resolve(proposal.inbox_item_id);
    expect(await document()).toMatchObject({
      revision: 1,
      agreement: { version: 1, approvedBy: 'owner', data: agreement.agreement },
      appliedProposalIds: [payload(proposal.inbox_item_id).id],
    });
    expect(await h.domain.projects.load('AR')).toEqual(before);
    const event = h.domain.timeline
      .list('AR', { limit: 100 })
      .find((entry) => entry.type === 'operator_knowledge_changed')!;
    expect(event.actor).toEqual(humanActor('owner'));
    expect(event.data).toEqual({
      proposalId: payload(proposal.inbox_item_id).id,
      kind: 'agreement_replace',
      revision: 1,
      agreementVersion: 1,
    });
    expect(JSON.stringify(event)).not.toContain('PRIVATE_AGREEMENT');
  });

  it('rejects AI, admin and integrator decisions, including forged access', async () => {
    await setup();
    const proposal = await propose();
    for (const by of [
      { handle: 'dev-1', access: 'owner' as const },
      { handle: 'ada', access: 'owner' as const },
      { ...owner, via: 'integrator' as const },
    ]) {
      for (const option of ['approve', 'reject', 'dismiss'])
        await expect(resolve(proposal.inbox_item_id, option, by)).rejects.toMatchObject({ status: 403 });
      expect(payload(proposal.inbox_item_id).applying).toBeNull();
    }
    expect((await document()).revision).toBe(0);
    await resolve(proposal.inbox_item_id, 'reject');
    expect((await document()).revision).toBe(0);
    expect(h.repos.operatorRequests.steps(payload(proposal.inbox_item_id).requestId)).toContainEqual(
      expect.objectContaining({ action: 'knowledge_change', status: 'rejected' }),
    );
  });

  it('allows one of concurrent approvals, makes other base revisions stale, and does not replay a decision', async () => {
    await setup();
    const first = await propose();
    const second = await propose(principle);
    const results = await Promise.allSettled([resolve(first.inbox_item_id), resolve(second.inbox_item_id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect((await document()).revision).toBe(1);
    const staleId = results[0]!.status === 'rejected' ? first.inbox_item_id : second.inbox_item_id;
    const doneId = staleId === first.inbox_item_id ? second.inbox_item_id : first.inbox_item_id;
    expect(payload(staleId).stale?.reason).toBe('knowledge_changed');
    await expect(resolve(doneId)).rejects.toMatchObject({ code: 'inbox_item_closed' });
    await expect(resolve(staleId)).rejects.toMatchObject({ code: 'operator_knowledge_stale' });
    await resolve(staleId, 'dismiss');
    expect((await document()).revision).toBe(1);
    expect(
      h.domain.timeline
        .list('AR', { limit: 100 })
        .filter((event) => event.type === 'operator_knowledge_changed'),
    ).toHaveLength(1);
  });

  it('detects configuration changes under the common commit lock and writes no knowledge', async () => {
    await setup();
    const proposal = await propose(agreement, [network]);
    let unlock!: () => void;
    const held = new Promise<void>((done) => {
      unlock = done;
    });
    let entered!: () => void;
    const inside = new Promise<void>((done) => {
      entered = done;
    });
    const locked = h.domain.projects.withConfigurationLock('AR', async () => {
      entered();
      await held;
    });
    await inside;
    let committed = false;
    const patch = h.domain.projects
      .patch(
        'AR',
        { baseVersion: (await h.domain.projects.load('AR')).version, limits: { maxConcurrentAi: 6 } },
        { actor: OWNER_ACTOR, author: OWNER },
      )
      .then(() => {
        committed = true;
      });
    await settle();
    expect(committed).toBe(false);
    unlock();
    await locked;
    await patch;
    await expect(resolve(proposal.inbox_item_id)).rejects.toMatchObject({ code: 'operator_knowledge_stale' });
    expect(payload(proposal.inbox_item_id).stale?.reason).toBe('config_changed');
    expect((await document()).revision).toBe(0);
  });

  it('generates principle ids, preserves agreement versions and removes a principle from the next context', async () => {
    await setup();
    await resolve((await propose()).inbox_item_id);
    const put = await propose(principle, [], 1);
    expect(payload(put.inbox_item_id).change).toMatchObject({
      principle: { id: expect.stringMatching(/^olp_/) },
    });
    await resolve(put.inbox_item_id);
    let data = await document();
    expect(data).toMatchObject({
      revision: 2,
      agreement: { version: 1 },
      principles: [{ approvedBy: 'owner' }],
    });
    await resolve(
      (await propose({ kind: 'principle_remove', id: data.principles[0]!.id }, [], 2)).inbox_item_id,
    );
    data = await document();
    expect(data).toMatchObject({ revision: 3, agreement: { version: 1 }, principles: [] });
    const next = await h.domain.sharedOperatorKnowledge.forConversation(
      'AR',
      'operator',
      { type: 'general' },
      null,
    );
    expect(next).toMatchObject({ revision: 3, principles: [] });
    expect(JSON.stringify(next)).not.toContain('PRIVATE_PRINCIPLE');
    await resolve((await propose(agreement, [], 3)).inbox_item_id);
    expect((await document()).agreement?.version).toBe(2);
  });

  it.each(['before', 'after'] as const)(
    'recovers a crash %s the private file write without granting a new approval',
    async (phase) => {
      await setup(true);
      const proposal = await propose(agreement, [immediate]);
      const apply = h.domain.operatorKnowledge.compareAndSwapKnowledge.bind(h.domain.operatorKnowledge);
      const spy = vi
        .spyOn(h.domain.operatorKnowledge, 'compareAndSwapKnowledge')
        .mockImplementationOnce(async (...args) => {
          expect(payload(proposal.inbox_item_id).applying).toMatchObject({
            by: 'owner',
            at: expect.any(String),
          });
          if (phase === 'after') await apply(...args);
          throw new Error('simulated process crash');
        });
      await expect(resolve(proposal.inbox_item_id)).rejects.toThrow('simulated process crash');
      spy.mockRestore();
      expect(h.domain.inbox.get('AR', proposal.inbox_item_id).state).toBe('open');
      h = await restartDomainHarness(h);
      const item = h.domain.inbox.get('AR', proposal.inbox_item_id);
      if (phase === 'after') {
        expect(item).toMatchObject({ state: 'resolved', resolution: { by: 'owner', optionId: 'approve' } });
        expect((await document()).revision).toBe(1);
        await h.domain.sharedOperatorKnowledge.recover();
        expect((await document()).revision).toBe(1);
        expect(
          h.domain.timeline
            .list('AR', { limit: 100 })
            .filter((event) => event.type === 'operator_knowledge_changed'),
        ).toHaveLength(1);
      } else {
        expect(item.state).toBe('open');
        expect(payload(item.id).applying).toBeNull();
        expect((await document()).revision).toBe(0);
        await resolve(item.id);
        expect((await document()).revision).toBe(1);
      }
      expect(h.repos.operatorRequests.steps(payload(item.id).requestId)).toContainEqual(
        expect.objectContaining({ status: 'approved', action: 'knowledge_change' }),
      );
    },
  );

  it('refuses forbidden operations, nonagreement operations, stale CAS and nonexistent removals before creating an inbox item', async () => {
    await setup();
    await expect(
      propose(agreement, [{ op: 'member_update', handle: 'owner', changes: { model: 'sonnet' } }]),
    ).rejects.toThrow('operator_never');
    await expect(propose(principle, [immediate])).rejects.toThrow('invalid_request');
    await expect(propose(agreement, [], 9)).rejects.toThrow('operator_knowledge_stale');
    await expect(propose({ kind: 'principle_remove', id: 'unknown' })).rejects.toThrow('invalid_request');
    expect(h.repos.inbox.listOpen('approval')).toHaveLength(0);
    expect((await document()).revision).toBe(0);
    expect(
      ProposeOperatorKnowledgeRequest.safeParse({
        expected_revision: 0,
        title: 'Proposal',
        change: { ...agreement, approvedBy: 'owner' },
      }).success,
    ).toBe(false);
  });

  it('rolls back inbox closure and its audit together when post-CAS result recording crashes', async () => {
    await setup(true);
    const proposal = await propose(agreement, [immediate]);
    const spy = vi.spyOn(h.domain.messages, 'record').mockImplementationOnce(() => {
      throw new Error('crash while closing approved inbox');
    });
    await expect(resolve(proposal.inbox_item_id)).rejects.toThrow('crash while closing approved inbox');
    spy.mockRestore();
    expect((await document()).revision).toBe(1);
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id).state).toBe('open');
    expect(
      h.domain.timeline
        .list('AR', { limit: 100 })
        .filter((event) => event.type === 'operator_knowledge_changed'),
    ).toHaveLength(0);
    h = await restartDomainHarness(h);
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id)).toMatchObject({
      state: 'resolved',
      resolution: { by: 'owner' },
    });
    expect((await document()).revision).toBe(1);
    expect(
      h.domain.timeline
        .list('AR', { limit: 100 })
        .filter((event) => event.type === 'operator_knowledge_changed'),
    ).toHaveLength(1);
  });

  it('never treats an application marker without a recorded human apply as approval', async () => {
    await setup();
    const proposal = await propose();
    const data = await document();
    await h.domain.operatorKnowledge.compareAndSwapKnowledge('AR', 0, {
      ...data,
      revision: 1,
      appliedProposalIds: [payload(proposal.inbox_item_id).id],
    });
    await h.domain.sharedOperatorKnowledge.recover();
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id)).toMatchObject({
      state: 'open',
      resolution: null,
    });
    expect(payload(proposal.inbox_item_id).applying).toBeNull();
    expect(
      h.domain.timeline
        .list('AR', { limit: 100 })
        .some((event) => event.type === 'operator_knowledge_changed'),
    ).toBe(false);
    await expect(resolve(proposal.inbox_item_id)).rejects.toMatchObject({ code: 'operator_knowledge_stale' });
  });
});

describe('shared knowledge session boundaries', () => {
  it('keeps critical continuation operations behind a plan and a separate owner approval', async () => {
    await setup();
    const operation: OperatorOperation = { op: 'message_send', to: ['ada'], text: 'Approved exact message' };
    const plan = { why: 'Inform the admin', impact: 'Sends this exact message to Ada', reversible: false };
    const proposal = await propose(agreement, [operation]);
    await expect(
      h.domain.teamTools.operate(ctx, { title: 'Before agreement approval', operation, plan }),
    ).rejects.toThrow('operator_agreement_pending');
    const sent = () => h.domain.messages.list('AR', {}).filter((message) => message.body === operation.text);
    expect(sent()).toHaveLength(0);
    await resolve(proposal.inbox_item_id);
    const messageId = operatorKnowledgeContinuationMessageId(payload(proposal.inbox_item_id).id);
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    h.domain.messages.markRecipientDelivered(messageId, 'operator');
    const request = requests.openFor(ctx.sessionId)!;
    expect(request.source).toBe('approval');
    await expect(
      h.domain.operatorActions.run('AR', request.id, 'Missing plan', operation),
    ).rejects.toMatchObject({ code: 'operator_plan_required' });
    await expect(
      h.domain.operatorActions.run(
        'AR',
        request.id,
        'Unstored message',
        {
          ...operation,
          text: 'Changed message',
        },
        plan,
      ),
    ).rejects.toMatchObject({ code: 'operator_no_request' });
    const critical = await h.domain.teamTools.operate(ctx, {
      title: 'Stored critical message',
      operation,
      plan,
    });
    expect(critical.status).toBe('awaiting_approval');
    expect(sent()).toHaveLength(0);
    await expect(
      h.domain.inbox.resolve(
        'AR',
        critical.inbox_item_id!,
        { optionId: 'approve' },
        { handle: 'ada', access: 'admin' },
      ),
    ).rejects.toThrow();
    expect(sent()).toHaveLength(0);
    await resolve(critical.inbox_item_id!);
    expect(sent()).toHaveLength(1);
    await expect(resolve(critical.inbox_item_id!)).rejects.toMatchObject({ code: 'inbox_item_closed' });
    expect(sent()).toHaveLength(1);
  });

  it.each(['operator', 'pm'])(
    'launches %s without shared knowledge when its file is corrupt',
    async (handle) => {
      h = await createDomainHarness({
        adjust(config) {
          const pm = config.team.members.find((member) => member.handle === 'pm')!;
          if (pm.kind === 'ai') pm.onLeave = false;
        },
      });
      const directory = join(h.dir, 'operator-data', 'AR');
      const file = join(directory, 'knowledge.json');
      await mkdir(directory, { recursive: true });
      await writeFile(file, '{partial');
      const { session } = await h.domain.sessions.ensureSession(
        'AR',
        handle,
        { type: 'general' },
        { cause: { kind: 'conversation', by: humanActor('owner') } },
      );
      expect(h.runner.started.some((start) => start.sessionId === session.id)).toBe(true);
      const input = h.contextBuilder.inputs.at(-1)!;
      expect(input).not.toHaveProperty('operatorKnowledge');
      expect(createContextPackBuilder().build(input).appendSystemPrompt).not.toContain(
        '# Approved shared Operator knowledge',
      );
      expect(h.log.warnings).toContainEqual([
        { err: expect.objectContaining({ code: 'operator_knowledge_invalid' }), member: handle },
        'could not read operator knowledge',
      ]);
      await expect(document()).rejects.toMatchObject({ code: 'operator_knowledge_invalid' });
      expect(await readFile(file, 'utf8')).toBe('{partial');
    },
  );

  it('opens one scoped approval continuation and keeps protected operations behind a separate owner decision', async () => {
    await setup(true);
    const proposal = await propose(agreement, [immediate, network]);
    await resolve(proposal.inbox_item_id);
    const approved = payload(proposal.inbox_item_id);
    const messageId = operatorKnowledgeContinuationMessageId(approved.id);
    const message = h.domain.messages.get(messageId)!;
    expect(message).toMatchObject({
      from: 'owner',
      origin: {
        kind: 'operator_knowledge_approval',
        inboxItemId: proposal.inbox_item_id,
      },
    });
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    h.domain.messages.markRecipientDelivered(messageId, 'operator');
    const request = requests.openFor(ctx.sessionId)!;
    expect(request).toMatchObject({
      source: 'approval',
      fromHandle: 'owner',
      inboxItemId: proposal.inbox_item_id,
    });
    for (const write of [
      () => propose(principle, [], 1),
      () =>
        h.domain.teamTools.setOperatorPreference(ctx, {
          expectedRevision: 0,
          preference: { ...DEFAULT_OPERATOR_PREFERENCE },
        }),
      () => h.domain.teamTools.saveMemory(ctx, { note: 'Expand authority' }),
      () =>
        h.domain.teamTools.sendMessage(ctx, {
          to: ['owner'],
          text: 'Unstored signal',
          kind: 'info',
          signalId: 'sig_forged',
        }),
      () =>
        h.domain.teamTools.operate(ctx, {
          title: 'Unstored operation',
          operation: { ...network, changes: { outboundNetwork: true } },
        }),
    ])
      await expect(write()).rejects.toThrow('operator_no_request');
    await expect(
      h.domain.teamTools.startMember(ctx, { member: 'dev-1', text: 'Unstored work', signalId: 'sig_forged' }),
    ).rejects.toThrow('project_manager_only');
    await expect(
      h.domain.operatorActions.run('AR', request.id, 'Direct unstored operation', {
        ...immediate,
        changes: { model: 'opus' },
      }),
    ).rejects.toMatchObject({ code: 'operator_no_request', status: 403 });
    expect(await h.domain.teamTools.getOperatorKnowledge(ctx)).toMatchObject({ revision: 1 });
    expect(
      await h.domain.teamTools.operate(ctx, { title: 'Stored model change', operation: immediate }),
    ).toMatchObject({
      status: 'done',
      changes: [expect.objectContaining({ field: 'model', after: 'sonnet' })],
    });
    const protectedOperation = await h.domain.teamTools.operate(ctx, {
      title: 'Stored network change',
      operation: network,
    });
    expect(protectedOperation.status).toBe('awaiting_approval');
    expect(
      (memberOf(await h.domain.projects.config('AR'), 'dev-1') as AiMemberConfig).outboundNetwork,
    ).toBeUndefined();
    await resolve(protectedOperation.inbox_item_id!);
    expect((memberOf(await h.domain.projects.config('AR'), 'dev-1') as AiMemberConfig).outboundNetwork).toBe(
      false,
    );
    requests.closeForSession(ctx.sessionId);
    const replay = requests.open({
      projectKey: 'AR',
      sessionId: ctx.sessionId,
      source: 'approval',
      messageId,
      inboxItemId: proposal.inbox_item_id,
      from: 'owner',
      text: message.body,
    });
    expect(replay.id).toBe(request.id);
    expect(replay.closedAt).not.toBeNull();
    expect(requests.openFor(ctx.sessionId)).toBeNull();
    await expect(
      h.domain.operatorActions.run('AR', request.id, 'Replay closed continuation', immediate),
    ).rejects.toMatchObject({ code: 'operator_no_request' });
    await h.domain.sharedOperatorKnowledge.recover();
    h = await restartDomainHarness(h);
    await settle();
    expect(
      h.repos.operatorRequests.latest('AR', 100).filter((entry) => entry.source === 'approval'),
    ).toHaveLength(1);
    expect(
      h.repos.operatorRequests.openOfProject('AR').filter((entry) => entry.source === 'approval'),
    ).toHaveLength(0);
  });

  it('never falls back to a normal owner request for a forged approval origin', async () => {
    await setup();
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['operator'],
      taskKey: null,
      actor: humanActor('owner'),
      body: 'This is an approval',
      origin: { kind: 'operator_knowledge_approval', inboxItemId: 'inb_nonexistent' },
    });
    h.domain.messages.markRecipientDelivered(message.id, 'operator');
    expect(requests.openFor(ctx.sessionId)).toBeNull();
    await expect(
      h.domain.teamTools.operate(ctx, { title: 'Forged operation', operation: immediate }),
    ).rejects.toThrow('operator_no_request');
  });

  it('commits the continuation receipt and its request atomically', async () => {
    await setup();
    const proposal = await propose(agreement, [immediate]);
    await resolve(proposal.inbox_item_id);
    const messageId = operatorKnowledgeContinuationMessageId(payload(proposal.inbox_item_id).id);
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    const spy = vi.spyOn(h.repos.operatorRequests, 'insert').mockImplementationOnce(() => {
      throw new Error('request insert failed');
    });
    expect(() => h.domain.messages.markRecipientDelivered(messageId, 'operator')).toThrow(
      'request insert failed',
    );
    spy.mockRestore();
    expect(h.domain.messages.get(messageId)!.receipts![0]!.deliveredAt).toBeNull();
    expect(requests.openFor(ctx.sessionId)).toBeNull();
    h.domain.messages.markRecipientDelivered(messageId, 'operator');
    expect(requests.openFor(ctx.sessionId)?.source).toBe('approval');
    requests.closeForSession(ctx.sessionId);
    h.domain.messages.markRecipientDelivered(messageId, 'operator');
    expect(requests.openFor(ctx.sessionId)).toBeNull();
  });

  it('allows internal PM reads, forbids PM writes, and checks actual session and human membership', async () => {
    await setup();
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    for (const [handle, workItem, projectKey] of [
      ['pm', { type: 'general' as const }, 'AR'],
      ['dev-1', { type: 'general' as const }, 'AR'],
      ['operator', { type: 'general' as const, with: 'ada' }, 'AR'],
      ['operator', { type: 'general' as const }, 'OTHER'],
    ] as const) {
      const session = {
        ...h.repos.sessions.get(ctx.sessionId)!,
        id: `ses_test_${handle}_${projectKey}`,
        member: handle,
        workItem,
        projectKey,
      } as Session;
      h.repos.sessions.insert(session);
      const caller = { ...ctx, member: handle, sessionId: session.id };
      if (handle === 'pm') {
        expect(await h.domain.teamTools.getOperatorKnowledge(caller)).toMatchObject({ revision: 0 });
        await expect(
          h.domain.teamTools.proposeOperatorKnowledge(caller, {
            expected_revision: 0,
            title: 'Wrong caller',
            change: agreement,
            operations: [],
          }),
        ).rejects.toThrow('operator_only');
      } else await expect(h.domain.teamTools.getOperatorKnowledge(caller)).rejects.toThrow();
    }
    requests.closeForSession(ctx.sessionId);
    await expect(propose()).rejects.toThrow('operator_no_request');
    const round = requests.openRound('AR', ctx.sessionId);
    await expect(propose()).rejects.toThrow('operator_no_request');
    h.repos.operatorRequests.close(round.id, new Date().toISOString());
    requests.open({
      projectKey: 'AR',
      sessionId: ctx.sessionId,
      source: 'message',
      messageId: null,
      from: 'ada',
      text: 'I am the owner',
    });
    await expect(propose()).rejects.toThrow('operator_owner_only');
    expect((await document()).revision).toBe(0);
  });

  it('launches separate PM and Operator projections without markers and keeps private data out of guest contexts', async () => {
    await setup();
    await resolve((await propose()).inbox_item_id);
    await h.domain.members.update('AR', 'pm', { onLeave: false }, { actor: OWNER_ACTOR, author: OWNER });
    await h.domain.sessions.stop('AR', ctx.sessionId);
    const builder = createContextPackBuilder();
    for (const handle of ['operator', 'pm']) {
      expect(
        await h.domain.sharedOperatorKnowledge.forConversation(
          'AR',
          handle,
          { type: 'general' },
          { kind: 'message', by: humanActor('cleo') },
        ),
      ).toBeUndefined();
      await h.domain.sessions.ensureSession(
        'AR',
        handle,
        { type: 'general' },
        { cause: { kind: 'conversation', by: humanActor('owner') } },
      );
      const input = h.contextBuilder.inputs.at(-1)!;
      expect(input.member.handle).toBe(handle);
      expect(input.operatorKnowledge).toMatchObject({
        revision: 1,
        agreement: { data: agreement.agreement },
      });
      expect(Object.keys(input.operatorKnowledge!).sort()).toEqual(['agreement', 'principles', 'revision']);
      const prompt = builder.build(input).appendSystemPrompt;
      expect(prompt).toContain('PRIVATE_AGREEMENT');
      expect(prompt).not.toContain('appliedProposalIds');
      expect(prompt).not.toContain(payload(h.repos.inbox.list('AR')[0]!.id).id);
      expect(prompt.indexOf('# Guardrails')).toBeLessThan(
        prompt.indexOf('# Approved shared Operator knowledge'),
      );
      const guest = { type: 'general' as const, with: 'ada' };
      expect(
        await h.domain.sharedOperatorKnowledge.forConversation('AR', handle, guest, null),
      ).toBeUndefined();
      expect(builder.build({ ...input, workItem: guest }).appendSystemPrompt).not.toContain(
        'PRIVATE_AGREEMENT',
      );
    }
    await h.domain.messaging.sendReporting(
      'AR',
      'cleo',
      { to: ['operator'], text: 'Guest conversation' },
      { awaitWake: true },
    );
    const guestInput = h.contextBuilder.inputs.at(-1)!;
    expect(guestInput.workItem).toMatchObject({ type: 'general', with: 'cleo' });
    expect(guestInput.operatorKnowledge).toBeUndefined();
    expect(builder.build(guestInput).appendSystemPrompt).not.toContain('PRIVATE_AGREEMENT');
    for (const handle of ['operator', 'pm']) {
      expect(
        await h.domain.sharedOperatorKnowledge.forConversation(
          'AR',
          handle,
          { type: 'general' },
          { kind: 'message', by: humanActor('not-a-member') },
        ),
      ).toBeUndefined();
      expect(
        await h.domain.sharedOperatorKnowledge.forConversation(
          'AR',
          handle,
          { type: 'general' },
          { kind: 'message', by: humanActor('dev-1') },
        ),
      ).toBeUndefined();
      expect(
        await h.domain.sharedOperatorKnowledge.forConversation(
          'AR',
          handle,
          { type: 'general' },
          { kind: 'message', by: { ...humanActor('owner'), via: 'integrator' } },
        ),
      ).toBeUndefined();
    }
    const file = await readFile(join(h.dir, 'operator-data/AR/knowledge.json'), 'utf8');
    expect(file).toContain('appliedProposalIds');
  });
});
