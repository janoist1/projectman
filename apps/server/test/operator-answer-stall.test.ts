import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATOR_ANSWER_STALL_GRACE_MS,
  OPERATOR_ANSWER_STALL_WAKE_MS,
  OPERATOR_SIGNAL_ROUND_FROM,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OPERATOR_SIGNAL_STEPS,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
  WAITING_ANSWER_LABEL,
} from '@projectman/shared';
import type { OperatorSignalKind, OperatorWatch, Task } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import {
  createDomainHarness,
  restartDomainHarness,
  OWNER_ACTOR,
  waitForSession,
} from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { openOverdueObligation } from './helpers/overdue-obligation';

/** PM-694: the answer that reached the assignee and was followed by no work, raised by the sweep and only reported (no step). */
let h: DomainHarness;
let now: Date;
let messageCount = 0;
afterEach(async () => {
  await h?.cleanup();
});

const seconds = (n: number) => {
  now = new Date(now.getTime() + n * 1000);
};
const minutes = (n: number) => seconds(n * 60);
const iso = (offsetSeconds = 0) => new Date(now.getTime() + offsetSeconds * 1000).toISOString();
const sweep = async () => {
  // The coordinator ends its turn before the next notice: the queue types at the turn boundary.
  const coordinator = h.domain.sessions.findRunning('AR', 'pm', { type: 'general' });
  if (coordinator && coordinator.state !== 'idle') h.runner.setState(coordinator.id, 'idle');
  await h.domain.operatorSignals.sweep('AR');
  await flush();
};
const open = (kind: OperatorSignalKind = 'answer_stalled') =>
  h.repos.operatorSignals.list('AR').filter((s) => s.kind === kind && !s.resolvedAt);
const GRACE = OPERATOR_ANSWER_STALL_GRACE_MS / 1000;

async function setup(level: OperatorWatch = 'drive') {
  now = new Date('2026-10-14T10:00:00Z');
  messageCount = 0;
  h = await createDomainHarness({
    persistent: true,
    now: () => now,
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      config.team.operatorWatch = level;
    },
  });
}

async function develop(assignee = 'dev-1', labels: string[] = []): Promise<Task> {
  const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, {
    stageId: 'development',
    status: 'active',
    assignee,
    labels,
    // Entered long ago, so that evidence backdated by a test still belongs to the stage.
    stageEnteredAt: iso(-3600),
    updatedAt: iso(),
  });
  return h.repos.tasks.get(card.key)!;
}

/** A message to `to`: sent at `sentAt`, reached them at `deliveredAt` (both seconds from now). */
function message(
  card: Task,
  opts: {
    id?: string;
    from?: string;
    to?: string;
    sentAt?: number;
    deliveredAt?: number | null;
    answer?: boolean;
    kind?: 'action' | 'info';
    body?: string;
  } = {},
): string {
  const id = opts.id ?? `msg_${++messageCount}`;
  const to = opts.to ?? 'dev-1';
  const deliveredAt = opts.deliveredAt === undefined ? 0 : opts.deliveredAt;
  h.repos.messages.insert({
    id,
    projectKey: 'AR',
    from: opts.from ?? 'owner',
    to: [to],
    taskKey: card.key,
    body: opts.body ?? 'Go ahead with the second option.',
    createdAt: iso(opts.sentAt ?? 0),
    deliveredAt: deliveredAt === null ? null : iso(deliveredAt),
    kind: opts.kind ?? 'action',
    receipts: [
      { handle: to, kind: 'ai', deliveredAt: deliveredAt === null ? null : iso(deliveredAt), readAt: null },
    ],
    ...(opts.answer
      ? { answer: { inboxItemId: 'inb_1', question: 'Which option?', answer: 'The second one.' } }
      : {}),
  });
  return id;
}

function timelineEvent(
  card: Task,
  actor: { kind: 'ai' | 'human'; handle: string },
  type: string,
  data: Record<string, unknown> = {},
  at = 0,
) {
  h.repos.timeline.insert({
    id: `evt_${++messageCount}`,
    projectKey: 'AR',
    taskKey: card.key,
    sessionId: null,
    actor,
    type,
    data,
    createdAt: iso(at),
  } as never);
}

