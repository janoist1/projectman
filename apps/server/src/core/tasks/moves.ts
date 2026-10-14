import {
  actorMoveRefusal,
  boardColumnOf,
  evaluateMove,
  fixLimitDecisionOf,
  gateRequestOf,
  cardMoverHandle,
  handOnDecision,
  handOnRequestOf,
  memberOf,
  mergeRepoOf,
  moveMerge,
  partsClosedWaiver,
  isOpenTask,
  isTheme,
  noApproverReason,
  stageHandsOverForReview,
  stageIndex,
  stageOf,
} from '@projectman/shared';
import type {
  Actor,
  ApprovalRequirement,
  BoardPlacement,
  GateEvaluation,
  GateRequestPayload,
  InboxItem,
  PartsClosed,
  ProjectConfig,
  RepoConfig,
  Stage,
  StagePull,
  StartBlock,
  Task,
  TaskHandOn,
  TimelineEventData,
} from '@projectman/shared';
import type { SourceHead } from '../../contracts';
import type { TaskPatch } from '../../db';
import { isoNow } from '../base';
import { requireHuman } from '../members';
import { conflict, DomainError, projectManagerMoveRefused, themeRefused } from '../../kernel';
import { DECISION_OPTIONS } from '../inbox';
import type { InboxService } from '../inbox';
import { actorHandle, humanActor, newId, SYSTEM_ACTOR, unique } from '../../kernel';
import type { BoardOrder } from './board-order';
import type { TaskLabels } from './labels';
import { requireStage, runEffects } from './store';
import type { Effect, TaskStore } from './store';

/**
 * What a stage move asks the module that merges a card's work (PM-591). The rule (which move needs a
 * merge and when it is checked: moveMerge, mergeRepoOf) stays with the move; the gate answers the facts.
 */
export interface MergeGate {
  /** Before the unit of work, when moveMerge is 'due': resolves when the approved commit is on the base branch, else throws `task_not_merged` (or `handover_uncommitted`). */
  checkGate(config: ProjectConfig, task: Task, targetId: string): Promise<void>;
  /** The `task_not_merged` refusal of a merge-requiring move that was not checked before its unit of work. */
  notMergedError(config: ProjectConfig, task: Task, repo: RepoConfig, reason: 'not_merged'): DomainError;
  /** After an approved move waits for the merge: opens or refreshes the card's merge request. */
  reconcile(projectKey: string, taskKey: string): Promise<void>;
  /** Who merges the card (the approval request's `merge.merger`); null: nobody can. */
  mergerOf(config: ProjectConfig, task: Task): string | null;
  /** Inside the unit of work that moves or cancels the card: cancels its open merge; work after the commit goes to `effects`. */
  cancel(projectKey: string, taskKey: string, effects: Effect[]): void;
}

export interface MoveResult {
  task: Task;
  moved: boolean;
  /** Decision items waiting for approvers when the target stage needs a human approval. */
  pendingApproval: InboxItem[];
  /** The other cards of the target column whose rank was written (PM-118); the moved card's is on `task`. */
  reranked?: string[];
  handOn?: TaskHandOn;
}

/** Where a moved card goes in its new column, and (filled in) which other cards had to be renumbered. */
interface BoardPlace {
  placement?: BoardPlacement | undefined;
  reranked: string[];
}

export interface StageChange {
  task: Task;
  from: string;
  to: string;
  actor: Actor;
  eventId?: string;
  /**
   * A person moved the card after the warning that a prerequisite is open (PM-204): the work start
   * the move makes does not wait for the prerequisites.
   */
  despitePrerequisites?: boolean;
}

/** The head of the developer's branch, read before a move that hands the task over for review or testing. */
export interface Handover {
  head: SourceHead;
}

/** What `prepareMove` read before the unit of work. */
export interface PreparedMove {
  handover: Handover | null;
  /** The merge check ran and let the move through (PM-484). */
  mergeChecked: boolean;
}

