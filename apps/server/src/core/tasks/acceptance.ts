import {
  ACCEPTANCE_OPEN_LABEL,
  ACCEPTANCE_UNCONFIRMED_LABEL,
  acceptanceLabels,
  acceptanceRefusal,
  isTheme,
  labelDefinition,
  MAX_ACCEPTANCE_ITEMS,
} from '@projectman/shared';
import type {
  AcceptanceChange,
  AcceptanceItem,
  Actor,
  ProjectConfig,
  Task,
  TimelineEventData,
} from '@projectman/shared';
import { isoNow } from '../base';
import {
  conflict,
  DomainError,
  newId,
  SYSTEM_ACTOR,
  themeRefused,
  withoutIntegratorExecution,
} from '../../kernel';
import type { TaskLabels } from './labels';
import type { TaskRelations } from './relations';
import type { Effect, TaskStore } from './store';

/** One accepted operation: what it did to which item, and the card an item moves to. */
interface AcceptanceStep {
  change: AcceptanceChange;
  item: AcceptanceItem;
  /** `move`: the card that takes the item over. */
  target?: Task;
}

/** The acceptance changes of one update, checked against the card as it will be. */
export interface AcceptancePlan {
  /** The card's items after all the steps. */
  items: AcceptanceItem[];
  steps: AcceptanceStep[];
}

/** The system labels to put on and take off a card to match its items. */
export interface AcceptanceLabelDelta {
  add: string[];
  remove: string[];
}

const eventData = (step: AcceptanceStep): TimelineEventData['acceptance_item_changed'] => ({
  itemId: step.item.id,
  change: step.change.op,
  text: step.item.text,
  state: step.item.state,
  ...(step.target ? { taskKey: step.target.key } : {}),
  ...(step.change.op === 'reopen' && step.change.note ? { note: step.change.note } : {}),
});

/**
 * The acceptance items of cards (PM-1135). The rights and the refusals are the shared ones
 * (`acceptanceRefusal`); this part plans an update's operations against the items as they are (so two
 * operations of one call see each other), writes them with the system labels that follow them, and moves an
 * item to another card. Called inside the unit of work that also writes the rest of the update.
 */
export class TaskAcceptance {
  private readonly store: TaskStore;
  private readonly labels: TaskLabels;
  private readonly relations: TaskRelations;

  constructor(store: TaskStore, labels: TaskLabels, relations: TaskRelations) {
    this.store = store;
    this.labels = labels;
    this.relations = relations;
  }

  /** The items of the card, in order. */
  of(task: Pick<Task, 'id'>): AcceptanceItem[] {
    return this.store.ctx.repos.taskAcceptance.list(task.id);
  }

  /** How many items the steps planned so far move to the card: they count against its limit. */
  private movedTo(steps: readonly AcceptanceStep[], target: Task): number {
    return steps.filter((step) => step.change.op === 'move' && step.target?.key === target.key).length;
  }

  /**
   * Plans `changes` for `task` in order; the first refusal throws and nothing is written. A theme has no
   * acceptance items (`themeRefused`).
   */
  plan(config: ProjectConfig, task: Task, changes: AcceptanceChange[], actor: Actor): AcceptancePlan {
    if (isTheme(task)) throw themeRefused(task.key, 'have acceptance items');
    const now = isoNow(this.store.ctx);
    const items = this.of(task);
    const steps: AcceptanceStep[] = [];
    for (const change of changes) {
      const id = change.op === 'add' ? null : change.itemId;
      const item = id === null ? undefined : items.find((candidate) => candidate.id === id);
      if (change.op !== 'add' && !item)
        throw new DomainError(
          'acceptance_item_not_found',
          `task ${task.key} has no acceptance item ${change.itemId}`,
          { status: 404, details: { itemId: change.itemId } },
        );
      const target = change.op === 'move' ? this.store.ctx.repos.tasks.get(change.taskKey) : null;
      const refusal =
        acceptanceRefusal({ config, task, item, count: items.length, change, actor, target }) ??
        (target && this.of(target).length + this.movedTo(steps, target) >= MAX_ACCEPTANCE_ITEMS
          ? 'move_target'
          : null);
      if (refusal)
        throw conflict(
          'acceptance_item_refused',
          `acceptance item ${item?.id ?? '(new)'} of ${task.key} cannot be changed: ${refusal}`,
          { reason: refusal, itemId: item?.id ?? null },
        );
      const step = this.apply(change, item, items, actor, now, target);
      if (step) steps.push(step);
    }
    return { items, steps };
  }