function session(
  card: Task,
  state: 'working' | 'idle' | 'waiting_permission' | 'waiting_input',
  member = 'dev-1',
) {
  return h.domain.sessions
    .ensureSession('AR', member, { type: 'task', taskKey: card.key })
    .then(({ session }) => {
      h.runner.setState(session.id, state);
      return session;
    });
}

const operator = async (): Promise<ToolContext> => ({
  projectKey: 'AR',
  member: 'pm',
  taskKey: null,
  sessionId: (await waitForSession(h.domain, { member: 'pm' })).id,
});
const wakeTexts = () =>
  [...h.runner.started.map((s) => s.initialMessage ?? ''), ...h.runner.messages.map((m) => m.text)].filter(
    (text) => text.includes('Projectman system signals'),
  );
const wakeRows = (text = wakeTexts().at(-1)!): Array<Record<string, unknown>> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const push = async (card: Task, signal: { id: string }, member = 'dev-1') =>
  h.domain.teamTools.startMember(await operator(), {
    member,
    text: 'The answer is on the card; take the next step.',
    taskKey: card.key,
    signalId: signal.id,
  });

describe('detection', () => {
  it('rises at the grace, counted from the delivery and not from the sending', async () => {
    await setup();
    const card = await develop();
    // Sent ten minutes before it reached them.
    const id = message(card, { sentAt: -600, deliveredAt: 0 });
    seconds(GRACE - 1);
    await sweep();
    expect(open()).toEqual([]);
    seconds(1);
    await sweep();
    expect(open()).toMatchObject([
      { caseKey: `answer_stalled:${card.key}:dev-1:${id}`, taskKey: card.key, subject: id },
    ]);
    expect(wakeRows()).toMatchObject([
      {
        kind: 'answer_stalled',
        facts: { evidenceId: id, evidenceAt: iso(-GRACE), member: 'dev-1', lastActionAt: null },
        step: { tool: 'start_member', task_key: card.key, members: ['dev-1'] },
      },
    ]);
  });

  it('does not count a message that has not reached the member yet', async () => {
    await setup();
    const card = await develop();
    message(card, { deliveredAt: null });
    seconds(GRACE * 10);
    await sweep();
    expect(open()).toEqual([]);
  });

  it('does not count an information message or the member’s own message', async () => {
    await setup();
    const card = await develop();
    message(card, { kind: 'info' });
    message(card, { from: 'dev-1', to: 'owner' });
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
  });

  it('counts a mention or a note addressed to the member, but not plain note text', async () => {
    await setup();
    const card = await develop();
    // A note nobody addressed reaches nobody: it leaves no message.
    timelineEvent(card, { kind: 'human', handle: 'owner' }, 'task_note', { text: 'Some thoughts.' });
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
    const id = message(card, { body: '@dev-1 please look at the note.' });
    seconds(GRACE);
    await sweep();
    expect(open()).toMatchObject([{ subject: id }]);
  });

  it('is blocked by an open question of the member, and returns when it is answered', async () => {
    await setup();
    const card = await develop();
    const question = h.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      source: 'dev-1',
      assignees: ['owner'],
      taskKey: card.key,
      title: 'Which layout?',
      payload: { question: 'Which layout?' },
      options: [{ id: 'answer', label: 'answer', style: 'primary' }],
    });
    message(card);
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
    h.domain.inbox.cancel(question.id);
    await sweep();
    expect(open()).toHaveLength(1);
  });

  it('does not rise while the member works on the card, nor when a permission waits', async () => {
    await setup();
    const card = await develop();
    message(card);
    const working = await session(card, 'working');
    seconds(GRACE * 3);
    await sweep();
    expect(open()).toEqual([]);
    h.runner.setState(working.id, 'waiting_permission');
    await sweep();
    expect(open()).toEqual([]);
    h.runner.setState(working.id, 'waiting_input');
    await sweep();
    expect(open()).toEqual([]);
  });

  it('counts the grace from the idle session’s last state when that is later than the delivery', async () => {
    await setup();
    const card = await develop();
    message(card);
    const idle = await session(card, 'working');
    seconds(GRACE * 2);
    h.runner.setState(idle.id, 'idle');
    await sweep();
    expect(open()).toEqual([]);
    seconds(GRACE);
    await sweep();
    expect(open()).toHaveLength(1);
  });

  it('is answered by work after the evidence: the card’s own timeline or the session’s last step', async () => {
    await setup();
    const card = await develop();
    message(card, { deliveredAt: -GRACE * 2 });
    // The member put a note on the card after the message reached them.
    timelineEvent(card, { kind: 'ai', handle: 'dev-1' }, 'task_note', { text: 'On it.' }, -GRACE);
    await sweep();
    expect(open()).toEqual([]);

    const second = await develop();
    message(second, { deliveredAt: -GRACE * 2 });
    const worked = await session(second, 'idle');
    h.repos.sessions.update(worked.id, {
      workMetadata: { lastWorkAt: iso(-GRACE), lastTool: null, lastError: null },
    });
    await sweep();
    expect(open()).toEqual([]);
  });

  it('does not count the member’s question, a state change or the label put on by the system as work', async () => {
    await setup();
    const card = await develop();
    message(card, { deliveredAt: -GRACE * 2 });
    timelineEvent(
      card,
      { kind: 'ai', handle: 'dev-1' },
      'task_labels_changed',
      { added: [WAITING_ANSWER_LABEL], removed: [] },
      -GRACE,
    );
    await sweep();
    expect(open()).toHaveLength(1);
    expect(wakeRows()).toMatchObject([{ facts: { lastActionAt: null } }]);
  });

  it('on a card with the waiting-answer label needs an answer, not a plain message', async () => {
    await setup();
    const card = await develop('dev-1', [WAITING_ANSWER_LABEL]);
    message(card);
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
    const id = message(card, { answer: true });
    seconds(GRACE);
    await sweep();
    expect(open()).toMatchObject([{ subject: id }]);
  });

  it('does not rise for a human, a member on leave, a closed card or a card in a queue', async () => {
    await setup();
    const human = await develop('owner');
    message(human, { to: 'owner' });
    const leave = await develop('dev-2');
    message(leave, { to: 'dev-2' });
    const dev2 = h.domain.projects.cachedConfig('AR')!.team.members.find((m) => m.handle === 'dev-2')!;
    if (dev2.kind === 'ai') dev2.onLeave = true;
    const queued = await develop();
    h.repos.tasks.update(queued.id, { stageId: 'incoming', assignee: 'dev-1' });
    message(queued);
    const closed = await develop();
    h.repos.tasks.update(closed.id, { status: 'cancelled' });
    message(closed);
    seconds(GRACE * 2);
    await sweep();
    expect(open()).toEqual([]);
  });

  it('closes when new work follows, the assignee changes, the card moves or the team pauses', async () => {
    await setup();
    const worked = await develop();
    message(worked);
    const handed = await develop();
    message(handed);
    const moved = await develop();
    message(moved);
    seconds(GRACE);
    await sweep();
    expect(open().map((s) => s.taskKey)).toEqual([worked.key, handed.key, moved.key]);

    timelineEvent(worked, { kind: 'ai', handle: 'dev-1' }, 'task_updated', { fields: ['title'] }, 1);
    h.repos.tasks.update(handed.id, { assignee: 'dev-2' });
    h.repos.tasks.update(moved.id, { stageId: 'code_review', stageEnteredAt: iso(1) });
    seconds(2);
    await sweep();
    expect(open()).toEqual([]);
  });

  it('closes when the team is paused, and does not rise while it is paused', async () => {
    await setup();
    const card = await develop();
    message(card);
    seconds(GRACE);
    await sweep();
    expect(open()).toHaveLength(1);
    await h.domain.pauses.pause({ scope: 'project', projectKey: 'AR' }, { userId: null, source: 'system' });
    await sweep();
    expect(open()).toEqual([]);
  });

  it('closes when a newer message takes the place of the evidence that was gone', async () => {
    await setup();
    const card = await develop();
    const first = message(card);
    seconds(GRACE);
    await sweep();
    expect(open()).toMatchObject([{ subject: first }]);
    // A new answer reaches the member: the case of the latest one stands, the old one closes.
    const second = message(card, { deliveredAt: 1 });
    seconds(GRACE + 1);
    await sweep();
    expect(open().map((s) => s.subject)).toEqual([second]);
  });

  it('raises a new case for a new evidence after the old one was answered by work', async () => {
    await setup();
    const card = await develop();
    const first = message(card);
    seconds(GRACE);
    await sweep();
    expect(open()).toMatchObject([{ subject: first }]);
    timelineEvent(card, { kind: 'ai', handle: 'dev-1' }, 'task_note', { text: 'Done with it.' }, 1);
    seconds(2);
    await sweep();
    expect(open()).toEqual([]);
    const second = message(card, { deliveredAt: 3 });
    seconds(GRACE + 3);
    await sweep();
    expect(open()).toMatchObject([{ subject: second }]);
  });
});

