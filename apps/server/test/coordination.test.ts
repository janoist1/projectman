import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPERATOR_IDLE_MINUTES, OperatorSignal } from '@projectman/shared';
import type { AiMemberConfig, OperatorSignalKind, ProjectConfig } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { CoordinationRequests, OperatorRequests, OperatorSteps } from '../src/services/operator';
import { createDomainHarness, OWNER, OWNER_ACTOR, restartDomainHarness } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

let h: DomainHarness;
let now: Date;
const by = { actor: OWNER_ACTOR, author: OWNER };
afterEach(async () => {
  vi.restoreAllMocks();
  await h?.cleanup();
});

async function setup(adjust?: (config: ProjectConfig) => void) {
  now = new Date('2026-10-16T06:00:00Z');
  h = await createDomainHarness({
    persistent: true,
    screenQuestions: true,
    now: () => now,
    adjust: (config) => {
      (config.team.members.find((m) => m.handle === 'pm') as AiMemberConfig).onLeave = false;
      config.team.operatorWatch = 'drive';
      config.team.members.push({
        kind: 'human',
        handle: 'guest',
        displayName: 'Guest',
        access: 'developer',
        roles: [],
      });
      adjust?.(config);
    },
  });
}

const requests = () => new CoordinationRequests({ ctx: h.domain.ctx, projects: h.domain.projects });
async function internal(member = 'pm'): Promise<ToolContext> {
  const { session } = await h.domain.sessions.ensureSession('AR', member, { type: 'general' });
  await flush();
  return { projectKey: 'AR', member, sessionId: session.id, taskKey: null };
}
async function ownerMessage(member: string) {
  const running = h.domain.sessions.list('AR', { member })[0];
  if (running) h.runner.setState(running.id, 'idle');
  await h.domain.messaging.sendReporting(
    'AR',
    'owner',
    { to: [member], text: 'Coordinate this request.' },
    { awaitWake: true },
  );
  await flush();
  return internal(member);
}
async function idleSignal() {
  const card = await h.domain.tasks.create('AR', { title: 'Waiting work', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, { stageId: 'development', assignee: 'dev-1' });
  now = new Date(now.getTime() + OPERATOR_IDLE_MINUTES * 60_000);
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  const signal = h.repos.operatorSignals.list('AR').find((s) => s.kind === 'idle')!;
  return { card, signal, pm: await internal() };
}

describe('separate PM and Operator authorization', () => {
  it('reserves structural approval without accepting legacy approval rows or knowledge continuations', async () => {
    await setup();
    const pm = await internal();
    const input = {
      projectKey: 'AR',
      sessionId: pm.sessionId,
      source: 'approval' as const,
      messageId: 'msg_approval',
      inboxItemId: 'inb_approval',
      from: 'owner',
      text: 'Approved.',
    };
    expect(() => requests().open(input)).toThrow('no structural approval continuation');
    h.repos.operatorRequests.insert({
      id: 'opr_legacy_approval',
      ...input,
      fromHandle: input.from,
      quote: input.text,
      inboxItemId: input.inboxItemId,
      openedAt: now.toISOString(),
    });
    expect(requests().openFor(pm.sessionId)).toBeNull();
    await expect(
      h.domain.teamTools.startMember(pm, { member: 'dev-1', text: 'Unapproved work.' }),
    ).rejects.toThrow('operator_no_request');
  });

  it('opens the PM own message request only after a valid human signal acceptance is delivered, once', async () => {
    await setup();
    const { signal, pm } = await idleSignal();
    h.domain.projects.cachedConfig('AR')!.team.operatorWatch = 'report';
    await h.domain.teamTools.sendMessage(pm, {
      to: ['owner'],
      kind: 'info',
      text: 'Proposed coordination.',
      signalId: signal.id,
      signalActionable: true,
    });
    expect(requests().openFor(pm.sessionId)).toBeNull();
    const typeInto = h.domain.sessions.typeInto.bind(h.domain.sessions);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivery = vi.spyOn(h.domain.sessions, 'typeInto').mockImplementation(async (...args) => {
      await waiting;
      return typeInto(...args);
    });
    const accepted = await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['pm'], text: 'Yes, coordinate.' },
      { actor: OWNER_ACTOR, operatorSignal: signal.id },
    );
    expect(h.repos.operatorSignals.get(signal.id)?.state).toBe('accepted');
    expect(requests().openFor(pm.sessionId)).toBeNull();
    expect(accepted.message.receipts?.find((r) => r.handle === 'pm')?.deliveredAt).toBeNull();
    release();
    await flush();
    delivery.mockRestore();
    const request = requests().openFor(pm.sessionId)!;
    expect(request).toMatchObject({
      source: 'message',
      messageId: accepted.message.id,
      sessionId: pm.sessionId,
    });
    await expect(
      h.domain.teamTools.startMember(pm, { member: 'dev-2', text: 'Explicitly requested coordination.' }),
    ).resolves.toHaveProperty('messageId');
    expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual([]);
    requests().closeForSession(pm.sessionId);
    h.domain.messages.markRecipientDelivered(accepted.message.id, 'pm');
    expect(requests().openFor(pm.sessionId)).toBeNull();
    expect(
      h.repos.operatorRequests.latest('AR', 20).filter((r) => r.messageId === accepted.message.id),
    ).toHaveLength(1);
  });

  it.each([
    'null',
    'operator',
    'foreign',
    'pending',
    'non-actionable',
    'other-owner',
    'other-presenter',
  ] as const)('refuses a persisted acceptance with %s provenance', async (wrong) => {
    await setup();
    const { signal, pm } = await idleSignal();
    const presented = await h.domain.teamTools.sendMessage(pm, {
      to: ['owner'],
      kind: 'info',
      text: 'Proposal.',
      signalId: signal.id,
      signalActionable: true,
    });
    const current = h.repos.operatorSignals.get(signal.id)!;
    h.repos.operatorSignals.save({
      ...current,
      state: wrong === 'pending' ? 'open' : 'accepted',
      actionable: wrong !== 'non-actionable',
      decidedBy: wrong === 'other-owner' ? 'guest' : 'owner',
      deliveredTo:
        wrong === 'null'
          ? null
          : wrong === 'operator'
            ? 'operator'
            : wrong === 'foreign'
              ? 'previous-pm'
              : 'pm',
    });
    if (wrong === 'other-presenter') {
      const old = h.repos.messages.get(presented.messageId)!;
      h.repos.operatorSignals.save({
        ...h.repos.operatorSignals.get(signal.id)!,
        messageId: h.domain.messages.record({
          projectKey: 'AR',
          from: 'operator',
          to: ['owner'],
          taskKey: null,
          body: old.body,
          actor: { kind: 'ai', handle: 'operator' },
          delivered: true,
        }).id,
      });
    }
    const acceptance = h.domain.messages.record({
      projectKey: 'AR',
      from: 'owner',
      to: ['pm'],
      taskKey: null,
      body: 'Yes.',
      actor: OWNER_ACTOR,
      operatorSignal: signal.id,
    });
    h.domain.messages.markRecipientDelivered(acceptance.id, 'pm');
    expect(requests().openFor(pm.sessionId)).toBeNull();
  });

  it('uses only the PM own delivered owner request and keeps it out of the Operator channel', async () => {
    await setup();
    const operator = await ownerMessage('operator');
    const pm = await internal();
    expect(requests().openFor(pm.sessionId)).toBeNull();
    await expect(h.domain.teamTools.startMember(pm, { member: 'dev-2', text: 'Work.' })).rejects.toThrow(
      'operator_no_request',
    );
    await expect(
      h.domain.teamTools.startMember(operator, { member: 'dev-2', text: 'Work.' }),
    ).rejects.toThrow('project_manager_only');
    await ownerMessage('pm');
    expect(requests().openFor(pm.sessionId)?.sessionId).toBe(pm.sessionId);
    const started = await h.domain.teamTools.startMember(pm, { member: 'dev-2', text: 'Work.' });
    expect(h.repos.messages.get(started.messageId)?.from).toBe('pm');
    const channel = await h.domain.projectManagerChannels.operatorView('AR', 'owner');
    expect(channel.requests).toHaveLength(1);
    expect(channel.requests[0]?.id).not.toBe(requests().openFor(pm.sessionId)?.id);
    await expect(
      h.domain.teamTools.operate(pm, {
        title: 'Change capacity',
        operation: { op: 'member_update', handle: 'dev-1', changes: { capacity: 2 } },
      }),
    ).rejects.toThrow('operator_only');
    await expect(
      h.domain.teamTools.operate(operator, {
        title: 'Change capacity',
        operation: { op: 'member_update', handle: 'dev-1', changes: { capacity: 2 } },
      }),
    ).resolves.toMatchObject({ status: 'done' });
  });

  it('opens nothing for another human, integrator, system signal, member message or knowledge approval', async () => {
    await setup();
    const pm = await internal();
    for (const [from, opts] of [
      ['guest', {}],
      ['dev-1', {}],
      ['owner', { actor: { kind: 'human', handle: 'owner', via: 'integrator' } }],
      ['owner', { origin: { kind: 'operator_knowledge_approval', inboxItemId: 'inb_foreign' } }],
    ] as const) {
      h.runner.setState(pm.sessionId, 'idle');
      await h.domain.messaging.sendReporting(
        'AR',
        from,
        { to: ['pm'], text: 'Please start.' },
        { ...opts, awaitWake: true },
      );
      await flush();
      expect(requests().openFor(pm.sessionId)).toBeNull();
    }
    await idleSignal();
    expect(requests().openFor(pm.sessionId)).toBeNull();
  });

  it('closes PM requests at turn end and at 30 minutes, without extending them across restart', async () => {
    await setup();
    const pm = await ownerMessage('pm');
    expect(requests().openFor(pm.sessionId)).not.toBeNull();
    h.runner.setState(pm.sessionId, 'idle');
    await flush();
    expect(requests().openFor(pm.sessionId)).toBeNull();
    await ownerMessage('pm');
    now = new Date(now.getTime() + 30 * 60_000);
    h = await restartDomainHarness(h, { now: () => now });
    expect(requests().openFor(pm.sessionId)).toBeNull();
  });

  it('allows internal PM and Operator state reads, but refuses a foreign token or guest session', async () => {
    await setup();
    const pm = await internal();
    const operator = await internal('operator');
    await expect(h.domain.teamTools.getProjectState(pm, {})).resolves.toHaveProperty('stages');
    await expect(h.domain.teamTools.getProjectState(operator, {})).resolves.toHaveProperty('stages');
    const session = h.repos.sessions.get(pm.sessionId)!;
    h.repos.sessions.insert({ ...session, id: 'ses_pm_guest', workItem: { type: 'general', with: 'guest' } });
    for (const ctx of [
      { ...pm, sessionId: operator.sessionId },
      { ...pm, sessionId: 'external' },
      { ...pm, sessionId: 'ses_pm_guest' },
    ])
      await expect(h.domain.teamTools.getProjectState(ctx, {})).rejects.toThrow('project_manager_only');
  });

  it('screens Operator questions through the PM, while PM own questions go straight to people', async () => {
    await setup();
    const operator = await ownerMessage('operator');
    const pm = await internal();
    const question = await h.domain.teamTools.askHuman(operator, { question: 'Which documented setting?' });
    await flush();
    expect(h.domain.inbox.get('AR', question.inboxItemId).state).toBe('screening');
    await expect(
      h.domain.teamTools.screenQuestion(operator, {
        itemId: question.inboxItemId,
        outcome: 'moot',
        note: 'No.',
      }),
    ).rejects.toThrow('project_manager_only');
    await h.domain.teamTools.screenQuestion(pm, {
      itemId: question.inboxItemId,
      outcome: 'answered',
      answer: 'The current default.',
      note: 'Configuration.',
    });
    expect(h.domain.inbox.get('AR', question.inboxItemId).resolution?.by).toBe('pm');
    const own = await h.domain.teamTools.askHuman(pm, { question: 'A human decision?' });
    expect(h.domain.inbox.get('AR', own.inboxItemId).state).toBe('open');
    await expect(
      h.domain.teamTools.screenQuestion(pm, { itemId: own.inboxItemId, outcome: 'moot', note: 'No.' }),
    ).rejects.toThrow('cannot screen its own');
    expect(requests().openFor(pm.sessionId)).toBeNull();
  });
});

