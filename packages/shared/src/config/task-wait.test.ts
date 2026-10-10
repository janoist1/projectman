import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../domain/inbox';
import type { Task } from '../domain/task';
import { ProjectConfig } from './schema';
import { taskWait } from './task-wait';
import type { TaskWaitInput } from './task-wait';

type Options = {
  refines?: boolean;
  scopeSetters?: { members: string[] };
  approvedSetters?: 'humans' | { members: string[]; humansOnly?: boolean };
  mergeOwners?: string[];
};

function config({
  refines = false,
  scopeSetters = { members: ['analyst'] },
  approvedSetters = 'humans',
  mergeOwners = ['lead'],
}: Options = {}) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner' },
        { kind: 'human', handle: 'kata', displayName: 'Kata', access: 'admin' },
        { kind: 'ai', handle: 'analyst', displayName: 'Analyst', role: 'business_analyst', sponsor: 'owner' },
        { kind: 'ai', handle: 'lead', displayName: 'Lead', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        {
          id: 'ready',
          name: 'Ready',
          kind: 'queue',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'scope-ok' }] },
        },
        { id: 'dev', name: 'Development', kind: 'work', owners: ['dev-1'], columnId: 'all' },
        { id: 'merge', name: 'Merge', kind: 'step', owners: mergeOwners, columnId: 'all' },
        {
          id: 'accept',
          name: 'Accept',
          kind: 'step',
          owners: ['owner'],
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'approved' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        ...(refines ? [{ id: 'refine', name: 'Refine', setBy: 'anyone' }] : []),
        { id: 'scope-ok', name: 'Scope ok', setBy: scopeSetters },
        { id: 'approved', name: 'Approved', setBy: approvedSetters },
        { id: 'waiting-answer', name: 'Waiting', blocks: true },
      ],
    },
  });
}

const NOW = '2026-10-10T10:00:00.000Z';

function card(over: Partial<Task> = {}): Task {
  return {
    id: 'tsk_1',
    projectKey: 'AC',
    key: 'AC-1',
    title: 'Card',
    description: '',
    stageId: 'dev',
    status: 'active',
    assignee: 'dev-1',
    repo: null,
    priority: null,
    labels: [],
    links: [],
    visibility: 'internal',
    createdBy: 'owner',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-05T10:00:00.000Z',
    closedAt: null,
    ...over,
  };
}

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inb_1',
    projectKey: 'AC',
    kind: 'question',
    state: 'open',
    assignees: ['owner'],
    source: 'dev-1',
    sessionId: null,
    taskKey: 'AC-1',
    title: 'Question',
    body: null,
    resolution: null,
    payload: {},
    options: [],
    createdAt: '2026-10-09T10:00:00.000Z',
    ...over,
  };
}

function wait(task: Task, over: Partial<TaskWaitInput> = {}, options: Options = {}) {
  return taskWait({
    task,
    config: config(options),
    openItems: [],
    workers: [],
    holders: [],
    openPrerequisites: [],
    viewer: null,
    ...over,
  });
}

type StartWaiting = NonNullable<Task['startWaiting']>;
type FixLimit = NonNullable<Task['fixLimit']>;

/** A card held at the fix round limit, decided by the lead by default. */
const hold = (over: Partial<FixLimit> = {}): FixLimit => ({
  phase: 'lead',
  rounds: 3,
  limit: 3,
  changeRequests: 3,
  designChangeRequests: 0,
  sendBacks: 0,
  decider: 'lead',
  deciders: [],
  reason: null,
  heldAt: NOW,
  ...over,
});

const handles = (result: ReturnType<typeof wait>) => result?.next.map((member) => member.handle);

const gateItem = (assignees: string[], over: Partial<InboxItem> = {}) =>
  item({
    kind: 'decision',
    assignees,
    source: 'system',
    payload: {
      gate: {
        requestId: 'gat_1',
        taskKey: 'AC-1',
        fromStageId: 'merge',
        toStageId: 'accept',
        stageId: 'accept',
        label: 'approved',
        requestedBy: { kind: 'system', handle: null },
      },
    },
    ...over,
  });

const handOnItem = (assignees = ['pm']) =>
  item({
    id: 'inb_hand',
    kind: 'hand_on',
    assignees,
    source: 'dev-1',
    payload: { handOn: { taskKey: 'AC-1', fromStageId: 'dev', toStageId: 'merge', requestedBy: 'dev-1' } },
  });

const handOn = {
  fromStageId: 'dev',
  toStageId: 'merge',
  mover: 'pm',
  requestedBy: 'dev-1',
  requestedAt: '2026-10-09T09:00:00.000Z',
  inboxItemId: 'inb_hand',
};

