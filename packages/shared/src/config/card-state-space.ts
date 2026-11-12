import { isPendingQuestion } from '../domain/inbox';
import { REFINE_LABEL } from '../domain/label';
import { TaskReadyHold } from '../domain/ready-hold';
import { TaskStartWaiting } from '../domain/task';
import type { Task } from '../domain/task';
import { cardDuty } from './card-duty';
import { stageOwners } from './duties';
import { isOnLeave } from './leave';
import { labelDefinition } from './labels';
import { memberOf, stageOf } from './lookup';
import type { ProjectConfig } from './schema';
import { taskWait } from './task-wait';
import type { TaskWait, TaskWaitInput } from './task-wait';

/**
 * Every state an open card can stand in under a configuration, for the completeness test of `cardDuty`
 * (PM-1224) and the server's test of the same. Each state is the input of `taskWait`, with the
 * configuration it was made under (the member on leave is a variant of it), and a description for a failure.
 */

export interface CardState extends TaskWaitInput {
  task: Task;
  description: string;
}

type SpaceConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/** Up to this many labels every subset is generated; above it only the small and the nearly full ones. */
const EXHAUSTIVE_LABELS = 10;

const THEN = '2026-10-01T10:00:00.000Z';
const SINCE = '2026-10-05T10:00:00.000Z';
const STATUSES = ['active', 'waiting', 'blocked'] as const;

/** The labels that change a card's wait: the gates' labels (and their `when`), the refine and the blocking ones. */
function labelUniverse(config: SpaceConfig): string[] {
  const ids = new Set<string>();
  for (const stage of config.pipeline.stages) {
    for (const condition of stage.gate?.conditions ?? []) {
      ids.add(condition.label);
      if (condition.when) ids.add(condition.when);
    }
  }
  if (labelDefinition(config, REFINE_LABEL)) ids.add(REFINE_LABEL);
  for (const label of config.pipeline.labels) if (label.blocks) ids.add(label.id);
  return [...ids];
}

/** All the subsets of the labels; above the limit the empty one, the singles, the pairs, all and all but one. */
function labelSets(labels: readonly string[]): string[][] {
  if (labels.length <= EXHAUSTIVE_LABELS) {
    return Array.from({ length: 2 ** labels.length }, (_, mask) =>
      labels.filter((_label, index) => (mask >> index) & 1),
    );
  }
  const pairs = labels.flatMap((a, i) => labels.slice(i + 1).map((b) => [a, b]));
  return [
    [],
    ...labels.map((label) => [label]),
    ...pairs,
    [...labels],
    ...labels.map((l) => labels.filter((x) => x !== l)),
  ];
}

function withLeave(config: SpaceConfig, handle: string): SpaceConfig {
  return {
    ...config,
    team: {
      ...config.team,
      members: config.team.members.map((m) =>
        m.kind === 'ai' && m.handle === handle ? { ...m, onLeave: true } : m,
      ),
    },
  };
}

/** The handles whose step the card waits for, as `cardDuty` reads them. */
function namedHandles(state: CardState, reason: TaskWait['reason'], next: readonly string[]): string[] {
  const { task, config, openItems } = state;
  if (reason === 'held')
    return openItems.filter((item) => isPendingQuestion(item)).flatMap((i) => i.assignees);
  const stage = stageOf(config, task.stageId);
  return reason === 'queued' && next.length === 0 && stage ? stageOwners(config, stage) : [...next];
}

/**
 * The states `cardDuty` may leave unowned (the project manager's), each with why. A state not covered here
 * that falls to `unowned` is a card nobody follows: it fails until somebody adds it here on purpose.
 */
const UNOWNED_ALLOWED: {
  why: string;
  holds(reason: TaskWait['reason'], handles: readonly string[], available: readonly string[]): boolean;
}[] = [
  {
    why: 'a holding label with no open question: nobody was asked for anything',
    holds: (reason, handles) => reason === 'held' && handles.length === 0,
  },
  {
    why: 'nobody can take it on: a step nobody owns, or a label nobody is set to put on',
    holds: (reason, handles) => (reason === 'nobody' || reason === 'queued') && handles.length === 0,
  },
  {
    why: 'several AI candidates: choosing one is arbitrary and all of them is double work (decision 65)',
    holds: (_reason, _handles, available) => available.length >= 2,
  },
  {
    why: 'the only AI member named is on leave',
    holds: (_reason, handles, available) => handles.length > 0 && available.length === 0,
  },
];

