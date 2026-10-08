import {
  duplicateMarkRefusal,
  isCardLink,
  isOpenTask,
  memberOf,
  planRelations,
  RELATION_LINK_KINDS,
  reverseRelationKind,
  stageOf,
  taskRelations,
} from '@projectman/shared';
import type {
  Actor,
  ProjectConfig,
  RelationPlan as SharedRelationPlan,
  RelationRefusal,
  RelationsChange,
  SubtaskParentRefusal,
  Task,
  TaskRelation,
} from '@projectman/shared';
import { hasAccess } from '../access';
import { isoNow } from '../context';
import { forbidden, invalid } from '../errors';
import type { AddedRelation } from '../events';
import type { Effect, TaskStore } from './store';

/** Why a task may not become a subtask: the message of each refusal of the shared rule. */
export const SUBTASK_PARENT_REFUSALS: Record<SubtaskParentRefusal, string> = {
  subtask_self_parent: 'a task cannot be its own parent',
  subtask_parent_not_found: 'the parent task does not exist',
  subtask_parent_project: 'the parent must belong to the same project',
  subtask_parent_is_subtask: 'a subtask cannot have subtasks',
  subtask_has_children: 'a task with subtasks cannot become a subtask',
  subtask_theme: 'a theme is neither the parent nor a subtask: cards belong to a theme through their theme',
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
    case 'subtask_theme':
      return invalid(refusal.code, SUBTASK_PARENT_REFUSALS[refusal.code], details);
    case 'relation_theme':
      return invalid(
        'relation_theme',
        refusal.kind === 'prerequisite'
          ? 'a theme has no prerequisite relations, in either direction'
          : 'a theme can be the duplicate of a theme only, and a card of a card',
        details,
      );
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

/** A validated change of relations: what to write, with nothing written yet (`planRelations`). */
export type RelationPlan = Extract<SharedRelationPlan, { ok: true }>;

/** What the relations need of the task service, which owns the writes they share with other changes. */
export interface RelationDeps {
  /** The task has a session that has not ended, whoever runs it. */
  liveSession: (task: Task) => boolean;
  /** Records a task's change of parent on the timelines of both cards. */
  recordParentChange: (task: Task, previous: string | null, actor: Actor, sessionId: string | null) => void;
  /** Records a card's change of theme on its timeline and on those of the themes it left and joined. */
  recordThemeChange: (
    task: Task,
    previous: string | null,
    themeKey: string | null,
    actor: Actor,
    sessionId: string | null,
  ) => void;
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
    const repo = this.store.ctx.repos.tasks;
    const plan = planRelations({
      task,
      cards: repo.list(task.projectKey),
      elsewhere: (key) => repo.get(key) ?? undefined,
      change,
      markDuplicate: () => this.duplicateRefusal(config, task, actor),
    });
    if (!plan.ok) throw planError(plan, task.key);
    return plan;
  }

  /** Writes a plan: the links and parents, the timelines of both cards, and the close of a duplicate. */
  execute(
    plan: RelationPlan,
    task: Task,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
    added: AddedRelation[],
  ): Task {
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
            [step.ref, reverseRelationKind(step.kind), step.owner],
          ] as const) {
            this.store.timeline.append({
              projectKey: task.projectKey,
              taskKey,
              sessionId,
              actor,
              type,
              data: { kind, ref },
            });
            if (step.type === 'link_add') added.push({ taskKey, kind, ref });
          }
          touched.add(step.owner).add(step.ref);
          // The card may be free of what held its start back (PM-204).
          if (step.type === 'link_remove' && step.kind === 'prerequisite')
            effects.push(() => this.store.ctx.events.emit('task_prerequisite_removed', owner));
          break;
        }
        case 'parent': {
          const child = repo.get(step.child)!;
          const previous = child.parentKey ?? null;
          // A card that becomes a subtask loses the theme it had: it reads its parent's from now on.
          const ownTheme = !previous && step.parent ? (child.themeKey ?? null) : null;
          const written = this.store.write(child, {
            parentKey: step.parent,
            ...(ownTheme ? { themeKey: null } : {}),
            updatedAt: isoNow(this.store.ctx),
          });
          this.deps.recordParentChange(written, previous, actor, sessionId);
          if (step.parent && step.parent !== previous)
            added.push(
              { taskKey: step.child, kind: 'part_of', ref: step.parent },
              { taskKey: step.parent, kind: 'has_part', ref: step.child },
            );
          // What the card shows changes with its parent: the theme of the card it joins, or none (its own,
          // which it had before it became a subtask, is gone) when it leaves. The timelines say so.
          const shown = child.themeKey ?? null;
          const shownNow = repo.get(step.child)?.themeKey ?? null;
          if (shown !== shownNow) {
            this.deps.recordThemeChange(written, shown, shownNow, actor, sessionId);
            if (shown) touched.add(shown);
            if (shownNow) touched.add(shownNow);
          }
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
  private duplicateRefusal(config: ProjectConfig, task: Task, actor: Actor): 'duplicate_not_allowed' | null {
    const member = actor.kind === 'human' ? memberOf(config, actor.handle) : undefined;
    return duplicateMarkRefusal({
      task,
      stageKind: stageOf(config, task.stageId)?.kind,
      hasLiveSession: this.deps.liveSession(task),
      mayCancel: member?.kind === 'human' && hasAccess(member.access, 'admin'),
    });
  }
}

/** The error of a refused plan. */
function planError(plan: Extract<SharedRelationPlan, { ok: false }>, taskKey: string) {
  const { refusal, key } = plan;
  if (refusal.code === 'duplicate_not_allowed')
    return forbidden(
      'duplicate_not_allowed',
      `${taskKey} has started, and marking it as a duplicate closes it: only an admin or the owner can mark a card that has started`,
    );
  if (refusal.code === 'relation_not_found')
    return invalid('relation_not_found', `${taskKey} has no ${refusal.kind} relation with ${key}`, {
      kind: refusal.kind,
      key,
    });
  return refusalError(refusal, key);
}
