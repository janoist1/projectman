import {
  duplicateMarkRefusal,
  hasRelated,
  isCardLink,
  isOpenTask,
  memberOf,
  relationRefusal,
  RELATION_LINK_KINDS,
  stageOf,
  storedRelation,
  taskRelations,
} from '@projectman/shared';
import type {
  Actor,
  AddRelationRef,
  ProjectConfig,
  RelationCard,
  RelationLinkKind,
  RelationRefusal,
  RelationsChange,
  SubtaskParentRefusal,
  Task,
  TaskRelation,
  TaskRelationKind,
} from '@projectman/shared';
import { hasAccess } from '../access';
import { isoNow } from '../context';
import { forbidden, invalid } from '../errors';
import type { Effect, TaskStore } from './store';

/** Why a task may not become a subtask: the message of each refusal of the shared rule. */
export const SUBTASK_PARENT_REFUSALS: Record<SubtaskParentRefusal, string> = {
  subtask_self_parent: 'a task cannot be its own parent',
  subtask_parent_not_found: 'the parent task does not exist',
  subtask_parent_project: 'the parent must belong to the same project',
  subtask_parent_is_subtask: 'a subtask cannot have subtasks',
  subtask_has_children: 'a task with subtasks cannot become a subtask',
};

/** The error of a refused relation, in words that say what to do instead. */
function refusalError(refusal: RelationRefusal, key: string) {
  const details = { key, ...refusal };
  switch (refusal.code) {
    case 'subtask_self_parent':
    case 'subtask_parent_not_found':
    case 'subtask_parent_project':
    case 'subtask_parent_is_subtask':
    case 'subtask_has_children':
      return invalid(refusal.code, SUBTASK_PARENT_REFUSALS[refusal.code], details);
    case 'relation_self':
      return invalid('relation_self', 'a card cannot be related to itself', details);
    case 'relation_target_not_found':
      return invalid('relation_target_not_found', `the card ${key} does not exist`, details);
    case 'relation_target_project':
      return invalid(
        'relation_target_project',
        `the card ${key} belongs to another project: cards relate only within a project`,
        details,
      );
    case 'relation_cycle':
      return invalid(
        'relation_cycle',
        `that would make a loop of prerequisites: ${(refusal.path ?? []).join(' needs ')}`,
        details,
      );
    case 'relation_duplicate_of_duplicate':
      return invalid(
        'relation_duplicate_of_duplicate',
        `the card ${key} is a duplicate itself: point at its original, ${refusal.original}`,
        details,
      );
    case 'relation_parent_exists':
      return invalid(
        'relation_parent_exists',
        `the card is part of ${refusal.parent} already: remove that relation first (the same call may do both)`,
        details,
      );
  }
}

/** The card as it is while the change is planned: what the relation rules read, changed step by step. */
interface WorkingCard extends RelationCard {
  id: string;
}

type RelationStep =
  | { type: 'link_add'; owner: string; kind: RelationLinkKind; ref: string }
  | { type: 'link_remove'; owner: string; kind: RelationLinkKind; ref: string }
  | { type: 'parent'; child: string; parent: string | null }
  | { type: 'duplicate_close'; original: string };

/** A validated change of relations: what to write, with nothing written yet. */
export interface RelationPlan {
  steps: RelationStep[];
  /** The change closes the task: it is marked as a duplicate while it is open. */
  closes: boolean;
}

/** The view kind of a stored link on the card it points at. */
const REVERSE_KIND: Record<RelationLinkKind, TaskRelationKind> = {
  prerequisite: 'prerequisite_of',
  related: 'related',
  duplicate_of: 'duplicated_by',
};

/** What the relations need of the task service, which owns the writes they share with other changes. */
export interface RelationDeps {
  /** The task has a session that has not ended, whoever runs it. */
  liveSession: (task: Task) => boolean;
  /** Records a task's change of parent on the timelines of both cards. */
  recordParentChange: (task: Task, previous: string | null, actor: Actor, sessionId: string | null) => void;
  /** Cancels an open task as a duplicate, like any cancellation; returns it as written. */
  cancel: (
    task: Task,
    actor: Actor,
    duplicate: { reason: string; duplicateOf: string },
    sessionId: string | null,
    effects: Effect[],
  ) => Task;
}