describe('a closed card', () => {
  it('has no wait', () => {
    expect(wait(card({ status: 'done' }))).toBeNull();
    expect(wait(card({ status: 'cancelled' }))).toBeNull();
    expect(wait(card({ stageId: 'done' }))).toBeNull();
    expect(wait(card({ kind: 'theme' }))).toBeNull();
  });
});

describe('every reason', () => {
  it('prerequisite: the start waits for the cards it needs', () => {
    const result = wait(
      card({ startWaiting: { reason: 'prerequisite_open', prerequisites: ['AC-9'], since: NOW } }),
      { openPrerequisites: ['AC-8'] },
    );
    expect(result).toMatchObject({ reason: 'prerequisite', prerequisites: ['AC-8'], since: NOW });
    expect(result?.startWaiting?.reason).toBe('prerequisite_open');
  });

  it('prerequisite: a queued card with an open prerequisite', () => {
    expect(wait(card({ stageId: 'backlog', assignee: null }), { openPrerequisites: ['AC-8'] })).toMatchObject(
      {
        reason: 'prerequisite',
        prerequisites: ['AC-8'],
      },
    );
    expect(wait(card({ stageId: 'backlog', assignee: null, status: 'waiting' }))).toMatchObject({
      reason: 'prerequisite',
      prerequisites: [],
    });
  });

  it('handing_off: the old assignee hands the card over', () => {
    const result = wait(
      card({
        handoff: {
          id: 'hnd_1',
          from: 'dev-1',
          to: 'lead',
          fromProvider: 'claude',
          toProvider: 'claude',
          reason: 'manual',
          step: 'waiting_point',
          startedAt: NOW,
          deadlineAt: null,
        },
      }),
      {
        workers: [
          { handle: 'lead', since: '2026-10-10T09:00:00.000Z', handingOff: false },
          { handle: 'dev-1', since: NOW, handingOff: true },
        ],
      },
    );
    expect(result).toMatchObject({ reason: 'handing_off', since: NOW });
    expect(handles(result)).toEqual(['dev-1']);
  });

  it('start_waiting: the start waits for something', () => {
    const startWaiting: StartWaiting = {
      reason: 'label_missing',
      labels: ['scope-ok'],
      member: 'analyst',
      since: NOW,
    };
    const result = wait(card({ stageId: 'ready', assignee: null, startWaiting }));
    expect(result).toMatchObject({ reason: 'start_waiting', since: NOW, startWaiting });
    expect(handles(result)).toEqual(['analyst']);
  });

  it('inbox: an open item waits for a person', () => {
    const result = wait(card(), { openItems: [item({ assignees: ['owner', 'kata'] })] });
    expect(result).toMatchObject({
      reason: 'inbox',
      inboxItemId: 'inb_1',
      inboxKind: 'question',
      since: '2026-10-09T10:00:00.000Z',
    });
    expect(result?.next).toEqual([
      { handle: 'owner', kind: 'human' },
      { handle: 'kata', kind: 'human' },
    ]);
  });

  it('blocked: the status is blocked', () => {
    expect(wait(card({ status: 'blocked' }))).toMatchObject({ reason: 'blocked', next: [] });
  });

  it('fix_limit: the card is held at the fix round limit', () => {
    const fixLimit = hold();
    const result = wait(card({ fixLimit }));
    expect(result).toMatchObject({ reason: 'fix_limit', since: NOW });
    expect(handles(result)).toEqual(['lead']);
    expect(
      handles(wait(card({ fixLimit: { ...fixLimit, phase: 'owner', deciders: ['owner', 'kata'] } }))),
    ).toEqual(['owner', 'kata']);
  });

  it('fix_limit: the open decision item is the one the wait is about', () => {
    const fixLimit = hold({ phase: 'owner', decider: null, deciders: ['owner'], reason: 'again' });
    const decision = item({
      id: 'inb_fix',
      kind: 'decision',
      payload: {
        fixLimit: {
          taskKey: 'AC-1',
          rounds: 3,
          limit: 3,
          changeRequests: 3,
          designChangeRequests: 0,
          sendBacks: 0,
          reason: 'again',
          decider: null,
          note: null,
        },
      },
    });
    expect(wait(card({ fixLimit }), { openItems: [decision] })).toMatchObject({
      reason: 'fix_limit',
      inboxItemId: 'inb_fix',
      inboxKind: 'decision',
    });
    expect(wait(card({ fixLimit }), { openItems: [decision], viewer: 'owner' })).toMatchObject({
      reason: 'fix_limit',
      inboxItemId: 'inb_fix',
    });
  });

  it('working: somebody works on it now, in the order given', () => {
    const result = wait(card(), {
      workers: [
        { handle: 'dev-1', since: '2026-10-10T08:00:00.000Z', handingOff: false },
        { handle: 'lead', since: '2026-10-10T09:00:00.000Z', handingOff: false },
      ],
    });
    expect(result).toMatchObject({ reason: 'working', since: '2026-10-10T08:00:00.000Z' });
    expect(handles(result)).toEqual(['dev-1', 'lead']);
    expect(result?.next.every((member) => member.kind === 'ai')).toBe(true);
  });

  it('held: a holding label holds the card', () => {
    expect(wait(card({ labels: ['waiting-answer', 'plain-tag'] }))).toMatchObject({
      reason: 'held',
      labels: ['waiting-answer'],
    });
  });

  it('hand_on: the work is done and the card mover takes it on', () => {
    const result = wait(card({ handOn }), { openItems: [handOnItem()] });
    expect(result).toMatchObject({
      reason: 'hand_on',
      toStageId: 'merge',
      inboxItemId: 'inb_hand',
      inboxKind: 'hand_on',
      since: handOn.requestedAt,
    });
    expect(result?.next).toEqual([{ handle: 'pm', kind: 'ai' }]);
  });

  it('hand_on: an open request alone is enough', () => {
    const result = wait(card(), { openItems: [handOnItem(['owner'])] });
    expect(result).toMatchObject({ reason: 'hand_on', toStageId: 'merge', inboxItemId: 'inb_hand' });
    expect(handles(result)).toEqual(['owner']);
  });

  it('approval: the open gate request names the approvers', () => {
    const result = wait(card({ stageId: 'merge', labels: [] }), {
      openItems: [gateItem(['owner', 'kata'])],
    });
    expect(result).toMatchObject({
      reason: 'approval',
      labels: ['approved'],
      toStageId: 'accept',
      inboxItemId: 'inb_1',
      inboxKind: 'decision',
    });
    expect(handles(result)).toEqual(['owner', 'kata']);
  });

  it('approval: a done stage lacking only a person approval, before the request is in the inbox', () => {
    const result = wait(card({ stageId: 'merge' }));
    expect(result).toMatchObject({ reason: 'approval', labels: ['approved'], toStageId: 'accept' });
    expect(handles(result)).toEqual(['owner', 'kata']);
  });

  it('labels_missing: the next gate lacks labels, the AI setters first', () => {
    // A project that refines, with a card that is not marked for it: the Start is refused (PM-291).
    const result = wait(
      card({ stageId: 'ready', assignee: null }),
      {},
      { refines: true, scopeSetters: { members: ['owner', 'analyst'] } },
    );
    expect(result).toMatchObject({ reason: 'labels_missing', labels: ['scope-ok'], toStageId: 'dev' });
    expect(result?.next).toEqual([{ handle: 'analyst', kind: 'ai' }]);
  });

  it('labels_missing: only people set the label, so they are next', () => {
    const result = wait(
      card({ stageId: 'ready', assignee: null }),
      {},
      { scopeSetters: { members: ['owner'] } },
    );
    expect(result?.reason).toBe('labels_missing');
    expect(result?.next).toEqual([{ handle: 'owner', kind: 'human' }]);
  });

  it('ready: where an AI member sets the missing label, the Start goes ahead (PM-236)', () => {
    expect(wait(card({ stageId: 'ready', assignee: null }))).toMatchObject({ reason: 'ready' });
  });

  it('refinement: a refinement step is on turn', () => {
    const result = wait(
      card({ stageId: 'ready', assignee: null, labels: ['refine'] }),
      {},
      { refines: true },
    );
    expect(result).toMatchObject({ reason: 'refinement', labels: ['scope-ok'] });
    expect(handles(result)).toEqual(['analyst']);
  });

  it('refinement: every step is done, the card moves on by itself', () => {
    const result = wait(
      card({ stageId: 'ready', assignee: null, labels: ['refine', 'scope-ok'] }),
      {},
      { refines: true },
    );
    expect(result).toMatchObject({ reason: 'refinement', labels: [], next: [] });
  });

  it('ready: a queued card may start', () => {
    const result = wait(card({ stageId: 'ready', assignee: null, labels: ['scope-ok'] }));
    expect(result).toMatchObject({ reason: 'ready', toStageId: 'dev', next: [] });
  });

  it('queued: waits for the humans owning the stage', () => {
    const result = wait(card({ stageId: 'accept', status: 'waiting', labels: ['approved'] }));
    expect(result?.reason).toBe('queued');
    expect(result?.next).toEqual([{ handle: 'owner', kind: 'human' }]);
  });

  it('assignee: in a work stage its assignee takes it on', () => {
    const result = wait(card());
    expect(result).toMatchObject({ reason: 'assignee', since: '2026-10-05T10:00:00.000Z' });
    expect(result?.next).toEqual([{ handle: 'dev-1', kind: 'ai' }]);
  });

  it('queued: an AI stage owner with an idle session holds the card', () => {
    const result = wait(card({ stageId: 'merge', labels: ['approved'] }), { holders: ['lead'] });
    expect(result?.reason).toBe('queued');
    expect(result?.next).toEqual([{ handle: 'lead', kind: 'ai' }]);
  });

  it('queued: otherwise it waits for the stage', () => {
    expect(wait(card({ stageId: 'merge', labels: ['approved'] }))).toMatchObject({
      reason: 'queued',
      next: [],
    });
  });

  it('nobody: a step stage without an owner', () => {
    expect(wait(card({ stageId: 'merge', labels: ['approved'] }), {}, { mergeOwners: [] })).toMatchObject({
      reason: 'nobody',
      next: [],
    });
  });

  it('nobody: no label setter at all', () => {
    expect(
      wait(card({ stageId: 'ready', assignee: null }), {}, { scopeSetters: { members: ['ghost'] } }),
    ).toMatchObject({ reason: 'nobody', labels: ['scope-ok'] });
  });

  it('nobody: no approver of the missing approval', () => {
    expect(
      wait(card({ stageId: 'merge' }), {}, { approvedSetters: { members: ['ghost'], humansOnly: true } }),
    ).toMatchObject({ reason: 'nobody', labels: ['approved'] });
  });
});

