import { z } from 'zod';
import { isPendingQuestion } from '../domain/inbox';
import type { InboxItem } from '../domain/inbox';
import type { TaskReadyHold } from '../domain/ready-hold';
import type { Task, TaskStartWaiting } from '../domain/task';
import { stageOwners } from './duties';
import { stageAdvance } from './gates';
import { isOnLeave } from './leave';
import { memberOf, ownerHandles, stageOf } from './lookup';
import type { ProjectConfig } from './schema';
import type { TaskWait, TaskWaitReason } from './task-wait';

/**
 * Whose step a standing open card waits for (PM-1224): one rule that puts every open card into exactly
 * one class, so that a card that stands still always has an owner, or a stated reason why it may.
 * Built on `taskWait` (which names who acts next) and a pure function, like it: everything it needs is
 * passed in. It changes no behavior by itself; the obligation ladder reads it.
 */

/** Why a card legitimately waits with nobody acting now: a closed list, each with its own way back. */
export const CardHoldCode = z.enum([
  'backlog',
  'prerequisite',
  'paused',
  'limit',
  'capacity',
  'engine',
  'full_test',
  'handoff',
  'dependencies',
  /** A collecting card waits for its open parts, in the ready and in a work stage: each part has its own step (PM-1234, PM-1240). */
  'parts',
]);
export type CardHoldCode = z.infer<typeof CardHoldCode>;

type DutyBody =
  | { kind: 'active'; members: string[] }
  /** One AI member's step. */
  | { kind: 'member'; member: string }
  /** A person's step: a legitimate wait. */
  | { kind: 'person'; people: string[] }
  /** A legitimate wait, nobody acts now. */
  | { kind: 'hold'; code: CardHoldCode }
  | { kind: 'system'; step: 'refinement' | 'advance' | 'start' | 'start_retry' }
  /** Nobody can be named: the project manager's. */
  | { kind: 'unowned' };

export type CardDuty = { reason: TaskWaitReason } & DutyBody;

export interface CardDutyInput {
  task: Task;
  wait: TaskWait;
  config: Pick<ProjectConfig, 'team' | 'pipeline'>;
  /** The card's open inbox items, any assignee. */
  openItems: readonly InboxItem[];
  /** How many open parts (subtasks) the card has; a card with open parts is a collecting card. */
  openParts: number;
}

type DutyConfig = Pick<ProjectConfig, 'team' | 'pipeline'>;

/** How a start-waiting reason is classified. A new reason does not compile until it is listed here. */
type StartClass =
  { via: 'next' } | { via: 'people' } | { via: 'retry' } | { via: 'hold'; code: CardHoldCode };

const START_WAITING_CLASS: Record<TaskStartWaiting['reason'], StartClass> = {
  label_missing: { via: 'next' },
  waiting_answer: { via: 'people' },
  repo_required: { via: 'people' },
  member_on_leave: { via: 'people' },
  provider_not_logged_in: { via: 'people' },
  nanogpt_key_missing: { via: 'people' },
  nanogpt_setup_incomplete: { via: 'people' },
  codex_setup_incomplete: { via: 'people' },
  workspace_codex_config: { via: 'people' },
  workspace_busy: { via: 'retry' },
  workspace_dirty: { via: 'retry' },
  workspace_fetch_failed: { via: 'retry' },
  workspace_dependencies_failed: { via: 'retry' },
  prerequisite_open: { via: 'hold', code: 'prerequisite' },
  team_paused: { via: 'hold', code: 'paused' },
  ai_disabled: { via: 'hold', code: 'paused' },
  ai_limit_reached: { via: 'hold', code: 'limit' },
  plan_usage_paused: { via: 'hold', code: 'limit' },
  provider_rate_limited: { via: 'hold', code: 'limit' },
  disk_low: { via: 'hold', code: 'limit' },
  machine_busy: { via: 'hold', code: 'limit' },
  member_at_capacity: { via: 'hold', code: 'capacity' },
  no_free_member: { via: 'hold', code: 'capacity' },
  senior_busy: { via: 'hold', code: 'capacity' },
  engine_offline: { via: 'hold', code: 'engine' },
  start_backoff: { via: 'retry' },
  start_failing: { via: 'people' },
  full_test_pending: { via: 'hold', code: 'full_test' },
  handoff_open: { via: 'hold', code: 'handoff' },
  workspace_dependencies_pending: { via: 'hold', code: 'dependencies' },
};

/** The hold an intentionally held ready card stands for. */
const READY_HOLD_CODE: Record<TaskReadyHold['reason'], CardHoldCode> = {
  ai_disabled: 'paused',
  team_paused: 'paused',
  ai_limit_reached: 'limit',
  engine_offline: 'engine',
  no_free_member: 'capacity',
  senior_busy: 'capacity',
};