/**
 * Changes of the relations between cards (PM-192). The rules are the shared ones
 * (`relationRefusal`, `duplicateMarkRefusal`); this part reads the project's cards as they are now,
 * plans the whole change against them step by step (so two steps of one call can contradict each
 * other, and the second is refused), and writes it. Called inside the unit of work that also writes
 * the rest of the change, so a refusal anywhere leaves nothing behind.
 */
export class TaskRelations {
  private readonly store: TaskStore;
  private readonly deps: RelationDeps;

  constructor(store: TaskStore, deps: RelationDeps) {
    this.store = store;
    this.deps = deps;
  }

  /** The relations of a task, both directions, with the title, stage and status of the other card. */
  of(task: Task): TaskRelation[] {
    const repo = this.store.ctx.repos.tasks;
    const cards = new Map<string, Task>();
    const keep = (card: Task | null | undefined) => card && cards.set(card.key, card);
    keep(task.parentKey ? repo.get(task.parentKey) : null);
    for (const card of repo.children(task.projectKey, task.key)) keep(card);
    for (const link of task.links) if (isCardLink(link)) keep(repo.get(link.ref));
    for (const card of repo.linking(task.projectKey, RELATION_LINK_KINDS, task.key)) keep(card);
    return taskRelations(task, [task, ...cards.values()]);
  }

  /**
   * Plans `change` for `task`: removals first, then additions. Refuses what the rules refuse, and what
   * the actor may not do: marking a card that has started as a duplicate closes it, which only
   * whoever may cancel it can do.
   */
  plan(config: ProjectConfig, task: Task, change: RelationsChange, actor: Actor): RelationPlan {
    const { projectKey } = task;
    const cards = new Map<string, WorkingCard>();
    for (const card of this.store.ctx.repos.tasks.list(projectKey))
      cards.set(card.key, { ...card, links: [...card.links] });
    const self = cards.get(task.key);
    if (!self) throw invalid('relation_target_not_found', `the card ${task.key} does not exist`);
    const steps: RelationStep[] = [];

    for (const { kind, key } of change.remove ?? []) {
      const stored = storedRelation(kind, self, cards.get(key));
      if (!stored)
        throw invalid('relation_not_found', `${task.key} has no ${kind} relation with ${key}`, { kind, key });
      const owner = cards.get(stored.owner)!;
      if (stored.stored === 'parent') {
        owner.parentKey = null;
        steps.push({ type: 'parent', child: owner.key, parent: null });
      } else {
        owner.links = owner.links.filter((l) => !(l.kind === stored.stored && l.ref === stored.target));
        steps.push({ type: 'link_remove', owner: owner.key, kind: stored.stored, ref: stored.target });
      }
    }

    for (const { kind, key } of unique(change.add ?? [])) {
      // A card of another project is not in the project's cards: read it, so that the refusal says why.
      if (!cards.has(key)) {
        const elsewhere = this.store.ctx.repos.tasks.get(key);
        if (elsewhere) cards.set(key, { ...elsewhere, links: [...elsewhere.links] });
      }
      const target = cards.get(key);
      if (kind === 'part_of' ? self.parentKey === key : !!target && isStored(kind, self, target)) continue;
      const refusal = relationRefusal(kind, { key: task.key, projectKey }, key, [...cards.values()]);
      if (refusal) throw refusalError(refusal, key);
      if (kind === 'part_of') {
        self.parentKey = key;
        steps.push({ type: 'parent', child: task.key, parent: key });
        continue;
      }
      self.links.push({ kind, ref: key });
      steps.push({ type: 'link_add', owner: task.key, kind, ref: key });
      if (kind === 'duplicate_of' && !steps.some((s) => s.type === 'duplicate_close')) {
        this.requireMayMarkDuplicate(config, task, actor);
        steps.push({ type: 'duplicate_close', original: key });
      }
    }
    return { steps, closes: isOpenTask(task) && steps.some((s) => s.type === 'duplicate_close') };
  }

