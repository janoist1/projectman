import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../domain/inbox';
import type { Task } from '../domain/task';
import { cardDuty, CardHoldCode } from './card-duty';
import { cardStateProblem, cardStateSpace } from './card-state-space';
import { ProjectConfig } from './schema';
import { TaskWaitReason, taskWait } from './task-wait';
import type { TaskWaitInput } from './task-wait';

const ai = (handle: string, role: string, over: Record<string, unknown> = {}) => ({
  kind: 'ai',
  handle,
  displayName: handle,
  role,
  sponsor: 'owner',
  ...over,
});

/** Two queues, a work stage, a step and the done stage; the gates ask for the usual labels. */
function config({ onLeave = [] as string[] } = {}) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'ST', name: 'State', workspacePath: '/work/state', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        ai('analyst', 'business_analyst', { onLeave: onLeave.includes('analyst') }),
        ai('architect', 'architect', { onLeave: onLeave.includes('architect') }),
        ai('pm', 'project_manager'),
        ai('lead', 'developer', { onLeave: onLeave.includes('lead') }),
        ai('dev', 'developer', { onLeave: onLeave.includes('dev') }),
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'incoming', name: 'Incoming', kind: 'queue', columnId: 'all' },
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          gate: {
            conditions: [
              { type: 'has_label', label: 'scope-ok' },
              { type: 'has_label', label: 'plan-ok', when: 'needs-plan' },
            ],
          },
        },
        { id: 'dev', name: 'Development', kind: 'work', owners: ['dev'], columnId: 'all' },
        // A step nobody owns: a faulty set-up the rule must still classify.
        { id: 'verify', name: 'Verify', kind: 'step', owners: [], columnId: 'all' },
        { id: 'review', name: 'Review', kind: 'step', owners: ['lead'], columnId: 'all' },
        {
          id: 'done',
          name: 'Done',
          kind: 'done',
          columnId: 'all',
          gate: {
            conditions: [
              { type: 'has_label', label: 'code-review-ok' },
              { type: 'has_label', label: 'qa-ok', when: 'needs-qa' },
              { type: 'has_label', label: 'design-review-ok', when: 'ui' },
            ],
          },
        },
      ],
      labels: [
        { id: 'refine', name: 'Refine', setBy: 'anyone' },
        { id: 'scope-ok', name: 'Scope ok', setBy: { members: ['analyst', 'architect'] } },
        { id: 'needs-plan', name: 'Needs plan', setBy: 'anyone' },
        { id: 'plan-ok', name: 'Plan ok', setBy: { members: ['architect'] } },
        { id: 'needs-qa', name: 'Needs QA', setBy: 'anyone' },
        { id: 'qa-ok', name: 'QA ok', setBy: 'humans' },
        { id: 'ui', name: 'UI', setBy: 'anyone' },
        { id: 'design-review-ok', name: 'Design review ok', setBy: { members: ['owner'] } },
        { id: 'code-review-ok', name: 'Code review ok', setBy: { members: ['lead'] } },
        { id: 'waiting-answer', name: 'Waiting', blocks: true },
      ],
    },
  });
}

const SINCE = '2026-10-05T10:00:00.000Z';

function card(over: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    projectKey: 'ST',
    key: 'ST-1',
    title: 'Card',
    description: '',
    stageId: 'dev',
    status: 'active',
    assignee: 'dev',
    repo: null,
    priority: null,
    labels: [],
    links: [],
    createdBy: 'owner',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: SINCE,
    closedAt: null,
    ...over,
  };
}

function question(assignees: string[]): InboxItem {
  return {
    id: 'inb_1',
    projectKey: 'ST',
    kind: 'question',
    state: 'open',
    assignees,
    source: 'dev',
    sessionId: null,
    taskKey: 'ST-1',
    title: 'Question',
    body: null,
    resolution: null,
    payload: {},
    options: [],
    createdAt: SINCE,
  };
}