/**
 * What is wrong with the way `cardDuty` treats this state, or null: the card has no wait, a `member` is no
 * available AI member, a `person` is no human, or it is `unowned` without a reason listed above.
 */
export function cardStateProblem(state: CardState): string | null {
  const { task, config, openItems } = state;
  const wait = taskWait(state);
  if (!wait) return `${state.description}: no wait`;
  const duty = cardDuty({ task, wait, config, openItems });
  const found = (what: string) => `${state.description}: ${wait.reason} -> ${what}`;
  switch (duty.kind) {
    case 'member': {
      const member = memberOf(config, duty.member);
      return member?.kind === 'ai' && !isOnLeave(member)
        ? null
        : found(`member ${duty.member} is not an available AI member`);
    }
    case 'person':
      return duty.people.length > 0 &&
        duty.people.every((handle) => memberOf(config, handle)?.kind === 'human')
        ? null
        : found('person without a human');
    case 'unowned': {
      const handles = namedHandles(
        state,
        wait.reason,
        wait.next.map((entry) => entry.handle),
      );
      const available = handles.filter((h) => {
        const member = memberOf(config, h);
        return member?.kind === 'ai' && !isOnLeave(member);
      });
      return UNOWNED_ALLOWED.some((entry) => entry.holds(wait.reason, handles, available))
        ? null
        : found('unowned, without a listed reason');
    }
    default:
      return null;
  }
}