/** What a move may carry besides its target (PM-183). */
export interface MoveOptions {
  /** An automatic move is valid only during the stage stay that selected its target. */
  expectedFrom?: Pick<Task, 'stageId' | 'stageEnteredAt'>;
  /** Read by `prepareMove` before the unit of work; the move records the pin. */
  handover?: Handover | null;
  /** `prepareMove` checked the merge and let the move through; without it a move that needs a merge is refused. */
  mergeChecked?: boolean;
  /** The system sends the task back because its branch moved after the hand-over. */
  branchMoved?: NonNullable<TimelineEventData['task_stage_changed']['branchMoved']>;
  /** The system sends the task back because the server's full test of the pinned commit failed (PM-217). */
  testsFailed?: NonNullable<TimelineEventData['task_stage_changed']['testsFailed']>;
  /** The system pulls the card into the stage ahead of its turn (PM-427); recorded on the stage change. */
  pulled?: StagePull;
  /** A person's move despite open prerequisites (PM-204); carried to the `task_stage_changed` event. */
  despitePrerequisites?: boolean;
  /** The system closes a collecting card with its parts (PM-647): the move is valid only while the waiver holds, and never falls back to the gates. */
  partsClosed?: true;
  /**
   * Where the card goes in the target column when it is dropped on the board (PM-118). Without it a card
   * that enters another column takes the top of that column; one that stays in its column keeps its place.
   */
  placement?: BoardPlacement;
}

/** Reads the head of the branch a task's developer hands over, null when there is none to read. */
export type SourceHeadReader = (
  config: ProjectConfig,
  task: Task,
  opts?: { strict?: boolean },
) => Promise<SourceHead | null>;

export function gateBlockedError(evaluation: GateEvaluation, block?: StartBlock) {
  return conflict('gate_blocked', 'the gate conditions of the target stage are not met', {
    unmet: evaluation.unmet,
    approvals: evaluation.approvals,
    ...(block ? { block } : {}),
  });
}

export function approvalRequestedError(items: InboxItem[]) {
  return conflict(
    'approval_requested',
    'a human approval was requested; the task moves once it is approved',
    {
      inboxItemIds: items.map((i) => i.id),
      approvers: unique(items.flatMap((i) => i.assignees)),
    },
  );
}

/**
 * Stage moves: gates, approval requests in the inbox and the approvers' decisions. Moving a
 * task back takes off the labels that expire then; every move is a `task_stage_changed` domain
 * event once it is committed.
 */
export class TaskMoves {
  private mergeGate: MergeGate | undefined;
  /** A later registration replaces the earlier one (PM-591). */
  registerMergeGate(gate: MergeGate): void {
    this.mergeGate = gate;
  }
  cancelMerge(projectKey: string, taskKey: string, effects: Effect[]): void {
    this.mergeGate?.cancel(projectKey, taskKey, effects);
  }
  private readonly store: TaskStore;
  private readonly labels: TaskLabels;
  private readonly inbox: InboxService;
  private readonly sourceHead: SourceHeadReader;
  private readonly order: BoardOrder;
  private readonly notifyHandOn: (config: ProjectConfig, task: Task, handOn: TaskHandOn) => Promise<void>;

  constructor(deps: {
    store: TaskStore;
    labels: TaskLabels;
    inbox: InboxService;
    sourceHead: SourceHeadReader;
    order: BoardOrder;
    notifyHandOn: (config: ProjectConfig, task: Task, handOn: TaskHandOn) => Promise<void>;
  }) {
    this.order = deps.order;
    this.notifyHandOn = deps.notifyHandOn;
    this.store = deps.store;
    this.labels = deps.labels;
    this.inbox = deps.inbox;
    this.sourceHead = deps.sourceHead;
    this.inbox.registerDecider('hand_on', async (item, by) => {
      const request = handOnRequestOf(item)!;
      const config = await this.store.projects.config(item.projectKey);
      const actor = humanActor(by.handle);
      requireHuman(config, actor, 'developer');
      const { handover, mergeChecked } = await this.prepareMove(
        config,
        this.store.get(item.projectKey, request.taskKey),
        request.toStageId,
      );
      const effects: Effect[] = [];
      this.store.ctx.unitOfWork(() => {
        const task = this.store.get(item.projectKey, request.taskKey);
        if (
          task.handOn?.inboxItemId !== item.id ||
          task.stageId !== request.fromStageId ||
          this.inbox.get(item.projectKey, item.id).state !== 'open'
        )
          throw conflict('inbox_item_closed', 'the hand-on request is no longer current');
        const evaluation = this.partsClosedOf(config, task, request.toStageId)
          ? { unmet: [], approvals: [] }
          : evaluateMove(task, config, task.stageId, request.toStageId);
        if (evaluation.unmet.length || evaluation.approvals.length) throw gateBlockedError(evaluation);
        this.move(config, task, request.toStageId, actor, effects, { handover, mergeChecked });
      });
      await runEffects(effects);
    });
  }