/** The duty of a card under the test configuration. */
function dutyOf(task: Task, over: Partial<TaskWaitInput> & { onLeave?: string[]; openParts?: number } = {}) {
  const { onLeave, openParts = 0, ...input } = over;
  const cfg = input.config ?? config({ onLeave });
  const state = {
    task,
    config: cfg,
    openItems: [],
    workers: [],
    holders: [],
    openPrerequisites: [],
    viewer: null,
    subtasks: Array.from({ length: openParts }, () => ({ parentKey: task.key, status: 'active' as const })),
    ...input,
  };
  const wait = taskWait(state);
  if (!wait) throw new Error('the card has no wait');
  return cardDuty({ task, wait, config: cfg, openItems: state.openItems });
}

describe('the state space', () => {
  it('gives every open card an owner or a stated reason, and reaches every wait reason and hold', () => {
    const problems: string[] = [];
    const reasons = new Set<string>();
    const holds = new Set<string>();
    for (const state of cardStateSpace(config())) {
      const problem = cardStateProblem(state);
      if (problem && problems.length < 10) problems.push(problem);
      const wait = taskWait(state);
      if (!wait) continue;
      reasons.add(wait.reason);
      const duty = cardDuty({
        task: state.task,
        wait,
        config: state.config,
        openItems: state.openItems,
      });
      if (duty.kind === 'hold') holds.add(duty.code);
    }
    expect(problems).toEqual([]);
    expect([...reasons].sort()).toEqual([...TaskWaitReason.options].sort());
    expect([...holds].sort()).toEqual([...CardHoldCode.options].sort());
  }, 120_000);

  it('fails a state that falls to unowned for no listed reason', () => {
    // A fix round limit decided by the integrator names no member: nobody follows the card.
    const fixLimit = {
      phase: 'owner' as const,
      rounds: 3,
      limit: 3,
      changeRequests: 3,
      designChangeRequests: 0,
      sendBacks: 0,
      decider: null,
      deciders: [],
      reason: null,
      recipient: 'integrator' as const,
      heldAt: SINCE,
    };
    const state = {
      task: card({ fixLimit }),
      config: config(),
      openItems: [],
      workers: [],
      holders: [],
      openPrerequisites: [],
      viewer: null,
      description: 'fix limit with the integrator',
    };
    expect(cardStateProblem(state)).toMatch(/fix_limit -> unowned/);
  });
});