describe('the Operator’s steps', () => {
  async function stalled(level: OperatorWatch = 'drive') {
    await setup(level);
    const card = await develop();
    const id = message(card);
    seconds(GRACE);
    await sweep();
    return { card, id, signal: open()[0]! };
  }

  /** An earlier own step on a signal, as the old rows hold it: the new signal itself never creates one. */
  async function oldStep(signal: { id: string; taskKey: string | null }, at: number) {
    const requestId = `req_old_${++messageCount}`;
    h.repos.operatorRequests.insert({
      id: requestId,
      projectKey: 'AR',
      sessionId: (await operator()).sessionId!,
      source: 'signal',
      messageId: null,
      inboxItemId: null,
      fromHandle: OPERATOR_SIGNAL_ROUND_FROM,
      quote: '',
      openedAt: iso(at),
    });
    h.repos.operatorRequests.insertStep({
      id: `ops_old_${messageCount}`,
      requestId,
      at: iso(at),
      action: 'task_start',
      status: 'done',
      taskKey: signal.taskKey,
      member: 'dev-1',
      changes: [],
      configVersion: null,
      inboxItemId: null,
      signalId: signal.id,
      refusal: null,
    });
  }

  it.each(['report', 'unblock', 'drive'] as const)(
    'level %s binds the PM step to the current assignee and tool',
    async (level) => {
      const { card, signal } = await stalled(level);
      expect(wakeRows()).toMatchObject([
        {
          kind: 'answer_stalled',
          step: level === 'report' ? null : { tool: 'start_member', task_key: card.key, members: ['dev-1'] },
          steps_left: level === 'report' ? 0 : level === 'unblock' ? 1 : 3,
          next_step_at: null,
        },
      ]);
      if (level === 'report')
        await expect(push(card, signal)).rejects.toMatchObject({
          code: 'forbidden',
          message: expect.stringContaining('operator_no_request'),
        });
      await expect(
        h.domain.teamTools.startTask(await operator(), { taskKey: card.key, signalId: signal.id }),
      ).rejects.toMatchObject({ message: expect.stringContaining('operator_no_request') });
      // Neither another member nor another card changes that.
      const other = await develop('dev-2');
      await expect(push(card, signal, 'dev-2')).rejects.toMatchObject({
        message: expect.stringContaining('operator_no_request'),
      });
      await expect(push(other, signal)).rejects.toMatchObject({
        message: expect.stringContaining('operator_no_request'),
      });
      expect(h.domain.sessions.list('AR', { member: 'dev-1' })).toEqual([]);
      expect(h.domain.sessions.list('AR', { member: 'dev-2' })).toEqual([]);
      expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual([]);
      expect(h.repos.tasks.get(card.key)).toMatchObject({ stageId: 'development', assignee: 'dev-1' });
      if (level !== 'report') {
        const result = await push(card, signal);
        expect(h.repos.messages.get(result.messageId)).toMatchObject({
          from: 'pm',
          to: ['dev-1'],
          taskKey: card.key,
        });
        const [step] = h.repos.operatorRequests.stepsOfSignal(signal.id);
        expect(h.repos.operatorRequests.get(step!.requestId)?.sessionId).toBe((await operator()).sessionId);
      }
    },
  );

  it.each(['assignee', 'stage', 'evidence', 'permission', 'gate', 'prerequisite'] as const)(
    'rechecks %s before a PM answer-stalled push',
    async (change) => {
      const { card, signal } = await stalled('drive');
      if (change === 'assignee') h.repos.tasks.update(card.id, { assignee: 'dev-2' });
      if (change === 'stage')
        h.repos.tasks.update(card.id, { stageId: 'code_review', stageEnteredAt: iso(1) });
      if (change === 'evidence') message(card, { deliveredAt: 1 });
      if (change === 'permission') await session(card, 'waiting_permission');
      if (change === 'gate') {
        const config = h.domain.projects.cachedConfig('AR')!;
        config.pipeline.stages.find((s) => s.id === 'development')!.gate = {
          conditions: [{ type: 'has_label', label: 'code-review-ok' }],
        };
      }
      if (change === 'prerequisite') {
        const first = await develop('dev-2');
        await h.domain.tasks.update(
          'AR',
          card.key,
          { relations: { add: [{ kind: 'prerequisite', key: first.key }] } },
          OWNER_ACTOR,
        );
      }
      await expect(push(card, signal)).rejects.toThrow(/operator_signal_closed|operator_no_request/);
      expect(h.repos.operatorRequests.stepsOfSignal(signal.id)).toEqual([]);
    },
  );

  it('rechecks evidence at the message write boundary and releases its mutex after refusal', async () => {
    const { card, signal } = await stalled('drive');
    const read = h.domain.sessions.sourceHead.bind(h.domain.sessions);
    const changed = vi.spyOn(h.domain.sessions, 'sourceHead').mockImplementationOnce(async (...args) => {
      message(card, { deliveredAt: 1 });
      return read(...args);
    });
    await expect(push(card, signal)).rejects.toThrow('no longer open');
    changed.mockRestore();
    expect(h.repos.operatorRequests.stepsOfSignal(signal.id).every((s) => s.status === 'refused')).toBe(true);
    seconds(GRACE + 1);
    await sweep();
    const current = open()[0]!;
    await expect(push(card, current)).resolves.toHaveProperty('messageId');
  });

  it('serializes simultaneous pushes and retains the used budget across restart', async () => {
    const { card, signal } = await stalled('unblock');
    const outcomes = await Promise.allSettled([push(card, signal), push(card, signal)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(
      h.repos.operatorRequests.stepsOfSignal(signal.id).filter((s) => s.status !== 'refused'),
    ).toHaveLength(1);
    const worker = await waitForSession(h.domain, { member: 'dev-1' });
    h.runner.setState(worker.id, 'idle');
    await flush();
    minutes(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    h = await restartDomainHarness(h, { now: () => now });
    await sweep();
    await expect(push(card, signal)).rejects.toThrow(/operator_signal_budget|operator_signal_closed/);
    expect(
      h.repos.operatorRequests.stepsOfSignal(signal.id).filter((s) => s.status !== 'refused'),
    ).toHaveLength(1);
  });

  it('closes the signal when the member does real work', async () => {
    const { card } = await stalled('drive');
    const started = await session(card, 'idle');
    h.repos.sessions.update(started.id, {
      workMetadata: { lastWorkAt: iso(5), lastTool: { name: 'update_task', at: iso(5) }, lastError: null },
    });
    seconds(GRACE * 2);
    await sweep();
    expect(open()).toEqual([]);
  });

  it('keeps the new evidence quiet for half an hour after an old step, and not longer', async () => {
    const { card, signal } = await stalled('drive');
    await oldStep(signal, 0);
    // The member does nothing; another answer reaches them.
    const again = message(card, { deliveredAt: 0 });
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
    minutes(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    await sweep();
    expect(open()).toMatchObject([{ subject: again }]);
  });

  it.each([
    [1, 1],
    [OPERATOR_SIGNAL_STEPS.drive, 0],
  ])(
    'keeps the same case quiet for half an hour when it comes back, and for good after %i old steps',
    async (steps, openAgain) => {
      const { card, id, signal } = await stalled('drive');
      // The old steps are long gone, so only the case's own count can keep it quiet.
      for (let i = 0; i < steps; i++) await oldStep(signal, -3 * 3600 + i);
      // The member works, so the signal closes; then the turn ends with no step.
      const started = await session(card, 'working');
      await sweep();
      expect(open()).toEqual([]);
      h.runner.setState(started.id, 'idle');
      await flush();
      seconds(GRACE);
      await sweep();
      expect(open().map((s) => s.caseKey)).toEqual(
        openAgain ? [`answer_stalled:${card.key}:dev-1:${id}`] : [],
      );
    },
  );

  it('keeps the same case quiet for half an hour after a recent old step', async () => {
    const { card, signal } = await stalled('drive');
    await oldStep(signal, 0);
    const started = await session(card, 'working');
    await sweep();
    expect(open()).toEqual([]);
    h.runner.setState(started.id, 'idle');
    await flush();
    seconds(GRACE);
    await sweep();
    expect(open()).toEqual([]);
    minutes(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    await sweep();
    expect(open()).toHaveLength(1);
  });
});

describe('the wake budget', () => {
  const kindsWoken = () => wakeTexts().flatMap((text) => wakeRows(text).map((row) => row.kind));

  it('wakes for this kind at most once a minute, whatever the number of cards', async () => {
    await setup('drive');
    const first = await develop();
    message(first);
    // The second card’s answer reaches its member thirty seconds after the first one’s.
    const second = await develop('dev-2');
    message(second, { to: 'dev-2', deliveredAt: 30 });
    seconds(GRACE);
    await sweep();
    expect(open().map((s) => s.taskKey)).toEqual([first.key]);
    expect(wakeTexts()).toHaveLength(1);

    seconds(30);
    await sweep();
    expect(open().map((s) => s.taskKey)).toEqual([first.key, second.key]);
    expect(wakeTexts()).toHaveLength(1);

    seconds(OPERATOR_ANSWER_STALL_WAKE_MS / 1000 - 30);
    await sweep();
    expect(wakeTexts()).toHaveLength(2);
    expect(wakeRows()).toMatchObject([{ kind: 'answer_stalled', taskKey: second.key }]);
  });

  it('does not let this kind use the fifteen-minute line of the others, nor the others its minute', async () => {
    await setup('drive');
    const stalledCard = await develop();
    message(stalledCard);
    seconds(GRACE);
    await sweep();
    expect(kindsWoken()).toEqual(['answer_stalled']);
    // An overdue-obligation signal rises a minute after it and wakes at once: the stall used none of its fifteen minutes.
    minutes(1);
    const overdueCard = await develop('dev-2');
    openOverdueObligation(h, overdueCard, { at: now });
    await sweep();
    expect(open('obligation_overdue').map((s) => s.taskKey)).toContain(overdueCard.key);
    expect(kindsWoken()).toEqual(['answer_stalled', 'obligation_overdue']);
  });

  it('keeps the fifteen-minute limit of the other kinds', async () => {
    await setup('drive');
    const first = await develop('dev-2');
    openOverdueObligation(h, first, { at: now });
    await sweep();
    expect(kindsWoken()).toEqual(['obligation_overdue']);
    // The second card’s signal rises five minutes after the first wake-up: it waits for the end of the fifteen.
    minutes(5);
    const second = await develop('dev-1');
    openOverdueObligation(h, second, { at: now });
    await sweep();
    expect(open('obligation_overdue').map((s) => s.taskKey)).toEqual([first.key, second.key]);
    expect(kindsWoken()).toEqual(['obligation_overdue']);
    minutes(OPERATOR_SIGNAL_WAKE_INTERVAL_MS / 60_000 - 5);
    await sweep();
    expect(kindsWoken()).toEqual(['obligation_overdue', 'obligation_overdue']);
  });
});