describe('persisted coordination signal bindings', () => {
  it.each([null, 'operator', 'previous-pm'])(
    'redelivers legacy binding %s without a new signal or budget',
    async (deliveredTo) => {
      await setup();
      const { card, signal, pm } = await idleSignal();
      const operator = await internal('operator');
      const oldRound = new OperatorRequests({ ctx: h.domain.ctx }).openRound('AR', operator.sessionId);
      new OperatorSteps({ ctx: h.domain.ctx }).record({
        requestId: oldRound.id,
        action: 'task_start',
        status: 'done',
        taskKey: card.key,
        member: 'dev-1',
        signalId: signal.id,
      });
      h.repos.operatorSignals.save({ ...signal, deliveredTo });
      await expect(
        h.domain.teamTools.startTask(pm, { taskKey: card.key, signalId: signal.id }),
      ).rejects.toThrow('operator_signal_closed');
      const oldSteps = h.repos.operatorRequests.stepsOfSignal(signal.id);
      await h.domain.operatorSignals.deliver('AR');
      expect(h.repos.operatorSignals.get(signal.id)).toMatchObject({
        id: signal.id,
        caseKey: signal.caseKey,
        deliveredTo: 'pm',
      });
      expect(h.repos.operatorSignals.list('AR').filter((s) => s.kind === 'idle')).toHaveLength(1);
      expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual(oldSteps);
      await expect(
        h.domain.teamTools.startTask(pm, { taskKey: card.key, signalId: signal.id }),
      ).rejects.toThrow('operator_signal_budget');
      expect(requests().openFor(pm.sessionId)).toBeNull();
    },
  );

  it('invalidates delivery on leave and requires fresh delivery when the same PM returns', async () => {
    await setup();
    const { card, signal, pm } = await idleSignal();
    await h.domain.members.update('AR', 'pm', { onLeave: true }, by);
    expect(h.repos.operatorSignals.get(signal.id)?.deliveredTo).toBeNull();
    await h.domain.members.update('AR', 'pm', { onLeave: false }, by);
    await expect(
      h.domain.teamTools.startTask(pm, { taskKey: card.key, signalId: signal.id }),
    ).rejects.toThrow('operator_signal_closed');
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)?.deliveredTo).toBe('pm');
    await expect(
      h.domain.teamTools.startTask(pm, { taskKey: card.key, signalId: signal.id }),
    ).resolves.toHaveProperty('session_id');
  });

  it('preserves presented legacy signals and their original owner acceptance route', async () => {
    await setup();
    const { signal } = await idleSignal();
    const sent = await h.domain.messaging.sendReporting(
      'AR',
      'operator',
      { to: ['owner'], text: 'Earlier proposal.' },
      { actor: { kind: 'ai', handle: 'operator' }, kind: 'info' },
    );
    h.repos.operatorSignals.save({
      ...signal,
      state: 'open',
      deliveredTo: null,
      messageId: sent.message.id,
      actionable: true,
    });
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)?.messageId).toBe(sent.message.id);
    await h.domain.messaging.sendReporting(
      'AR',
      'owner',
      { to: ['operator'], text: 'Accept the earlier proposal.' },
      { actor: OWNER_ACTOR, operatorSignal: signal.id },
    );
    expect(h.repos.operatorSignals.get(signal.id)?.state).toBe('accepted');
  });

  it('rejects an old PM session after the selected coordinator changes', async () => {
    await setup((config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      config.team.members.push({ ...pm, handle: 'pm-2', displayName: 'Second PM' });
    });
    const { card, signal, pm } = await idleSignal();
    await h.domain.members.update('AR', 'pm', { onLeave: true }, by);
    await h.domain.operatorSignals.deliver('AR');
    expect(h.repos.operatorSignals.get(signal.id)?.deliveredTo).toBe('pm-2');
    await expect(
      h.domain.teamTools.startTask(pm, { taskKey: card.key, signalId: signal.id }),
    ).rejects.toThrow('project_manager_only');
    await expect(
      h.domain.teamTools.startTask(await internal('pm-2'), { taskKey: card.key, signalId: signal.id }),
    ).resolves.toHaveProperty('session_id');
  });

  it('keeps old DTOs readable without inventing a delivery binding', async () => {
    await setup();
    const { signal } = await idleSignal();
    const { deliveredTo: _binding, ...legacy } = OperatorSignal.parse(signal);
    expect(OperatorSignal.parse(legacy).deliveredTo ?? null).toBeNull();
    const kinds: OperatorSignalKind[] = ['outage', 'process_cleanup_failed'];
    expect(kinds.every((kind) => OperatorSignal.safeParse({ ...legacy, kind }).success)).toBe(true);
  });
});