describe('the order of the reasons', () => {
  const worker = { handle: 'dev-1', since: NOW, handingOff: false };

  it('an item for the viewer comes before the workers; for somebody else it comes after them', () => {
    const items = [item({ assignees: ['owner'] })];
    expect(wait(card(), { openItems: items, workers: [worker], viewer: 'owner' })?.reason).toBe('inbox');
    expect(wait(card(), { openItems: items, workers: [worker], viewer: 'kata' })?.reason).toBe('working');
    expect(wait(card(), { openItems: items, workers: [worker], viewer: null })?.reason).toBe('working');
    expect(wait(card(), { openItems: items, viewer: 'kata' })?.reason).toBe('inbox');
  });

  it('a holding label comes before the hand-on, the hand-on before an item for somebody else', () => {
    const items = [handOnItem(), item({ id: 'inb_q', createdAt: '2026-10-10T09:00:00.000Z' })];
    expect(wait(card({ handOn, labels: ['waiting-answer'] }), { openItems: items })?.reason).toBe('held');
    expect(wait(card({ handOn }), { openItems: items })?.reason).toBe('hand_on');
    expect(wait(card(), { openItems: [item({ id: 'inb_q' })] })?.reason).toBe('inbox');
  });

  it('the hand-on addressed to the viewer is theirs first', () => {
    const result = wait(card({ handOn }), {
      openItems: [handOnItem(['owner']), item({ id: 'inb_q', assignees: ['kata'] })],
      workers: [worker],
      viewer: 'owner',
    });
    expect(result).toMatchObject({ reason: 'hand_on', inboxItemId: 'inb_hand' });
  });

  it('a blocked status and the fix limit come before the workers', () => {
    expect(wait(card({ status: 'blocked' }), { workers: [worker] })?.reason).toBe('blocked');
    expect(wait(card({ fixLimit: hold() }), { workers: [worker] })?.reason).toBe('fix_limit');
  });

  it('the start waiting for prerequisites comes before everything', () => {
    const startWaiting: StartWaiting = { reason: 'prerequisite_open', prerequisites: ['AC-9'], since: NOW };
    expect(
      wait(card({ startWaiting }), { workers: [worker], openItems: [item()], viewer: 'owner' })?.reason,
    ).toBe('prerequisite');
  });

  it('another start wait comes before the items, a handoff before the start wait', () => {
    const startWaiting: StartWaiting = { reason: 'handoff_open', member: 'lead', since: NOW };
    expect(wait(card({ startWaiting }), { openItems: [item()], viewer: 'owner' })?.reason).toBe(
      'start_waiting',
    );
  });

  it('an item for the viewer is asked of them even for an approval the card lacks', () => {
    const result = wait(card({ stageId: 'merge' }), { openItems: [gateItem(['owner'])], viewer: 'owner' });
    expect(result?.reason).toBe('approval');
    expect(handles(result)).toEqual(['owner']);
  });
});
