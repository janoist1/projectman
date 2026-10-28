import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
  OPERATOR_SIGNAL_WAKE_INTERVAL_MS,
} from '@projectman/shared';
import type { OperatorSignalKind, OperatorWatch, ProjectConfig, Task } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import type { MergeRecord } from '../src/db';
import { createDomainHarness, OWNER_ACTOR, waitForSession } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';

/** PM-550: the wake-up text of the Operator by the project's level, with the step, the budget and the follow-up of each signal. */
let h: DomainHarness;
let now: Date;
afterEach(async () => {
  await h?.cleanup();
});

const later = (minutes: number) => {
  now = new Date(now.getTime() + minutes * 60_000);
};
const open = (kind: OperatorSignalKind) =>
  h.repos.operatorSignals.list('AR').filter((s) => s.kind === kind && !s.resolvedAt);

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

async function idleCard() {
  const card = await place({ stageId: 'development', status: 'active', assignee: 'dev-1' });
  later(OPERATOR_IDLE_MINUTES);
  await h.domain.operatorSignals.sweep('AR');
  await flush();
  return { card, signal: open('idle')[0]! };
}

function mergeRow(taskKey: string): MergeRecord {
  return {
    id: `mrg_${taskKey}`,
    projectKey: 'AR',
    repo: 'web',
    base: 'main',
    commit: `branch-${taskKey}`,
    branch: `pm/${taskKey}`,
    fromStageId: 'code_review',
    toStageId: 'done',
    merger: 'dev-1',
    requestedAt: now.toISOString(),
    landed: 'nowhere',
    state: 'requested',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    taskKey,
  };
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
    await idleCard();
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
    const { signal } = await idleCard();
    expect(header()).toContain('Change nothing until an owner says yes.');
    expect(header()).toContain('one message for the whole wake-up');
    expect(header()).toContain('signal_ids');
    expect(header()).toContain('close with dismiss_signal and a note');
    expect(header()).toContain('actionable_signal_ids');
    expect(header()).not.toContain('steps_left');
    expect(wakeRows()).toMatchObject([{ id: signal.id, kind: 'idle', ...noStep }]);
  });

  it('is the default when the project sets no level', async () => {
    await setup(undefined);
    await idleCard();
    expect(header()).toContain('Change nothing until an owner says yes.');
    expect(wakeRows()).toMatchObject([noStep]);
  });
});

describe('level unblock', () => {
  it('names the step, tells the budget and the never list, and has no general ban', async () => {
    await setup('unblock');
    const { card, signal } = await idleCard();
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
    expect(text).toContain('close with dismiss_signal and a note');
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

  it('names the merger of a waiting merge', async () => {
    await setup('unblock');
    const card = await place({ stageId: 'code_review', status: 'waiting' });
    h.repos.taskMerges.save(mergeRow(card.key));
    later(OPERATOR_MERGE_WAIT_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(wakeRows().find((row) => row.kind === 'merge_waiting')).toMatchObject({
      step: { tool: 'start_member', task_key: card.key, members: ['dev-1'] },
      steps_left: 1,
    });
  });

  it('gives no step on a kind only drive covers', async () => {
    await setup('unblock', (config) => {
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue',
        owners: ['owner'],
        columnId: 'todo',
      });
    });
    await place({ stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    later(OPERATOR_READY_WAITING_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(wakeRows()).toMatchObject([{ kind: 'ready_waiting', step: null, steps_left: 1 }]);
  });
});

describe('level drive', () => {
  it('includes acknowledged cards and only new cards in wake facts, with the last dismissal', async () => {
    await setup('drive', (config) => {
      // A person moves the cards: the start round offers them to no AI member (PM-804), so the signal stays.
      config.team.cardMover = { kind: 'human', handle: 'owner' };
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue',
        owners: ['owner'],
        columnId: 'todo',
      });
    });
    const first = await place({ stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    later(OPERATOR_READY_WAITING_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(wakeRows()[0]!.facts).toEqual({
      cards: [first.key],
      new_cards: [first.key],
      last_dismissed: null,
    });
    const at = now.toISOString();
    const result = await h.domain.teamTools.dismissSignal(await operator(), {
      signalId: open('ready_waiting')[0]!.id,
      note: 'Parked intentionally.',
    });
    expect(result.state).toBe('dismissed');
    await h.domain.operatorSignals.sweep('AR');
    h.runner.setState((await operator()).sessionId, 'idle');
    later(1);
    const second = await place({ stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    // The stall's ten minutes are over, and so is the wake interval since the first wake-up.
    later(OPERATOR_SIGNAL_WAKE_INTERVAL_MS / 60_000);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(wakeRows()[0]!.facts).toEqual({
      cards: [first.key, second.key],
      new_cards: [second.key],
      last_dismissed: { at, by: 'pm', note: 'Parked intentionally.', cards: [first.key] },
    });
  });

  it('names the project manager for cards that stand ready, with three steps', async () => {
    await setup('drive', (config) => {
      config.pipeline.stages.splice(1, 0, {
        id: 'ready',
        name: 'Ready',
        kind: 'queue',
        owners: ['owner'],
        columnId: 'todo',
      });
      const pm = config.team.members.find((m) => m.handle === 'pm');
      if (pm?.kind === 'ai') pm.onLeave = false;
    });
    await place({ stageId: 'ready', status: 'active' });
    await h.domain.operatorSignals.sweep('AR');
    later(OPERATOR_READY_WAITING_MINUTES);
    await h.domain.operatorSignals.sweep('AR');
    await flush();
    expect(header()).toContain('When steps_left is 0, bring the signal to the owners.');
    expect(header()).not.toContain('Change nothing');
    expect(header()).toContain('close with dismiss_signal and a note');
    expect(wakeRows()).toMatchObject([
      {
        kind: 'ready_waiting',
        step: { tool: 'start_member', task_key: null, members: ['pm'] },
        steps_left: 3,
      },
    ]);
  });

  it('shows a signal again as a follow-up with its steps and what is left of the budget', async () => {
    await setup('drive');
    const { card, signal } = await idleCard();
    const stepAt = now.toISOString();
    await h.domain.teamTools.startTask(await operator(), { taskKey: card.key, signalId: signal.id });
    // The started developer finishes a turn and sits idle, so the idle case stands again after a while.
    const developer = await waitForSession(h.domain, { member: 'dev-1' });
    h.runner.setState(developer.id, 'working');
    h.runner.setState(developer.id, 'idle');
    await flush();
    later(OPERATOR_IDLE_MINUTES + OPERATOR_SIGNAL_STEP_GAP_MINUTES);
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