/** An AI member that exists and is not on leave: the only kind a step may be given to. */
function availableAi(config: DutyConfig, handle: string | null | undefined): string | null {
  const member = memberOf(config, handle);
  return member?.kind === 'ai' && !isOnLeave(member) ? member.handle : null;
}

function humansOf(config: DutyConfig, handles: readonly string[]): string[] {
  return [...new Set(handles)].filter((handle) => memberOf(config, handle)?.kind === 'human');
}

/**
 * The step of whoever the handles name: a person when any of them is one, the member when exactly one is
 * an available AI member, otherwise nobody (none, several candidates, or only members on leave).
 */
function byHandles(config: DutyConfig, handles: readonly string[]): DutyBody {
  const people = humansOf(config, handles);
  if (people.length > 0) return { kind: 'person', people };
  const candidates = [...new Set(handles.flatMap((handle) => availableAi(config, handle) ?? []))];
  return candidates.length === 1 ? { kind: 'member', member: candidates[0]! } : { kind: 'unowned' };
}

/** A person's step with no named person: the given ones, else the owners, else any human. */
function peopleDuty(config: DutyConfig, preferred: readonly string[] = []): DutyBody {
  for (const handles of [preferred, ownerHandles(config), config.team.members.map((m) => m.handle)]) {
    const people = humansOf(config, handles);
    if (people.length > 0) return { kind: 'person', people };
  }
  return { kind: 'unowned' };
}

/** The first stage: the pipeline's first queue, where unworked-out cards wait on the owner (decision 57). */
function inFirstStage(task: Pick<Task, 'stageId'>, config: Pick<ProjectConfig, 'pipeline'>): boolean {
  return config.pipeline.stages.find((stage) => stage.kind === 'queue')?.id === task.stageId;
}

/**
 * Whose step the open card waits for, or why it may wait. Each `TaskWaitReason` is classified; the start
 * and ready hold reasons by the tables above, so a new reason does not compile unclassified.
 */
export function cardDuty({ task, wait, config, openItems, openParts }: CardDutyInput): CardDuty {
  const reason = wait.reason;
  const next = wait.next.map((entry) => entry.handle);
  const firstStage = inFirstStage(task, config);
  const classified = (duty: DutyBody): CardDuty => ({ reason, ...duty });
  const hold = (code: CardHoldCode) => classified({ kind: 'hold', code });

  switch (reason) {
    case 'working':
    case 'handing_off':
      return classified({ kind: 'active', members: next });
    case 'start_waiting': {
      if (!wait.startWaiting) return classified({ kind: 'unowned' });
      const how = START_WAITING_CLASS[wait.startWaiting.reason];
      switch (how.via) {
        case 'next':
          return classified(byHandles(config, next));
        case 'people':
          return classified(peopleDuty(config));
        case 'retry':
          return classified({ kind: 'system', step: 'start_retry' });
        case 'hold':
          return hold(how.code);
        default:
          return how satisfies never;
      }
    }
    case 'prerequisite':
      return hold('prerequisite');
    case 'inbox':
    case 'fix_limit':
    case 'merge':
    case 'hand_on':
    case 'assignee':
      return classified(byHandles(config, next));
    case 'blocked':
    case 'approval':
      return classified(peopleDuty(config, next));
    case 'held': {
      const asked = openItems.filter((item) => isPendingQuestion(item)).flatMap((item) => item.assignees);
      return classified(asked.length > 0 ? byHandles(config, asked) : { kind: 'unowned' });
    }
    case 'labels_missing':
      return firstStage ? hold('backlog') : classified(byHandles(config, next));
    case 'part_left': {
      const creator = availableAi(config, next[0]);
      return classified(creator ? { kind: 'member', member: creator } : { kind: 'unowned' });
    }
    case 'refinement': {
      const duty = byHandles(config, next);
      return classified(duty.kind === 'unowned' ? { kind: 'system', step: 'refinement' } : duty);
    }
    case 'ready': {
      if (firstStage) return hold('backlog');
      // The automatic start never starts a collecting card: its parts are started, each by its own step.
      if (openParts > 0) return hold('parts');
      const readyHold = wait.hold ?? task.readyHold;
      if (readyHold) return hold(READY_HOLD_CODE[readyHold.reason]);
      if (task.startOffer) return classified(byHandles(config, [task.startOffer.to]));
      return classified({ kind: 'system', step: 'start' });
    }
    case 'queued':
    case 'nobody': {
      if (stageAdvance(task, config)?.kind === 'move') return classified({ kind: 'system', step: 'advance' });
      // A collecting card in a work stage has no step of its own: it closes with its parts (PM-1240).
      if (openParts > 0) return hold('parts');
      // An idle stage waits for its owners when `next` names nobody (a step no session holds yet).
      const stage = stageOf(config, task.stageId);
      const owners = reason === 'queued' && next.length === 0 && stage ? stageOwners(config, stage) : next;
      return classified(byHandles(config, owners));
    }
    default:
      return reason satisfies never;
  }
}