  /**
   * Moves a task to a stage if the gates allow it. Unmet conditions throw `gate_blocked`;
   * human approvals create `decision` inbox items for the approvers and the task moves only
   * once they approve (an AI member can never resolve inbox items). Entering a review or test
   * stage hands the branch over: see `prepareMove`.
   */
  async moveToStage(
    projectKey: string,
    taskKey: string,
    stageId: string,
    actor: Actor,
    opts: Pick<MoveOptions, 'branchMoved' | 'testsFailed' | 'expectedFrom' | 'pulled' | 'partsClosed'> = {},
  ): Promise<MoveResult> {
    const config = await this.store.projects.config(projectKey);
    const prepared = await this.prepareMove(config, this.store.get(projectKey, taskKey), stageId);
    const effects: Effect[] = [];
    const result = this.store.ctx.unitOfWork(() =>
      this.move(config, this.store.get(projectKey, taskKey), stageId, actor, effects, {
        ...opts,
        ...prepared,
      }),
    );
    await runEffects(effects);
    return result;
  }

  /**
   * What a move needs read before the unit of work. The merge check (`task_not_merged`, PM-452) runs
   * only when `moveMerge` says it is due, i.e. the move's gates hold; `mergeChecked` then says it passed,
   * and `move` refuses a merge-requiring move that was not checked. The hand-over of a move into a
   * review or test stage (PM-183) is the head of the developer's branch: uncommitted work in the
   * developer's working directory refuses the move (`handover_uncommitted`), whoever moves it, because
   * reviewers only ever see committed work. The hand-over is null for any other move, and for a task
   * without a repository or a branch.
   */
  async prepareMove(config: ProjectConfig, task: Task, stageId: string): Promise<PreparedMove> {
    const target = stageOf(config, stageId);
    if (!target || task.stageId === target.id || task.status === 'cancelled' || isTheme(task))
      return { handover: null, mergeChecked: false };
    // The merge is checked only when the move's own gates hold (PM-484): a merge that waits for a gate
    // of the move (a missing approval) would otherwise keep the gate from ever being asked.
    // A move without the gates (PM-647) has no gate left to wait for, so its merge is checked at once.
    const waived = this.partsClosedOf(config, task, target.id) !== null;
    let mergeChecked = false;
    if (
      this.mergeGate &&
      (waived
        ? mergeRepoOf(config, task, task.stageId, target.id) !== null
        : moveMerge(config, task, task.stageId, target.id).kind === 'due')
    ) {
      await this.mergeGate.checkGate(config, task, target.id);
      mergeChecked = true;
    }
    return { handover: await this.readHandover(config, task, target), mergeChecked };
  }

  /** The waiver of a move into the done stage (PM-647), from the card's subtasks as they stand now. */
  private partsClosedOf(config: ProjectConfig, task: Task, targetId: string): PartsClosed | null {
    return partsClosedWaiver(
      config,
      task,
      this.store.ctx.repos.tasks.children(task.projectKey, task.key),
      targetId,
    );
  }

  private async readHandover(config: ProjectConfig, task: Task, target: Stage): Promise<Handover | null> {
    if (!stageHandsOverForReview(config, target)) return null;
    const head = await this.sourceHead(config, task);
    if (!head) return null;
    if (head.dirty)
      throw conflict(
        'handover_uncommitted',
        `task ${task.key} cannot enter ${target.name}: ${head.path} has ${head.changes} uncommitted ${head.changes === 1 ? 'change' : 'changes'} on ${head.branch}; commit them (reviewers only see committed work) and move the task again`,
        {
          taskKey: task.key,
          stageId: target.id,
          path: head.path,
          branch: head.branch,
          changes: head.changes,
        },
      );
    return { head };
  }