  /** Writes a plan: the links and parents, the timelines of both cards, and the close of a duplicate. */
  execute(plan: RelationPlan, task: Task, actor: Actor, sessionId: string | null, effects: Effect[]): Task {
    const repo = this.store.ctx.repos.tasks;
    const touched = new Set<string>();
    for (const step of plan.steps) {
      switch (step.type) {
        case 'link_add':
        case 'link_remove': {
          const owner = repo.get(step.owner)!;
          if (step.type === 'link_add')
            repo.upsertLink(owner.id, { kind: step.kind, ref: step.ref }, isoNow(this.store.ctx));
          else repo.removeLink(owner.id, step.kind, step.ref);
          const type = step.type === 'link_add' ? 'task_relation_added' : 'task_relation_removed';
          // Each card says it from its own side: the owner "needs", the other card "is needed by".
          for (const [taskKey, kind, ref] of [
            [step.owner, step.kind, step.ref],
            [step.ref, REVERSE_KIND[step.kind], step.owner],
          ] as const)
            this.store.timeline.append({
              projectKey: task.projectKey,
              taskKey,
              sessionId,
              actor,
              type,
              data: { kind, ref },
            });
          touched.add(step.owner).add(step.ref);
          break;
        }
        case 'parent': {
          const child = repo.get(step.child)!;
          const previous = child.parentKey ?? null;
          const written = this.store.write(child, {
            parentKey: step.parent,
            updatedAt: isoNow(this.store.ctx),
          });
          this.deps.recordParentChange(written, previous, actor, sessionId);
          touched.add(step.child);
          if (previous) touched.add(previous);
          if (step.parent) touched.add(step.parent);
          break;
        }
        case 'duplicate_close': {
          const current = this.store.get(task.projectKey, task.key);
          // A closed card only gets the relation; it is not opened again, nor closed twice.
          if (isOpenTask(current)) {
            this.deps.cancel(
              current,
              actor,
              { reason: `duplicate of ${step.original}`, duplicateOf: step.original },
              sessionId,
              effects,
            );
            touched.add(task.key);
          }
          break;
        }
      }
    }
    for (const key of touched) {
      const card = repo.get(key);
      if (card) this.store.publish(card);
    }
    return this.store.get(task.projectKey, task.key);
  }

  /** The duplicate mark closes the card: a card that has started needs whoever may cancel it. */
  private requireMayMarkDuplicate(config: ProjectConfig, task: Task, actor: Actor): void {
    const member = actor.kind === 'human' ? memberOf(config, actor.handle) : undefined;
    const refusal = duplicateMarkRefusal({
      task,
      stageKind: stageOf(config, task.stageId)?.kind,
      hasLiveSession: this.deps.liveSession(task),
      mayCancel: member?.kind === 'human' && hasAccess(member.access, 'admin'),
    });
    if (refusal)
      throw forbidden(
        refusal,
        `${task.key} has started, and marking it as a duplicate closes it: only an admin or the owner can mark a card that has started`,
      );
  }
}

function unique(relations: readonly AddRelationRef[]): AddRelationRef[] {
  const seen = new Set<string>();
  return relations.filter(({ kind, key }) => !seen.has(`${kind}:${key}`) && !!seen.add(`${kind}:${key}`));
}

/** The relation of a forward kind is stored between the two cards already (a related pair on either). */
function isStored(
  kind: Exclude<AddRelationRef['kind'], 'part_of'>,
  from: WorkingCard,
  to: WorkingCard,
): boolean {
  return kind === 'related'
    ? hasRelated(from, to)
    : from.links.some((l) => l.kind === kind && l.ref === to.key);
}