describe('cardDuty', () => {
  it('holds an unworked-out card of the first stage as backlog, not as an AI step', () => {
    expect(dutyOf(card({ stageId: 'incoming', status: 'waiting', assignee: null }))).toMatchObject({
      reason: 'labels_missing',
      kind: 'hold',
      code: 'backlog',
    });
  });

  it('gives a card the missing labels of a later stage to the one AI member who sets them', () => {
    const duty = dutyOf(
      card({ stageId: 'ready', status: 'waiting', assignee: null, labels: ['needs-plan', 'scope-ok'] }),
    );
    expect(duty).toMatchObject({ reason: 'labels_missing', kind: 'member', member: 'architect' });
  });

  it('leaves a card unowned when several AI members could take it on', () => {
    // The scope label is the analyst's to set and the plan label the architect's.
    const duty = dutyOf(
      card({ stageId: 'ready', status: 'waiting', assignee: null, labels: ['needs-plan'] }),
    );
    expect(duty).toMatchObject({ reason: 'labels_missing', kind: 'unowned' });
  });

  it('gives a held card to the one asked by its open question', () => {
    const duty = dutyOf(card({ labels: ['waiting-answer'] }), { openItems: [question(['owner'])] });
    expect(duty).toMatchObject({ reason: 'held', kind: 'person', people: ['owner'] });
  });

  it('leaves a held card unowned when nobody was asked', () => {
    expect(dutyOf(card({ labels: ['waiting-answer'] }))).toMatchObject({ reason: 'held', kind: 'unowned' });
  });

  it('has the system move a card whose stage is done on', () => {
    const duty = dutyOf(
      card({ stageId: 'review', status: 'active', assignee: null, labels: ['code-review-ok'] }),
    );
    expect(duty).toMatchObject({ reason: 'queued', kind: 'system', step: 'advance' });
  });

  it.each([
    [1, { kind: 'hold', code: 'parts' }],
    [0, { kind: 'member', member: 'dev' }],
  ])('has an unowned card of a work stage with %i open parts as %o', (openParts, expected) => {
    const idle = card({ status: 'waiting', assignee: null });
    expect(dutyOf(idle, { openParts })).toMatchObject({
      reason: openParts ? 'collecting' : 'queued',
      ...expected,
    });
  });

  it('keeps the automatic advance of a card with open parts', () => {
    const done = card({ stageId: 'review', status: 'active', assignee: null, labels: ['code-review-ok'] });
    expect(dutyOf(done, { openParts: 1 })).toMatchObject({
      reason: 'collecting',
      kind: 'system',
      step: 'advance',
    });
  });

  it('gives a card a member on leave holds to nobody', () => {
    expect(dutyOf(card(), { onLeave: ['dev'] })).toMatchObject({ reason: 'assignee', kind: 'unowned' });
    expect(dutyOf(card())).toMatchObject({ reason: 'assignee', kind: 'member', member: 'dev' });
  });

  it('gives a part its creator, unless the creator is on leave', () => {
    const part = card({
      stageId: 'incoming',
      status: 'waiting',
      assignee: null,
      parentKey: 'ST-0',
      createdBy: 'analyst',
    });
    expect(dutyOf(part)).toMatchObject({ reason: 'part_left', kind: 'member', member: 'analyst' });
    expect(dutyOf(part, { onLeave: ['analyst'] })).toMatchObject({ reason: 'part_left', kind: 'unowned' });
  });

  it('gives the refinement to the system when several AI members could take the step', () => {
    const duty = dutyOf(card({ stageId: 'incoming', status: 'waiting', assignee: null, labels: ['refine'] }));
    expect(duty).toMatchObject({ reason: 'refinement', kind: 'system', step: 'refinement' });
  });

  it('offers a ready card to the member the system asked, else has the system start it', () => {
    const ready = card({ stageId: 'ready', status: 'active', assignee: null, labels: ['scope-ok'] });
    expect(dutyOf({ ...ready, startOffer: { to: 'dev', since: SINCE } })).toMatchObject({
      kind: 'member',
      member: 'dev',
    });
    expect(dutyOf(ready)).toMatchObject({ reason: 'ready', kind: 'system', step: 'start' });
  });

  it.each([
    [1, { kind: 'hold', code: 'parts' }],
    [0, { kind: 'system', step: 'start' }],
  ])('has a ready card with %i open parts as %o', (openParts, expected) => {
    const ready = card({ stageId: 'ready', status: 'active', assignee: null, labels: ['scope-ok'] });
    expect(dutyOf(ready, { openParts })).toMatchObject({
      reason: openParts ? 'collecting' : 'ready',
      ...expected,
    });
  });

  it('holds a ready card by the reason of its ready hold', () => {
    const ready = card({ stageId: 'ready', status: 'active', assignee: null, labels: ['scope-ok'] });
    expect(dutyOf({ ...ready, readyHold: { reason: 'senior_busy', since: SINCE } })).toMatchObject({
      kind: 'hold',
      code: 'capacity',
    });
  });

  it.each([
    ['label_missing', { kind: 'member', member: 'dev' }],
    ['repo_required', { kind: 'person', people: ['owner'] }],
    ['workspace_dirty', { kind: 'system', step: 'start_retry' }],
    ['disk_low', { kind: 'hold', code: 'limit' }],
  ] as const)('classifies the start waiting reason %s', (reason, expected) => {
    const startWaiting = { reason, since: SINCE, member: 'dev' };
    expect(dutyOf(card({ startWaiting }))).toMatchObject({ reason: 'start_waiting', ...expected });
  });
});
