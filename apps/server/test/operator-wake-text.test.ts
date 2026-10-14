import { afterEach, describe, expect, it } from 'vitest';
import {
  OPERATOR_IDLE_MINUTES,
  OPERATOR_MERGE_WAIT_MINUTES,
  OPERATOR_READY_WAITING_MINUTES,
  OPERATOR_SIGNAL_STEP_GAP_MINUTES,
} from '@projectman/shared';
import type { OperatorSignalKind, OperatorWatch, ProjectConfig, Task } from '@projectman/shared';
import type { ToolContext } from '../src/contracts';
import type { MergeRecord } from '../src/db';
import { createDomainHarness, OWNER_ACTOR } from './helpers/domain-harness';
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

const operator = (): ToolContext => ({
  projectKey: 'AR',
  member: 'operator',
  taskKey: null,
  sessionId: h.domain.sessions.list('AR', { member: 'operator' })[0]!.id,
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

describe('level report', () => {
  it('keeps the ban, adds the one message and gives no step', async () => {
    await setup('report');
    const { signal } = await idleCard();
    expect(header()).toContain('Change nothing until an owner says yes.');
    expect(header()).toContain('one message for the whole wake-up');
    expect(header()).toContain('signal_ids');
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
    expect(text).toContain('stalled, silent, outage and nobody signals always go to the owners');
    expect(text).toContain('one message for the whole wake-up');
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
    await h.domain.teamTools.startTask(operator(), { taskKey: card.key, signalId: signal.id });
    // The started developer finishes a turn and sits idle, so the idle case stands again after a while.
    const developer = h.domain.sessions.list('AR', { member: 'dev-1' })[0]!;
    h.runner.setState(developer.id, 'working');
    h.runner.setState(developer.id, 'idle');
    await flush();
    later(OPERATOR_IDLE_MINUTES + OPERATOR_SIGNAL_STEP_GAP_MINUTES);
    const session = operator().sessionId;
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