  /** Applies one operation to the working list; null: it changes nothing (a confirmed item confirmed again). */
  private apply(
    change: AcceptanceChange,
    item: AcceptanceItem | undefined,
    items: AcceptanceItem[],
    actor: Actor,
    now: string,
    target: Task | null,
  ): AcceptanceStep | null {
    const by = actor.handle;
    if (change.op === 'add') {
      const added: AcceptanceItem = {
        id: newId('acc'),
        position: Math.max(-1, ...items.map((other) => other.position)) + 1,
        text: change.text,
        state: 'open',
        evidence: null,
        reason: null,
        movedTo: null,
        origin: null,
        markedBy: null,
        markedAt: null,
        confirmedBy: null,
        confirmedAt: null,
        createdBy: by,
        createdAt: now,
        updatedAt: now,
      };
      items.push(added);
      return { change, item: added };
    }
    const at = items.indexOf(item!);
    const current = item!;
    const marked = (patch: Partial<AcceptanceItem>): AcceptanceItem => ({
      ...current,
      evidence: null,
      reason: null,
      movedTo: null,
      ...patch,
      markedBy: by,
      markedAt: now,
      confirmedBy: null,
      confirmedAt: null,
      updatedAt: now,
    });
    let next: AcceptanceItem;
    switch (change.op) {
      case 'edit':
        next = { ...current, text: change.text, updatedAt: now };
        break;
      case 'remove':
        items.splice(at, 1);
        return { change, item: current };
      case 'done':
        next = marked({ state: 'done', evidence: change.evidence });
        break;
      case 'not_needed':
        next = marked({ state: 'not_needed', reason: change.reason });
        break;
      case 'move':
        next = marked({ state: 'moved', movedTo: change.taskKey });
        break;
      case 'reopen':
        if (current.state === 'open') return null;
        next = {
          ...current,
          state: 'open',
          evidence: null,
          reason: null,
          movedTo: null,
          markedBy: null,
          markedAt: null,
          confirmedBy: null,
          confirmedAt: null,
          updatedAt: now,
        };
        break;
      case 'confirm':
        if (current.confirmedBy !== null) return null;
        next = { ...current, confirmedBy: by, confirmedAt: now, updatedAt: now };
        break;
    }
    items[at] = next;
    return { change, item: next, ...(target ? { target } : {}) };
  }

  /** The system labels the items call for, against the labels the card will have; only those the project defines. */
  labelDelta(
    config: ProjectConfig,
    labels: readonly string[],
    items: readonly AcceptanceItem[],
  ): AcceptanceLabelDelta {
    const wanted = acceptanceLabels(items);
    const delta: AcceptanceLabelDelta = { add: [], remove: [] };
    for (const [id, want] of [
      [ACCEPTANCE_OPEN_LABEL, wanted.open],
      [ACCEPTANCE_UNCONFIRMED_LABEL, wanted.unconfirmed],
    ] as const) {
      if (!labelDefinition(config, id)) continue;
      const has = labels.includes(id);
      if (want && !has) delta.add.push(id);
      else if (!want && has) delta.remove.push(id);
    }
    return delta;
  }

  /** The labels after the delta. */
  static withDelta(labels: readonly string[], delta: AcceptanceLabelDelta): string[] {
    return [...labels.filter((id) => !delta.remove.includes(id)), ...delta.add];
  }

  /** The labels `task` will have once `changes` and its own label change are in: for what runs before the write. */
  labelsAfter(
    config: ProjectConfig,
    task: Task,
    changes: AcceptanceChange[],
    actor: Actor,
    labels: readonly string[],
  ): string[] {
    const plan = this.plan(config, task, changes, actor);
    return TaskAcceptance.withDelta(labels, this.labelDelta(config, labels, plan.items));
  }

