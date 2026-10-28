import { afterEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { operatorKnowledgeApprovalOf, ProposeOperatorKnowledgeRequest } from '@projectman/shared';
import type { OperatorKnowledgeChange, OperatorOperation, Session } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createContextPackBuilder } from '../src/context';
import { humanActor } from '../src/kernel';
import { OperatorRequests } from '../src/services/operator';
import {
  createDomainHarness,
  OWNER,
  OWNER_ACTOR,
  restartDomainHarness,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { seedOperatorRequest } from './helpers/operator-session';

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
      // A client may message only the contacts.
      config.team.contacts = ['pm'];
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
    },
  });
  const { session } = seedOperatorRequest(h, 'AR', { text: 'Propose an agreement', member: 'pm' });
  ctx = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
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
    expect(h.log.warnings).toContainEqual([
      { err: expect.any(Error), projectKey: 'AR' },
      'could not recover operator knowledge',
    ]);
  });

  it('persists nothing before approval', async () => {
    await setup();
    const before = await h.domain.projects.load('AR');
    const proposal = await propose(agreement);
    expect(await document()).toMatchObject({ revision: 0, agreement: null, principles: [] });
    await expect(access(join(h.dir, 'operator-data/AR/knowledge.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await h.domain.projects.load('AR')).toEqual(before);
    expect(payload(proposal.inbox_item_id)).toMatchObject({
      applying: null,
      baseRevision: 0,
      baseConfigVersion: null,
    });
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

  it('generates principle ids, preserves agreement versions and removes a principle from the next context', async () => {
    await setup();
    await resolve((await propose()).inbox_item_id);
    const put = await propose(principle, undefined, 1);
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
      (await propose({ kind: 'principle_remove', id: data.principles[0]!.id }, undefined, 2)).inbox_item_id,
    );
    data = await document();
    expect(data).toMatchObject({ revision: 3, agreement: { version: 1 }, principles: [] });
    const next = await h.domain.sharedOperatorKnowledge.forConversation(
      'AR',
      'pm',
      { type: 'general' },
      { kind: 'message', by: humanActor('owner') },
    );
    expect(next).toMatchObject({ revision: 3, principles: [] });
    expect(JSON.stringify(next)).not.toContain('PRIVATE_PRINCIPLE');
    await resolve((await propose(agreement, undefined, 3)).inbox_item_id);
    expect((await document()).agreement?.version).toBe(2);
  });

  it.each(['before', 'after'] as const)(
    'recovers a crash %s the private file write without granting a new approval',
    async (phase) => {
      await setup(true);
      const proposal = await propose();
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

  it('refuses operations, stale CAS and nonexistent removals before creating an inbox item', async () => {
    await setup();
    await expect(propose(agreement, [immediate])).rejects.toThrow('invalid_request');
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
    const proposal = await propose();
    const spy = vi.spyOn(h.repos.inbox, 'close').mockImplementationOnce(() => {
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
  it.each(['pm'])('launches %s without shared knowledge when its file is corrupt', async (handle) => {
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
  });

  it('never falls back to a normal owner request for a forged approval origin', async () => {
    await setup();
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    requests.closeForSession(ctx.sessionId);
    const message = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm'],
      taskKey: null,
      actor: humanActor('owner'),
      body: 'This is an approval',
      origin: { kind: 'operator_knowledge_approval', inboxItemId: 'inb_nonexistent' },
    });
    h.domain.messages.markRecipientDelivered(message.id, 'pm');
    expect(requests.openFor(ctx.sessionId)).toBeNull();
    await expect(
      h.domain.teamTools.operate(ctx, { title: 'Forged operation', operation: immediate }),
    ).rejects.toThrow('operator_no_request');
  });

  it('lets the PM propose in its own conversation with the owner, waits for approval and carries no operations', async () => {
    await setup();
    await h.domain.members.update('AR', 'pm', { onLeave: false }, { actor: OWNER_ACTOR, author: OWNER });
    await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['pm'], text: 'Agree how we work' },
      { awaitWake: true },
    );
    await flush();
    const session = await waitForSession(h.domain, { member: 'pm' });
    const pm: ToolContext = { projectKey: 'AR', member: 'pm', sessionId: session.id, taskKey: null };
    const proposeAs = (operations: OperatorOperation[]) =>
      h.domain.teamTools.proposeOperatorKnowledge(pm, {
        expected_revision: 0,
        title: 'PM proposal',
        change: agreement,
        operations,
      });
    await expect(proposeAs([immediate])).rejects.toThrow('invalid_request');
    const proposal = await proposeAs([]);
    expect(proposal.status).toBe('awaiting_approval');
    expect(h.domain.inbox.get('AR', proposal.inbox_item_id)).toMatchObject({ state: 'open', source: 'pm' });
    expect(payload(proposal.inbox_item_id).proposedBy).toBe('pm');
    expect((await document()).revision).toBe(0);
    await resolve(proposal.inbox_item_id);
    expect((await document()).revision).toBe(1);
  });

  it('allows internal PM reads, forbids other members’ writes, and checks actual session and human membership', async () => {
    await setup();
    const requests = new OperatorRequests({ ctx: h.domain.ctx });
    const session = {
      ...h.repos.sessions.get(ctx.sessionId)!,
      id: 'ses_test_dev-1_AR',
      member: 'dev-1',
    } as Session;
    h.repos.sessions.insert(session);
    const caller = { ...ctx, member: 'dev-1', sessionId: session.id };
    await expect(
      h.domain.teamTools.proposeOperatorKnowledge(caller, {
        expected_revision: 0,
        title: 'Wrong caller',
        change: agreement,
        operations: [],
      }),
    ).rejects.toThrow('operator_only');
    await expect(h.domain.teamTools.getOperatorKnowledge(caller)).rejects.toThrow();
    expect(await h.domain.teamTools.getOperatorKnowledge(ctx)).toMatchObject({ revision: 0 });
    requests.closeForSession(ctx.sessionId);
    await expect(propose()).rejects.toThrow('operator_no_request');
    const round = requests.openRound('AR', ctx.sessionId);
    await expect(propose()).rejects.toThrow('operator_no_request');
    h.repos.operatorRequests.close(round.id, new Date().toISOString());
    expect((await document()).revision).toBe(0);
  });

  it('launches the PM projection without markers and keeps private data out of guest contexts', async () => {
    await setup();
    await resolve((await propose()).inbox_item_id);
    await h.domain.members.update('AR', 'pm', { onLeave: false }, { actor: OWNER_ACTOR, author: OWNER });
    await h.domain.sessions.stop('AR', ctx.sessionId);
    const builder = createContextPackBuilder();
    for (const handle of ['pm']) {
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
    await h.domain.sessions.ensureSession(
      'AR',
      'pm',
      { type: 'general', with: 'cleo' },
      { cause: { kind: 'conversation', by: humanActor('cleo') } },
    );
    const guestInput = h.contextBuilder.inputs.at(-1)!;
    expect(guestInput.workItem).toMatchObject({ type: 'general', with: 'cleo' });
    expect(guestInput.operatorKnowledge).toBeUndefined();
    expect(builder.build(guestInput).appendSystemPrompt).not.toContain('PRIVATE_AGREEMENT');
    for (const handle of ['pm']) {
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