  /**
   * A new review round of the developer's asking (PM-138) pins the branch head anew: the task
   * stays where it is. Does nothing unless the task is in the stage of its pin and the head moved.
   */
  async repin(projectKey: string, taskKey: string, by: string): Promise<void> {
    const config = await this.store.projects.config(projectKey);
    const task = this.store.get(projectKey, taskKey);
    const pin = this.store.ctx.repos.reviewPins.get(task.key);
    if (!pin || pin.stageId !== task.stageId || !isOpenTask(task)) return;
    const head = await this.sourceHead(config, task);
    if (!head || head.commit === pin.commit) return;
    this.store.ctx.unitOfWork(() => {
      const current = this.store.get(projectKey, taskKey);
      if (current.stageId !== pin.stageId) return;
      const at = isoNow(this.store.ctx);
      this.store.ctx.repos.reviewPins.save({
        ...pin,
        commit: head.commit,
        branch: head.branch,
        pinnedAt: at,
        pinnedBy: by,
      });
      this.store.timeline.append({
        projectKey,
        taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_updated',
        data: {
          fields: ['reviewPin'],
          reviewPin: { commit: head.commit, branch: head.branch, previous: pin.commit },
        },
      });
      this.store.publish(current);
    });
  }

  /**
   * Moves `task`, read in the running unit of work, or requests the approvals the move needs.
   * The stage listeners are added to `effects`.
   */
  move(
    config: ProjectConfig,
    task: Task,
    stageId: string,
    actor: Actor,
    effects: Effect[],
    opts: MoveOptions = {},
  ): MoveResult {
    // Async preparation may finish after a human has moved or closed the card. Check inside the
    // write transaction so an obsolete automatic target cannot move it back or request a hand-on.
    if (
      opts.expectedFrom &&
      (!isOpenTask(task) ||
        task.status === 'blocked' ||
        task.stageId !== opts.expectedFrom.stageId ||
        task.stageEnteredAt !== opts.expectedFrom.stageEnteredAt)
    )
      return { task, moved: false, pendingApproval: [] };
    if (isTheme(task)) throw themeRefused(task.key, 'move between stages');
    if (task.status === 'cancelled') throw conflict('task_closed', `task ${task.key} is cancelled`);
    const target = requireStage(config, stageId);
    if (task.stageId === target.id) return { task, moved: false, pendingApproval: [] };
    // A decision may have closed while this system move was preparing. Its human handler owns
    // the approval labels and move; do not open a replacement request during that async work.
    if (
      actor.kind === 'system' &&
      this.inbox.isResolvingGate(task.projectKey, task.key, task.stageId, target.id)
    )
      return { task, moved: false, pendingApproval: [] };
    // Every move path checks the project manager's configured stage-move rights.
    if (actorMoveRefusal(config, actor, task.stageId, target.id)) throw projectManagerMoveRefused();
    // A collecting card whose subtasks are all closed goes to the done stage without the gates (PM-647).
    const waiver = this.partsClosedOf(config, task, target.id);
    // The system's automatic close is valid only while the waiver holds: it never falls back to the gates.
    if (opts.partsClosed && !waiver) return { task, moved: false, pendingApproval: [] };
    const evaluation: GateEvaluation = waiver
      ? { unmet: [], approvals: [] }
      : evaluateMove(task, config, task.stageId, target.id);
    if (evaluation.unmet.length > 0) throw gateBlockedError(evaluation);
    if (evaluation.approvals.length > 0) {
      const requested = this.requestApproval(
        config,
        task,
        target,
        evaluation.approvals,
        actor,
        opts.placement,
      );
      return { task: requested.task, moved: false, pendingApproval: requested.items };
    }
    // The gates hold; the work must be merged too. `prepareMove` checks it before the unit of work, and
    // an approval may have come between that and now (PM-484): such a move is not let through unchecked.
    if (this.mergeGate && !opts.mergeChecked) {
      const repo = mergeRepoOf(config, task, task.stageId, target.id);
      if (repo) throw this.mergeGate.notMergedError(config, task, repo, 'not_merged');
    }
    const decision = handOnDecision(config, actor, task.stageId, target.id);
    if (decision.kind === 'request')
      return this.requestHandOn(config, task, target, decision.mover, actorHandle(actor), effects);
    const head = opts.handover?.head;
    const extra: Pick<
      TimelineEventData['task_stage_changed'],
      'reviewPin' | 'branchMoved' | 'testsFailed' | 'pulled' | 'partsClosed'
    > = {
      ...(head ? { reviewPin: { commit: head.commit, branch: head.branch } } : {}),
      ...(opts.branchMoved ? { branchMoved: opts.branchMoved } : {}),
      ...(opts.testsFailed ? { testsFailed: opts.testsFailed } : {}),
      ...(opts.pulled ? { pulled: opts.pulled } : {}),
      ...(waiver ? { partsClosed: waiver } : {}),
    };
    const board: BoardPlace = { placement: opts.placement, reranked: [] };
    return {
      // Only a person can accept the warning: an AI actor's flag is ignored.
      task: this.applyMove(
        config,
        task,
        target,
        actor,
        extra,
        effects,
        head,
        opts.despitePrerequisites === true && actor.kind === 'human',
        board,
      ),
      moved: true,
      pendingApproval: [],
      reranked: board.reranked,
    };
  }