  /**
   * Writes a plan for `task` as it stands now (its own label change is already written): the items, the
   * timeline events, the copies on the cards items move to, and the system labels. Returns the card.
   */
  write(
    config: ProjectConfig,
    task: Task,
    plan: AcceptancePlan,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
  ): Task {
    const repo = this.store.ctx.repos.taskAcceptance;
    const stored = new Map(this.of(task).map((item) => [item.id, item]));
    const kept = new Set(plan.items.map((item) => item.id));
    for (const id of stored.keys()) if (!kept.has(id)) repo.remove(id);
    for (const item of plan.items)
      if (JSON.stringify(stored.get(item.id)) !== JSON.stringify(item)) repo.save(task.id, item);
    for (const step of plan.steps) {
      this.store.timeline.append({
        projectKey: task.projectKey,
        taskKey: task.key,
        sessionId,
        actor,
        type: 'acceptance_item_changed',
        data: eventData(step),
      });
      if (step.target) this.moveIn(config, task, step.item, step.target, actor, sessionId, effects);
    }
    return this.syncLabels(config, task, plan.items, effects, sessionId);
  }

  /** Puts the system labels the items call for on `task` (and takes the others off), in the running unit of work. */
  syncLabels(
    config: ProjectConfig,
    task: Task,
    items: readonly AcceptanceItem[],
    effects: Effect[],
    sessionId: string | null = null,
  ): Task {
    const delta = this.labelDelta(config, task.labels, items);
    if (delta.add.length === 0 && delta.remove.length === 0) return task;
    return withoutIntegratorExecution(() =>
      this.labels.apply(config, task, delta, SYSTEM_ACTOR, { reason: 'acceptance', sessionId }, effects),
    );
  }

  /** The items of a new card: open items with the texts given; the card is read after its labels are planned. */
  create(config: ProjectConfig, task: Task, texts: readonly string[], actor: Actor, effects: Effect[]): Task {
    const plan = this.plan(
      config,
      task,
      texts.map((text) => ({ op: 'add' as const, text })),
      actor,
    );
    return this.write(config, task, plan, actor, null, effects);
  }

  /** The item arrives on the card it was moved to as an open one with its origin, related to the first card. */
  private moveIn(
    config: ProjectConfig,
    from: Task,
    item: AcceptanceItem,
    target: Task,
    actor: Actor,
    sessionId: string | null,
    effects: Effect[],
  ): void {
    const repo = this.store.ctx.repos.taskAcceptance;
    const existing = this.of(target);
    // The same item moved to the same card again (reopened in between) is still the one copy.
    if (existing.some((other) => other.origin?.taskKey === from.key && other.origin.itemId === item.id))
      return;
    const now = isoNow(this.store.ctx);
    const copy: AcceptanceItem = {
      id: newId('acc'),
      position: Math.max(-1, ...existing.map((other) => other.position)) + 1,
      text: item.text,
      state: 'open',
      evidence: null,
      reason: null,
      movedTo: null,
      origin: { taskKey: from.key, itemId: item.id },
      markedBy: null,
      markedAt: null,
      confirmedBy: null,
      confirmedAt: null,
      createdBy: actor.handle,
      createdAt: now,
      updatedAt: now,
    };
    repo.save(target.id, copy);
    this.store.timeline.append({
      projectKey: target.projectKey,
      taskKey: target.key,
      sessionId,
      actor,
      type: 'acceptance_item_changed',
      data: { itemId: copy.id, change: 'moved_in', text: copy.text, state: 'open', taskKey: from.key },
    });
    if (!this.relations.of(from).some((relation) => relation.key === target.key)) {
      const plan = this.relations.plan(config, from, { add: [{ kind: 'related', key: target.key }] }, actor);
      this.relations.execute(plan, from, actor, sessionId, effects, []);
    }
    const synced = this.syncLabels(
      config,
      this.store.get(target.projectKey, target.key),
      [...existing, copy],
      effects,
    );
    this.store.publish(synced);
  }
}
