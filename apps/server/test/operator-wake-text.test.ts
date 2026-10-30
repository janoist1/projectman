import { afterEach, describe, expect, it } from 'vitest';
import { OPERATOR_SIGNAL_STEP_GAP_MINUTES } from '@projectman/shared';
import type { ObligationKind, OperatorWatch, ProjectConfig, Task } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { openOverdueObligation } from './helpers/overdue-obligation';

/** PM-550: the wake-up text of the Operator by the project's level, with the step, the budget and the follow-up of each signal. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};

async function setup(level: OperatorWatch | undefined, adjust?: (config: ProjectConfig) => void) {
  now = new Date('2026-10-12T10:00:00Z');
  h = await createDomainHarness({
    now: () => now,
    adjust: (config) => {
      const pm = config.team.members.find((m) => m.handle === 'pm')!;
      if (pm.kind === 'ai') pm.onLeave = false;
      if (level) config.team.operatorWatch = level;
      adjust?.(config);
    },
  });
}

async function place(patch: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>): Promise<Task> {
  const card = await h.domain.tasks.create('AR', { title: 'Card', repo: 'web' }, OWNER_ACTOR);
  h.repos.tasks.update(card.id, { ...patch, updatedAt: now.toISOString() });
  return h.repos.tasks.get(card.key)!;
}

/** A card whose open step the PM was told about (PM-1152); its signal is delivered to the Operator. */
async function overdueCard(
  opts: {
    patch?: Partial<Pick<Task, 'stageId' | 'status' | 'assignee'>>;
    kind?: ObligationKind;
    responsible?: string;
  } = {},
) {
  const card = await place(opts.patch ?? { stageId: 'development', status: 'active', assignee: 'dev-1' });
  const { id, signalId } = openOverdueObligation(h, card, { at: now, ...opts });
  await h.domain.operatorSignals.deliver('AR');
  await flush();
  return { card, id, signal: h.repos.operatorSignals.get(signalId)! };
}

const operator = async (): Promise<ToolContext> => ({
  projectKey: 'AR',
  member: 'pm',
  taskKey: null,
  sessionId: (await waitForSession(h.domain, { member: 'pm' })).id,
});

/** The wake-up texts the Operator got, the last one first read. */
const wakeText = () =>
  [...h.runner.started.map((s) => s.initialMessage ?? ''), ...h.runner.messages.map((m) => m.text)]
    .filter((text) => text.includes('Projectman system signals'))
    .at(-1)!;
const wakeRows = (text = wakeText()): Array<Record<string, unknown>> =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
const header = (text = wakeText()) =>
  text.slice(text.indexOf('Projectman system signals'), text.indexOf('\n{'));

const noStep = { step: null, steps_left: 0, next_step_at: null, steps: [], follow_up: false };

it.each(['report', 'unblock', 'drive'] as const)(
  'keeps diagnosis and the single verified report within PM authority at %s',
  async (level) => {
    await setup(level);
    await overdueCard();
    const text = header();
    expect(h.runner.started.some((session) => session.member === 'operator')).toBe(false);
    expect(text).toContain('Read get_task before referring to a card');
    expect(text).toContain('distinguish active work, actual decision waits and normal offline queued work');
    expect(text).toContain('smallest permitted coordination step');
    expect(text).toContain('consider machine load and verify the result');
    expect(text).toContain('Group related decisions in the single summary');
    expect(text).toContain('screening and signals are not owner requests');
    expect(text).toContain('grant no settings or critical-operation authority');
    expect(text).toContain('one message for the whole wake-up');
  },
);

describe('level report', () => {
  it('keeps the ban, adds the one message and gives no step', async () => {
    await setup('report');
    const { signal } = await overdueCard();
    expect(header()).toContain('Change nothing until an owner says yes.');
    expect(header()).toContain('one message for the whole wake-up');
    expect(header()).toContain('signal_ids');
    expect(header()).toContain('dismiss_signal and a note');
    expect(header()).toContain('actionable_signal_ids');
    expect(header()).not.toContain('steps_left');
    expect(wakeRows()).toMatchObject([{ id: signal.id, kind: 'obligation_overdue', ...noStep }]);
  });

  it('is the default when the project sets no level', async () => {
    await setup(undefined);
    await overdueCard();
    expect(header()).toContain('Change nothing until an owner says yes.');
    expect(wakeRows()).toMatchObject([noStep]);
  });
});

describe('level unblock', () => {
  it('names the step, tells the budget and the never list, and has no general ban', async () => {
    await setup('unblock');
    const { card, signal } = await overdueCard();
    const text = header();
    expect(text).not.toContain('Change nothing');
    expect(text).toContain('you may take it yourself with its signal_id after weighing it');
    expect(text).toContain('follow_up true');
    expect(text).toContain('On a signal never merge, release, approve, move a card');
    // The same sense as the system prompt's signal rules: the two texts must not contradict each other.
    expect(text).toContain(
      'When a stalled, silent, outage or nobody signal needs someone to act, open an integrator todo with open_integrator_todo (what, where, expected) instead of asking the owners; when the card is already followed (obligation_tracked), leave it. A decision only the owners make (cost, deletion, publishing, direction, approval) goes to them with ask_human',
    );
    expect(text).not.toContain('always go to the owners');
    expect(text).toContain("Never stop another member's processes yourself.");
    expect(text).toContain('one message for the whole wake-up');
    expect(text).toContain('dismiss_signal and a note');
    expect(wakeRows()).toMatchObject([
      {
        id: signal.id,
        step: { tool: 'start_task', task_key: card.key, members: [] },
        steps_left: 1,
        next_step_at: null,
        steps: [],
        follow_up: false,
      },
    ]);
  });

  it('names the responsible of a step that is not a start of the card', async () => {
    await setup('unblock');
    const { card } = await overdueCard({
      patch: { stageId: 'code_review', status: 'waiting' },
      kind: 'review_step',
      responsible: 'cr',
    });
    expect(wakeRows().find((row) => row.kind === 'obligation_overdue')).toMatchObject({
      step: { tool: 'start_member', task_key: card.key, members: ['cr'] },
      steps_left: 1,
    });
  });

  it('carries the obligation in the facts of the signal', async () => {
    await setup('unblock');
    const { card, id } = await overdueCard();
    expect(wakeRows()[0]!.facts).toMatchObject({
      obligation: { id, kind: 'work', responsible: 'dev-1', subject: card.key },
    });
  });
});

describe('level drive', () => {
  it('gives three steps on the signal', async () => {
    await setup('drive');
    await overdueCard();
    expect(header()).toContain('When steps_left is 0, bring the signal to the owners.');
    expect(header()).not.toContain('Change nothing');
    expect(wakeRows()).toMatchObject([{ kind: 'obligation_overdue', steps_left: 3 }]);
  });

  it('shows a signal again as a follow-up with its steps and what is left of the budget', async () => {
    await setup('drive');
    const { card, signal } = await overdueCard();
    const stepAt = now.toISOString();
    await h.domain.teamTools.startTask(await operator(), { taskKey: card.key, signalId: signal.id });
    later(OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    const session = (await operator()).sessionId;
    h.runner.setState(session, 'working');
    h.runner.setState(session, 'idle');
    await flush();
    await h.domain.operatorSignals.deliver('AR');
    await flush();
    expect(wakeRows()).toMatchObject([
      {
        id: signal.id,
        step: { tool: 'start_task', task_key: card.key, members: [] },
        steps_left: 2,
        next_step_at: null,
        steps: [{ at: stepAt, member: null, task_key: card.key, status: 'done' }],
        follow_up: true,
      },
    ]);
  });
});