  private requestHandOn(
    config: ProjectConfig,
    task: Task,
    target: Stage,
    mover: string,
    requestedBy: string,
    effects: Effect[],
  ): MoveResult {
    const previous = this.store.ctx.repos.taskHandOns.get(task.projectKey, task.key);
    if (
      previous?.fromStageId === task.stageId &&
      previous.toStageId === target.id &&
      previous.mover === mover
    ) {
      const current = this.store.view(task);
      return { task: current, moved: false, pendingApproval: [], handOn: current.handOn };
    }
    this.clearHandOn(task);
    const handOn: TaskHandOn = {
      fromStageId: task.stageId,
      toStageId: target.id,
      mover,
      requestedBy,
      requestedAt: isoNow(this.store.ctx),
      inboxItemId: null,
    };
    if (memberOf(config, mover)?.kind === 'human') {
      const item = this.inbox.create({
        projectKey: task.projectKey,
        kind: 'hand_on',
        assignees: [mover],
        source: requestedBy,
        taskKey: task.key,
        title: task.title,
        payload: {
          handOn: { taskKey: task.key, fromStageId: task.stageId, toStageId: target.id, requestedBy },
        },
        options: [{ id: 'move', label: 'move', style: 'primary' }],
      });
      handOn.inboxItemId = item.id;
    } else {
      effects.push(() => this.notifyHandOn(config, task, handOn));
    }
    this.store.ctx.repos.taskHandOns.save({ ...handOn, projectKey: task.projectKey, taskKey: task.key });
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor: SYSTEM_ACTOR,
      type: 'task_hand_on_requested',
      data: { fromStageId: task.stageId, toStageId: target.id, mover, requestedBy },
    });
    const next = this.store.view(task);
    this.store.publish(next);
    return { task: next, moved: false, pendingApproval: [], handOn };
  }

  clearHandOn(task: Pick<Task, 'projectKey' | 'key'>, toStageId?: string, by?: string): void {
    const request = this.store.ctx.repos.taskHandOns.get(task.projectKey, task.key);
    if (!request) return;
    if (request.inboxItemId) {
      if (toStageId === request.toStageId && by) this.inbox.resolveHandOn(request.inboxItemId, by);
      else this.inbox.cancel(request.inboxItemId);
    }
    this.store.ctx.repos.taskHandOns.clear(task.projectKey, task.key);
  }

  async reconcileHandOns(config: ProjectConfig): Promise<void> {
    for (const request of this.store.ctx.repos.taskHandOns.list(config.project.key)) {
      const task = this.store.find(request.projectKey, request.taskKey);
      if (!task || !isOpenTask(task) || task.stageId !== request.fromStageId) {
        this.store.ctx.unitOfWork(() =>
          this.clearHandOn(task ?? { projectKey: request.projectKey, key: request.taskKey }),
        );
        continue;
      }
      const mover = cardMoverHandle(config);
      if (mover === request.mover) continue;
      try {
        if (!mover) {
          const result = await this.moveToStage(task.projectKey, task.key, request.toStageId, SYSTEM_ACTOR);
          if (!result.moved)
            this.store.ctx.unitOfWork(() => {
              this.clearHandOn(task);
              this.store.publish(this.store.get(task.projectKey, task.key));
            });
        } else {
          const effects: Effect[] = [];
          this.store.ctx.unitOfWork(() => {
            const current = this.store.get(task.projectKey, task.key);
            this.requestHandOn(
              config,
              current,
              requireStage(config, request.toStageId),
              mover,
              request.requestedBy,
              effects,
            );
          });
          await runEffects(effects);
        }
      } catch (err) {
        if (!mover)
          this.store.ctx.unitOfWork(() => {
            this.clearHandOn(task);
            this.store.publish(this.store.get(task.projectKey, task.key));
          });
        this.store.ctx.logger.warn({ err, taskKey: task.key }, 'could not redirect the hand-on request');
      }
    }
  }

  /** Handler for resolved `decision` items: completes (or drops) the requested stage move. */
  async handleDecisionResolved(item: InboxItem): Promise<void> {
    const gate = gateRequestOf(item);
    const resolution = item.resolution;
    if (!gate || !resolution) return;
    const config = await this.store.projects.config(item.projectKey);
    // An approved move into a review or test stage hands the branch over like any other (PM-183).
    let prepared: PreparedMove = { handover: null, mergeChecked: false };
    let refused = false;
    let mergeMissing = false;
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (
      resolution.optionId === 'approve' &&
      task &&
      task.stageId === gate.fromStageId &&
      task.status !== 'cancelled'
    ) {
      try {
        // The merge is checked as the card will be once every approval of the request is on it.
        const approvedLabels = this.inbox
          .gateRequestItems(item.projectKey, task.key, gate.requestId)
          .flatMap((sibling) => gateRequestOf(sibling)?.label ?? []);
        prepared = await this.prepareMove(
          config,
          { ...task, labels: unique([...task.labels, ...approvedLabels]) },
          gate.toStageId,
        );
      } catch (err) {
        if (!(err instanceof DomainError)) throw err;
        if (err.code === 'task_not_merged') mergeMissing = true;
        else if (err.code === 'handover_uncommitted') refused = true;
        else throw err;
      }
    }
    const effects: Effect[] = [];
    this.store.ctx.unitOfWork(() =>
      this.decide(config, item, gate, humanActor(resolution.by), effects, {
        ...prepared,
        refused,
        mergeMissing,
      }),
    );
    await runEffects(effects);
  }

  private decide(
    config: ProjectConfig,
    item: InboxItem,
    gate: GateRequestPayload,
    actor: Actor,
    effects: Effect[],
    handed: PreparedMove & { refused: boolean; mergeMissing: boolean },
  ): void {
    const task = this.store.find(item.projectKey, gate.taskKey);
    if (!task) return;
    const siblings = this.inbox.gateRequestItems(item.projectKey, task.key, gate.requestId);

    if (item.resolution?.optionId !== 'approve') {
      for (const s of siblings) if (s.state === 'open') this.inbox.cancel(s.id);
      this.settleWaiting(task, actor, {
        gateRejected: { requestId: gate.requestId, to: gate.toStageId, inboxItemId: item.id },
      });
      return;
    }
    if (siblings.some((s) => s.state === 'open')) return; // other approvers still have to decide
    if (!siblings.every((s) => s.state === 'resolved' && s.resolution?.optionId === 'approve')) return;
    if (task.stageId !== gate.fromStageId || task.status === 'cancelled') return; // stale request

    const target = stageOf(config, gate.toStageId);
    if (!target) {
      this.settleWaiting(task, actor, { gateBlocked: { to: gate.toStageId, reason: 'unknown_stage' } });
      return;
    }
    if (handed.refused) {
      // Uncommitted work in the developer's working directory: the approved move does not happen.
      this.settleWaiting(task, actor, { gateBlocked: { to: target.id, reason: 'handover_uncommitted' } });
      return;
    }
    // Approving puts each requested human-only label on the task in the approver's name.
    let current = task;
    for (const sibling of siblings) {
      const label = gateRequestOf(sibling)?.label;
      if (!label) {
        // A request from before approvals were labels names no label to put on.
        this.settleWaiting(current, actor, { gateBlocked: { to: target.id } });
        return;
      }
      if (current.labels.includes(label)) continue;
      const approver = humanActor(sibling.resolution!.by);
      try {
        const before = current;
        current = this.store.ctx.unitOfWork(() =>
          this.labels.apply(config, before, { add: [label] }, approver, { reason: 'approval' }, effects),
        );
      } catch (err) {
        this.settleWaiting(current, actor, {
          gateBlocked: { to: target.id, label, reason: (err as { code?: string }).code },
        });
        return;
      }
    }
    const evaluation = evaluateMove(current, config, current.stageId, target.id);
    if (evaluation.unmet.length > 0 || evaluation.approvals.length > 0) {
      this.settleWaiting(current, actor, {
        gateBlocked: { to: target.id, unmet: evaluation.unmet, approvals: evaluation.approvals },
      });
      return;
    }
    // Not checked (the approval came after `prepareMove` read the card): the work counts as not merged.
    const unchecked =
      this.mergeGate && !handed.mergeChecked && mergeRepoOf(config, current, current.stageId, target.id);
    if (handed.mergeMissing || unchecked) {
      this.settleWaiting(current, actor, { gateBlocked: { to: target.id, reason: 'task_not_merged' } });
      effects.push(async () => {
        await this.mergeGate?.reconcile(current.projectKey, current.key);
      });
      return;
    }
    this.applyMove(
      config,
      current,
      target,
      actor,
      {
        approvedBy: unique(siblings.map((s) => s.resolution!.by)),
        inboxItemIds: siblings.map((s) => s.id),
        ...(handed.handover
          ? { reviewPin: { commit: handed.handover.head.commit, branch: handed.handover.head.branch } }
          : {}),
      },
      effects,
      handed.handover?.head,
      false,
      // The place the person chose when asking; the top when that card is not in the column any more.
      { placement: gate.placement, reranked: [] },
    );
  }

  /** Opens one decision per missing approval (or finds the open request) and marks the task waiting. */
  private requestApproval(
    config: ProjectConfig,
    task: Task,
    target: Stage,
    approvals: ApprovalRequirement[],
    actor: Actor,
    placement?: BoardPlacement,
  ): { task: Task; items: InboxItem[] } {
    const open = this.inbox.openGateRequests(task.projectKey, task.key, task.stageId, target.id);
    // The system may have asked already (PM-445), without a place; a person's drop on the board that
    // names one asks again so that the place is kept with the request.
    const keepsPlace = (item: InboxItem) =>
      !placement || JSON.stringify(gateRequestOf(item)?.placement) === JSON.stringify(placement);
    if (open.length > 0 && open.every(keepsPlace)) return { task, items: open };
    for (const item of open) this.inbox.cancel(item.id);

    for (const req of approvals) {
      if (req.approvers.length > 0) continue;
      // Nobody may give it: the holders authored the task, or nobody holds the label.
      const reason = noApproverReason(config, req.label, task) ?? 'missing_duty_holder';
      throw conflict(reason, `nobody may approve the label ${req.label} on this task`, {
        stageId: req.stageId,
        label: req.label,
      });
    }
    const requestId = newId('gat');
    // The merge that follows the approval (PM-484), so that the request can say who merges and into what.
    const afterGates = moveMerge(config, task, task.stageId, target.id);
    const merger = afterGates.kind === 'after_gates' ? this.mergeGate?.mergerOf(config, task) : null;
    const merge =
      afterGates.kind === 'after_gates' && merger ? { merger, base: afterGates.repo.defaultBranch } : null;
    const items = approvals.map((req) => {
      const payload: GateRequestPayload = {
        requestId,
        taskKey: task.key,
        fromStageId: task.stageId,
        toStageId: target.id,
        stageId: req.stageId,
        label: req.label,
        requestedBy: actor,
        ...(placement ? { placement } : {}),
        ...(merge ? { merge } : {}),
      };
      return this.inbox.create({
        projectKey: task.projectKey,
        kind: 'decision',
        assignees: req.approvers,
        source: actorHandle(actor),
        taskKey: task.key,
        title: task.title,
        payload: { gate: payload },
        options: DECISION_OPTIONS,
      });
    });
    const waiting = task.status === 'active';
    const next = waiting
      ? this.store.write(task, { status: 'waiting', updatedAt: isoNow(this.store.ctx) })
      : task;
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: {
        fields: waiting ? ['status'] : [],
        gateRequest: { requestId, from: task.stageId, to: target.id, inboxItemIds: items.map((i) => i.id) },
      },
    });
    if (waiting) this.store.publish(next);
    return { task: next, items };
  }

  private applyMove(
    config: ProjectConfig,
    task: Task,
    target: Stage,
    actor: Actor,
    extra: Pick<
      TimelineEventData['task_stage_changed'],
      'approvedBy' | 'inboxItemIds' | 'reviewPin' | 'branchMoved' | 'testsFailed' | 'pulled' | 'partsClosed'
    >,
    effects: Effect[],
    pin?: SourceHead,
    despitePrerequisites = false,
    board: BoardPlace = { reranked: [] },
  ): Task {
    const at = isoNow(this.store.ctx);
    this.cancelMerge(task.projectKey, task.key, effects);
    // The commit handed over with the stage the task leaves is no longer its pin.
    this.clearHandOn(task, target.id, actorHandle(actor));
    this.store.ctx.repos.reviewPins.clear(task.key);
    if (pin)
      this.store.ctx.repos.reviewPins.save({
        projectKey: task.projectKey,
        taskKey: task.key,
        stageId: target.id,
        commit: pin.commit,
        branch: pin.branch,
        pinnedAt: at,
        pinnedBy: actorHandle(actor),
      });
    const patch: TaskPatch = { stageId: target.id, updatedAt: at };
    if (target.id !== task.stageId) patch.stageEnteredAt = at;
    if (target.kind === 'done') {
      patch.status = 'done';
      patch.closedAt = at;
    } else if (task.status === 'done' || task.status === 'waiting') {
      patch.status = 'active';
      patch.closedAt = null;
    }
    // A card entering another column takes its place there (the top unless it was dropped at a
    // place); a status or stage change inside its own column never moves it (PM-118).
    const toColumn = boardColumnOf(target);
    let placed: string[] = [];
    if (toColumn !== undefined && toColumn !== boardColumnOf(stageOf(config, task.stageId))) {
      const entered = this.order.enter(config, { ...task, updatedAt: at }, toColumn, board.placement);
      if (entered.rank !== undefined) patch.boardRank = entered.rank;
      placed = entered.reranked;
    }
    let next = this.store.view(this.store.write(task, patch));
    const event = this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_stage_changed',
      data: { from: task.stageId, to: target.id, ...extra },
    });
    this.store.publish(next);
    this.order.publish(task.projectKey, placed);
    board.reranked.push(...placed);
    // Facts that expire when work goes back (e.g. "code review ok") come off the task.
    if (stageIndex(config.pipeline, target.id) < stageIndex(config.pipeline, task.stageId))
      next = this.labels.expire(config, next, 'moved_back', effects);
    // Requests made from the previous stage are stale now.
    for (const item of this.inbox.list(task.projectKey, {
      kind: 'decision',
      state: 'open',
      taskKey: task.key,
    })) {
      if (fixLimitDecisionOf(item)) continue;
      this.inbox.cancel(item.id);
    }
    const change: StageChange = {
      task: next,
      from: task.stageId,
      to: target.id,
      actor,
      eventId: event.id,
      ...(despitePrerequisites ? { despitePrerequisites } : {}),
    };
    effects.push(() => this.store.ctx.events.emit('task_stage_changed', change));
    return next;
  }

  /** Ends the "waiting for approval" status after a rejected or dropped request. */
  private settleWaiting(
    task: Task,
    actor: Actor,
    data: Pick<TimelineEventData['task_updated'], 'gateRejected' | 'gateBlocked'>,
  ): void {
    const waiting = task.status === 'waiting';
    const next = waiting
      ? this.store.write(task, { status: 'active', updatedAt: isoNow(this.store.ctx) })
      : task;
    this.store.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor,
      type: 'task_updated',
      data: { fields: waiting ? ['status'] : [], ...data },
    });
    if (waiting) this.store.publish(next);
  }
}