export function* cardStateSpace(config: SpaceConfig): Generator<CardState> {
  const { stages } = config.pipeline;
  const person = (
    config.team.members.find((m) => m.kind === 'human' && m.access === 'owner') ??
    config.team.members.find((m) => m.kind === 'human')
  )?.handle;
  const ai = config.team.members.find((m) => m.kind === 'ai' && !isOnLeave(m))?.handle;

  const assignees: { name: string; handle: string | null; config: SpaceConfig }[] = [
    { name: 'no assignee', handle: null, config },
    ...(ai ? [{ name: 'ai', handle: ai, config }] : []),
    ...(person ? [{ name: 'human', handle: person, config }] : []),
    ...(ai ? [{ name: 'ai on leave', handle: ai, config: withLeave(config, ai) }] : []),
  ];
  const openStages = stages.filter((stage) => stage.kind !== 'done');
  const universe = labelUniverse(config);
  const blocking = new Set(config.pipeline.labels.filter((l) => l.blocks).map((l) => l.id));
  const gateLabels = universe.filter((id) => id !== REFINE_LABEL && !blocking.has(id));

  const card = (
    stageId: string,
    status: Task['status'],
    assignee: string | null,
    labels: string[],
  ): Task => ({
    id: 'tsk_space',
    projectKey: 'SP',
    key: 'SP-1',
    title: 'Card',
    description: '',
    stageId,
    status,
    assignee,
    repo: null,
    priority: null,
    labels,
    links: [],
    createdBy: person ?? 'nobody',
    createdAt: THEN,
    updatedAt: SINCE,
    closedAt: null,
  });
  const input = (task: Task, over: Partial<Omit<TaskWaitInput, 'task'>>, description: string): CardState => ({
    task,
    config,
    openItems: [],
    workers: [],
    holders: [],
    openPrerequisites: [],
    viewer: null,
    ...over,
    description,
  });

  // The whole product: stage x status x assignee x labels x a part of an AI member's x an open prerequisite.
  for (const stage of openStages) {
    for (const status of STATUSES) {
      for (const assignee of assignees) {
        for (const labels of labelSets(universe)) {
          for (const part of ai ? [false, true] : [false]) {
            for (const prerequisite of [false, true]) {
              const base = card(stage.id, status, assignee.handle, labels);
              yield input(
                part ? { ...base, parentKey: 'SP-0', createdBy: ai! } : base,
                { config: assignee.config, openPrerequisites: prerequisite ? ['SP-2'] : [] },
                `${stage.id}/${status}/${assignee.name}/[${labels}]${part ? '/part' : ''}${prerequisite ? '/prerequisite' : ''}`,
              );
            }
          }
        }
      }
    }
  }

  // Each of these laid on a smaller base: the stage x status x assignee, with no, all the gate and the refine labels.
  const overlays: { name: string; task?: Partial<Task>; input?: Partial<Omit<TaskWaitInput, 'task'>> }[] = [];
  overlays.push({ name: 'collecting', input: { subtasks: [{ parentKey: 'SP-1', status: 'active' }] } });
  const item = (assignees: string[]) =>
    ({
      id: 'inb_space',
      projectKey: 'SP',
      kind: 'question' as const,
      state: 'open' as const,
      assignees,
      source: ai ?? 'system',
      sessionId: null,
      taskKey: 'SP-1',
      title: 'Question',
      body: null,
      resolution: null,
      payload: {},
      options: [],
      createdAt: SINCE,
    }) satisfies TaskWaitInput['openItems'][number];
  if (ai) {
    overlays.push({
      name: 'ai works',
      input: { workers: [{ handle: ai, since: SINCE, handingOff: false }] },
    });
    overlays.push({ name: 'ai holds', input: { holders: [ai] } });
    overlays.push({
      name: 'ai hands off',
      task: {
        handoff: {
          id: 'hnd_space',
          from: ai,
          to: null,
          fromProvider: 'claude',
          toProvider: null,
          reason: 'manual',
          step: 'waiting_point',
          startedAt: SINCE,
          deadlineAt: null,
        },
      },
      input: { workers: [{ handle: ai, since: SINCE, handingOff: true }] },
    });
    overlays.push({ name: 'question to an ai', input: { openItems: [item([ai])] } });
    overlays.push({ name: 'start offer', task: { startOffer: { to: ai, since: SINCE } } });
  }
  if (person) overlays.push({ name: 'question to a human', input: { openItems: [item([person])] } });
  for (const reason of TaskStartWaiting.shape.reason.options) {
    overlays.push({
      name: `start waiting ${reason}`,
      task: {
        startWaiting: { reason, since: SINCE, ...(ai ? { member: ai } : {}), prerequisites: ['SP-2'] },
      },
    });
  }
  for (const reason of TaskReadyHold.shape.reason.options) {
    overlays.push({ name: `ready hold ${reason}`, task: { readyHold: { reason, since: SINCE } } });
  }
  for (const merger of [ai, person]) {
    if (!merger) continue;
    overlays.push({
      name: `merge by ${merger}`,
      task: {
        merge: {
          id: 'mrg_space',
          repo: 'repo',
          base: 'main',
          toStageId: stages.at(-1)!.id,
          merger,
          requestedAt: SINCE,
          state: 'requested',
          landed: 'nowhere',
        },
      },
    });
  }
  for (const mover of [ai, person]) {
    if (!mover) continue;
    overlays.push({
      name: `hand on by ${mover}`,
      task: {
        handOn: {
          fromStageId: stages[0]!.id,
          toStageId: stages.at(-1)!.id,
          mover,
          requestedBy: mover,
          requestedAt: SINCE,
          inboxItemId: null,
        },
      },
    });
  }
  const limit = {
    rounds: 3,
    limit: 3,
    changeRequests: 3,
    designChangeRequests: 0,
    sendBacks: 0,
    reason: null,
    heldAt: SINCE,
  } as const;
  if (ai) {
    overlays.push({
      name: 'fix limit, lead',
      task: { fixLimit: { ...limit, phase: 'lead', decider: ai, deciders: [] } },
    });
  }
  if (person) {
    overlays.push({
      name: 'fix limit, owner',
      task: { fixLimit: { ...limit, phase: 'owner', decider: null, deciders: [person] } },
    });
  }

  const labelCases = [[], gateLabels, [REFINE_LABEL]];
  for (const overlay of overlays) {
    for (const stage of openStages) {
      for (const status of STATUSES) {
        for (const assignee of assignees) {
          for (const labels of labelCases) {
            const base = card(stage.id, status, assignee.handle, labels);
            yield input(
              { ...base, ...overlay.task },
              { config: assignee.config, ...overlay.input },
              `${overlay.name} on ${stage.id}/${status}/${assignee.name}/[${labels}]`,
            );
          }
        }
      }
    }
  }
}
