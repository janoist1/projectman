import {
  PAUSING_REFUSALS,
  PENDING_INBOX_STATES,
  SYSTEM_SENDER,
  isInformationalAlert,
  inboxRecipientOf,
  isOpenTask,
  labelDefinition,
  memberOf,
  obligationMinutesOf,
  planObligation,
  questionPayloadOf,
} from '@projectman/shared';
import type {
  InboxItem,
  Obligation,
  ObligationKind,
  ObligationPauseReason,
  ObligationRef,
  ProjectConfig,
  QuestionRecipientRefusal,
  Task,
  TimelineEventData,
} from '@projectman/shared';
import { isoNow } from '../../core/base';
import type { DomainContext } from '../../core/base';
import type { InboxService } from '../../core/inbox';
import type { MemberQueue } from '../../core/member-queue';
import { staleReasonFor } from '../../core/messages';
import type { MessageService, Messaging } from '../../core/messages';
import type { ProjectService } from '../../core/projects';
import type { TaskService, TaskWaits } from '../../core/tasks';
import type { TimelineService } from '../../core/timeline';
import { KeyedMutex, SYSTEM_ACTOR, newId } from '../../kernel';
import type {
  ObligationAdmission,
  ObligationFixLimit,
  ObligationRefinement,
  ObligationSessions,
  ObligationStartOffers,
} from './ports';
import { seniorWaitSource } from './senior-wait';
import { obligationSources } from './sources';
import type { DerivedObligation, ObligationSource, ProjectView } from './sources';

const MINUTE_MS = 60_000;

/** The input of `open`: one step that is open now. */
interface OpenObligation {
  projectKey: string;
  taskKey: string;
  kind: ObligationKind;
  responsible: string | null;
  subject: string;
  openedAt: string;
}

interface ObligationsDeps {
  ctx: DomainContext;
  projects: Pick<ProjectService, 'summaries' | 'config' | 'cachedConfig'>;
  tasks: Pick<TaskService, 'find' | 'readSchedulingTasks' | 'publish' | 'startAttempting'>;
  taskWaits: Pick<TaskWaits, 'of'>;
  inbox: Pick<InboxService, 'openIntegratorTodo' | 'closeObligationTodo' | 'create' | 'resolveByRule'>;
  messaging: Pick<Messaging, 'send'>;
  messages: Pick<MessageService, 'markRecipientDelivered'>;
  timeline: Pick<TimelineService, 'append' | 'latest'>;
  memberQueue: Pick<MemberQueue, 'remindObligation'>;
  sessions: ObligationSessions;
  admission: ObligationAdmission;
  refinement: ObligationRefinement;
  fixLimit: ObligationFixLimit;
  startOffers: ObligationStartOffers;
}

const keyOf = (kind: string, taskKey: string, responsible: string | null, subject: string): string =>
  `${kind}\u0000${taskKey}\u0000${responsible ?? ''}\u0000${subject}`;

const rowKey = (row: Obligation): string => keyOf(row.kind, row.taskKey, row.responsible, row.subject);

const isObligationTodo = (item: InboxItem): boolean => !!questionPayloadOf(item)?.obligation;

const minutesBetween = (from: string, to: string): number =>
  Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / MINUTE_MS));

/**
 * The obligation tracking (PM-806): an open step must not get lost when the AI member responsible for it
 * stops, stalls or misunderstands. Every step has a responsible and a deadline of N minutes
 * (`obligationMinutes`): the first expiry sends the responsible one reminder, the second one gives the
 * step to the integrator as a todo or a decision item. The system never does the step, decides, or sets a label itself.
 *
 * The sweep is level-driven: each kind's source says which steps are open now, a row is written for
 * each (once for ever, per card, kind, responsible and subject), and a row whose step is not open any
 * more is closed. The rows hold the clock, so a restart, a double sweep or a crash between the todo and
 * the row loses nothing and repeats nothing.
 */
export class ObligationsService {
  private readonly ctx: DomainContext;
  private readonly projects: ObligationsDeps['projects'];
  private readonly tasks: ObligationsDeps['tasks'];
  private readonly taskWaits: ObligationsDeps['taskWaits'];
  private readonly inbox: ObligationsDeps['inbox'];
  private readonly messaging: ObligationsDeps['messaging'];
  private readonly messages: ObligationsDeps['messages'];
  private readonly timeline: ObligationsDeps['timeline'];
  private readonly memberQueue: ObligationsDeps['memberQueue'];
  private readonly sessions: ObligationSessions;
  private readonly admission: ObligationAdmission;
  private readonly sources: ObligationSource[];
  private readonly cards = new KeyedMutex();

  constructor(deps: ObligationsDeps) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.taskWaits = deps.taskWaits;
    this.inbox = deps.inbox;
    this.messaging = deps.messaging;
    this.messages = deps.messages;
    this.timeline = deps.timeline;
    this.memberQueue = deps.memberQueue;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.sources = obligationSources({
      sessions: deps.sessions,
      refinement: deps.refinement,
      fixLimit: deps.fixLimit,
      startOffers: deps.startOffers,
      fixLimits: deps.ctx.repos.taskFixLimits,
      decidingAtDesk: (projectKey, taskKey, member) =>
        deps.ctx.repos.memberQueue
          .listOpen(projectKey, member)
          .some(
            (i) =>
              i.kind === 'fix_limit' &&
              i.taskKey === taskKey &&
              i.state === 'processing' &&
              !!i.sessionId &&
              deps.sessions.atWork(i.sessionId),
          ),
      roundsOf: (projectKey, taskKey) => deps.tasks.find(projectKey, taskKey)?.fixLimit?.rounds ?? 0,
      mergeState: (mergeId) => deps.ctx.repos.taskMerges.get(mergeId)?.state ?? null,
      labelsAddedSince: (projectKey, taskKey, labels, since) =>
        deps.ctx.repos.timeline
          .listOfTypes(projectKey, taskKey, ['task_labels_changed'], 200)
          .some((event) => {
            const data = event.data as Partial<TimelineEventData['task_labels_changed']>;
            return (
              event.createdAt >= since &&
              Array.isArray(data.added) &&
              data.added.some((label) => labels.includes(label))
            );
          }),
      importedEntry: (projectKey, taskKey, since) =>
        deps.ctx.repos.timeline
          .listOfTypes(projectKey, taskKey, ['task_created'], 1)
          .some((event) => event.createdAt === since && event.data.imported === true),
    });
    this.sources.push(
      seniorWaitSource({ ctx: deps.ctx, inbox: deps.inbox, timeline: deps.timeline, tasks: deps.tasks }),
    );
  }

  /** The minutes of a kind's deadline in this configuration: its own, or the project's obligation minutes. */
  private minutesOf(kind: ObligationKind, config: ProjectConfig | undefined): number {
    return (
      (config && this.sourceOf(kind).minutesOf?.(config)) ?? obligationMinutesOf(config?.team.limits ?? {})
    );
  }

  /** Opens the row of a step; the existing row of the same step (closed ones too) is returned unchanged. */
  open(input: OpenObligation): Obligation {
    const minutes = this.minutesOf(input.kind, this.projects.cachedConfig(input.projectKey));
    const repo = this.ctx.repos.obligations;
    repo.insert({
      id: newId('obl'),
      ...input,
      dueAt: new Date(Date.parse(input.openedAt) + minutes * MINUTE_MS).toISOString(),
    });
    return repo.find(input.projectKey, input.taskKey, input.kind, input.responsible, input.subject)!;
  }

  /** The open and handed-over rows of a project, or of one card. */
  listOpen(projectKey: string, taskKey?: string): Obligation[] {
    return this.ctx.repos.obligations.listLive(projectKey, taskKey);
  }

  /** One round over every project; a project that fails is logged and the others go on. */
  async sweep(now?: Date): Promise<void> {
    const at = (now ?? this.ctx.now()).toISOString();
    for (const { key } of this.projects.summaries()) {
      try {
        await this.sweepProject(key, at);
      } catch (err) {
        this.ctx.logger.warn({ err, projectKey: key }, 'could not sweep the obligations of a project');
      }
    }
  }

  private async sweepProject(projectKey: string, at: string): Promise<void> {
    const config = await this.projects.config(projectKey);
    const minutes = obligationMinutesOf(config.team.limits);
    const live = this.ctx.repos.obligations.listLive(projectKey);
    // The open cards, and the cards of the live rows (a row of a card that closed ends now): the
    // history of the closed cards is not read.
    const tasks = new Map<string, Task>();
    for (const stored of this.tasks.readSchedulingTasks(projectKey, { kind: 'open' })) {
      const task = this.tasks.find(projectKey, stored.key);
      if (task) tasks.set(task.key, task);
    }
    for (const row of live) {
      if (tasks.has(row.taskKey)) continue;
      const task = this.tasks.find(projectKey, row.taskKey);
      if (task) tasks.set(task.key, task);
    }
    // Old start offers may belong to collectors whose parts have already closed. Read those parts even
    // before the start round has a view (or while its frame is paused), so their rows and todos end now.
    const startKeys = [...new Set(live.filter((row) => row.kind === 'start').map((row) => row.taskKey))];
    if (startKeys.length > 0)
      for (const part of this.tasks.readSchedulingTasks(projectKey, {
        kind: 'children',
        parentKeys: startKeys,
        includeClosed: true,
      }))
        tasks.set(part.key, part);
    const waits = this.taskWaits.of(config, [...tasks.values()].filter(isOpenTask), null, isObligationTodo);
    const view: ProjectView = { config, tasks, waits, live };
    // What each kind says is open now; a kind that cannot be read leaves its rows alone.
    const derived = new Map<string, DerivedObligation & { kind: ObligationKind }>();
    const unreadable = new Set<ObligationKind>();
    for (const source of this.sources) {
      const found = source.derive(view);
      if (found === null) unreadable.add(source.kind);
      else
        for (const d of found)
          derived.set(keyOf(source.kind, d.taskKey, d.responsible, d.subject), { ...d, kind: source.kind });
    }
    const keys = new Set<string>([
      ...[...derived.values()].map((d) => d.taskKey),
      ...view.live.map((row) => row.taskKey),
    ]);
    const humanItems = this.humanItemsByCard(projectKey, config);
    for (const taskKey of keys) {
      try {
        await this.cards.run(`${projectKey}:${taskKey}`, () =>
          this.sweepCard({ projectKey, taskKey, view, derived, unreadable, humanItems, minutes, at }),
        );
      } catch (err) {
        this.ctx.logger.warn({ err, projectKey, taskKey }, 'could not sweep the obligations of a card');
      }
    }
    this.discardClosedReminders(projectKey, config);
  }

  /**
   * A reminder that waits in a recipient's queue (it could not start: capacity, leave) is dropped once its
   * step is not open any more (PM-813). It is marked delivered without being typed anywhere, and it started
   * nothing before either: the delivery treats it as stale. This also clears the queue after a restart.
   */
  private discardClosedReminders(projectKey: string, config: ProjectConfig): void {
    for (const { message, handles } of this.ctx.repos.messages.pendingObligationReminders(projectKey)) {
      if (staleReasonFor(this.ctx, config, message, handles[0]!) !== 'obligation_closed') continue;
      for (const handle of handles) this.messages.markRecipientDelivered(message.id, handle);
    }
  }

  /**
   * The open items a person has to answer, by card: the tracking's own todos and notices do not count.
   * An owner's alert about the very step (a stalled refinement turn) does: the person has it, so the
   * clock stands still until they have dealt with it.
   */
  private humanItemsByCard(projectKey: string, config: ProjectConfig): Map<string, InboxItem[]> {
    const byCard = new Map<string, InboxItem[]>();
    for (const item of this.ctx.repos.inbox.list(projectKey, { state: PENDING_INBOX_STATES })) {
      if (!item.taskKey || isObligationTodo(item) || isInformationalAlert(item)) continue;
      if (item.kind === 'question' && item.payload.groupWithdrawn === true) continue;
      if (!item.assignees.some((handle) => memberOf(config, handle)?.kind === 'human')) continue;
      const list = byCard.get(item.taskKey) ?? [];
      list.push(item);
      byCard.set(item.taskKey, list);
    }
    return byCard;
  }

  private async sweepCard(round: {
    projectKey: string;
    taskKey: string;
    view: ProjectView;
    derived: ReadonlyMap<string, DerivedObligation & { kind: ObligationKind }>;
    unreadable: ReadonlySet<ObligationKind>;
    humanItems: ReadonlyMap<string, InboxItem[]>;
    minutes: number;
    at: string;
  }): Promise<void> {
    const { projectKey, taskKey, view, derived, unreadable, humanItems, minutes, at } = round;
    const repo = this.ctx.repos.obligations;
    // Step 1: every open step has a row (a step that was open before and closed does not open again).
    for (const d of derived.values()) {
      if (d.taskKey !== taskKey) continue;
      this.open({
        projectKey,
        taskKey,
        kind: d.kind,
        responsible: d.responsible,
        subject: d.subject,
        openedAt: d.since,
      });
    }
    const task = view.tasks.get(taskKey);
    for (const listed of repo.listLive(projectKey, taskKey)) {
      // Read again inside the card lock: a round before this one may have moved the row on.
      const row = repo.get(listed.id);
      if (!row || (row.state !== 'open' && row.state !== 'handed_over') || unreadable.has(row.kind)) continue;
      // A row opened by `open` after this sweep began (the start round, PM-804) was not derived: the next sweep sees it.
      if (row.openedAt > at) continue;
      const still = derived.get(rowKey(row));
      const source = this.sourceOf(row.kind);
      if (!still && source.keepsHandedOver?.(row, view)) {
        if (row.state === 'open') await this.handOver(row, minutes, at, view);
        continue;
      }
      if (!still && row.state === 'handed_over' && source.keepsHandedOver) {
        await this.end(row, view, at);
        continue;
      }
      // A handed-over row only waits for its step to end.
      if (still && row.state !== 'open') continue;
      // A step that is not open any more is asked about the start too: a refused start is why it may look so.
      const paused =
        source.pausable === false
          ? null
          : ((await this.pauseOf(view, task, row, humanItems.get(taskKey) ?? [], at, !still)) ??
            (still?.held ? 'held' : null));
      // Step 2: a step that is not open any more ends, unless something holds the card (a source that
      // derives its steps whatever holds the card has none to keep open).
      if (!still) {
        if (task && isOpenTask(task) && paused && !this.sourceOf(row.kind).derivesWhilePaused) {
          if (row.state === 'open') await this.plan(row, task, paused, still, minutes, at, view);
          continue;
        }
        await this.end(row, view, at);
        continue;
      }
      if (row.state !== 'open' || !task) continue;
      // Step 3: the clock of an open row.
      await this.plan(row, task, paused, still, minutes, at, view);
    }
  }

  /** Why the card stands still for the row's responsible, or null. */
  private async pauseOf(
    view: ProjectView,
    task: Task | undefined,
    row: Obligation,
    humanItems: readonly InboxItem[],
    at: string,
    ended: boolean,
  ): Promise<ObligationPauseReason | null> {
    if (!task || !isOpenTask(task)) return null;
    const config = view.config;
    if (task.status === 'blocked' || task.labels.some((id) => labelDefinition(config, id)?.blocks))
      return 'held';
    const ownDecisionId =
      row.kind === 'fix_limit' ? this.ctx.repos.taskFixLimits.get(row.taskKey)?.inboxItemId : null;
    if (humanItems.some((item) => item.id !== ownDecisionId)) return 'inbox';
    // A step with no responsible has no session or start to wait for.
    if (row.responsible === null) return null;
    const sessions = this.sessions.ofMember(row.projectKey, row.taskKey, row.responsible);
    const live = sessions.filter((session) => session.running);
    if (live.some((session) => session.state === 'waiting_permission' || session.state === 'waiting_input'))
      return 'permission';
    // A running session takes the reminder as input; only a start that would be needed can be refused.
    // The start is asked about when it matters: at the deadline, and while the clock stands still.
    if (live.length === 0 && (ended || row.pausedSince !== null || Date.parse(at) >= Date.parse(row.dueAt))) {
      const refusal = await this.admission.refusal(config, row.responsible, row.taskKey);
      if (refusal && PAUSING_REFUSALS.includes(refusal)) return 'start_refused';
    }
    return null;
  }

  /** Does what `planObligation` says. */
  private async plan(
    row: Obligation,
    task: Task,
    paused: ObligationPauseReason | null,
    still: DerivedObligation | undefined,
    projectMinutes: number,
    at: string,
    view: ProjectView,
  ): Promise<void> {
    const repo = this.ctx.repos.obligations;
    const source = this.sourceOf(row.kind);
    const minutes = source.minutesOf?.(view.config) ?? projectMinutes;
    const due = Date.parse(at) >= Date.parse(row.dueAt);
    const step = planObligation(
      row,
      {
        paused,
        active: !!still?.active,
        lastActivityAt: due && !paused ? this.lastActivityOf(row, task) : null,
      },
      at,
      minutes,
      source.rungs,
    );
    switch (step.kind) {
      case 'none':
        return;
      case 'pause':
        repo.update(row.id, { pausedSince: at, pauseReason: step.reason }, at);
        return;
      case 'resume':
        repo.update(row.id, { pausedSince: null, pauseReason: null, dueAt: step.dueAt }, at);
        return;
      case 'extend':
        repo.update(row.id, { dueAt: step.dueAt }, at);
        return;
      case 'wake':
        await this.wake(row, minutes, step.dueAt, at, view);
        return;
      case 'hand_over':
        await this.handOver(row, minutes, at, view);
        return;
    }
  }

  /** The responsible's last move on the card: its last timeline event or the last activity of its sessions. */
  private lastActivityOf(row: Obligation, task: Task): string | null {
    if (row.responsible === null) return null;
    const events = this.ctx.repos.timeline.list(row.projectKey, { taskKey: task.key, limit: 200 });
    let last: string | null = null;
    for (const event of events) {
      if (event.actor.handle !== row.responsible) continue;
      if (!last || event.createdAt > last) last = event.createdAt;
    }
    for (const session of this.sessions.ofMember(row.projectKey, row.taskKey, row.responsible)) {
      if (!last || session.lastActivityAt > last) last = session.lastActivityAt;
    }
    return last;
  }

  private ref(row: Obligation): ObligationRef {
    return { id: row.id, kind: row.kind, responsible: row.responsible, openedAt: row.openedAt };
  }

  private sourceOf(kind: ObligationKind): ObligationSource {
    const source = this.sources.find((candidate) => candidate.kind === kind);
    if (!source) throw new Error(`no obligation source for ${kind}`);
    return source;
  }

  /** The one reminder: the row and the event are written first, so a failed send is never repeated. */
  private async wake(
    row: Obligation,
    minutes: number,
    dueAt: string,
    at: string,
    view: ProjectView,
  ): Promise<void> {
    const responsible = row.responsible;
    const text = this.sourceOf(row.kind).wakeText?.(row, minutes, minutesBetween(row.openedAt, at), view);
    // A kind without a reminder (or a step with no responsible) never climbs this rung; see `rungs`.
    if (text === undefined || responsible === null) throw new Error(`no reminder for ${row.kind}`);
    const ai = memberOf(view.config, responsible)?.kind === 'ai';
    this.ctx.unitOfWork(() => {
      this.ctx.repos.obligations.update(row.id, { wokenAt: at, dueAt }, at);
      if (ai) this.memberQueue.remindObligation({ ...row, responsible }, text);
      this.timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'obligation_woken',
        data: {
          obligationId: row.id,
          kind: row.kind,
          responsible,
          subject: row.subject,
          openedAt: row.openedAt,
          minutes,
        },
      });
    });
    if (ai) return;
    try {
      await this.messaging.send(
        row.projectKey,
        SYSTEM_SENDER,
        {
          to: [responsible],
          taskKey: row.taskKey,
          text,
        },
        // The subject lets the delivery see that the reminder is out of date once the step is done (PM-813).
        {
          actor: SYSTEM_ACTOR,
          kind: 'action',
          ownCard: true,
          subject: { type: 'obligation', obligationId: row.id },
        },
      );
    } catch (err) {
      this.ctx.logger.warn(
        { err, obligationId: row.id, taskKey: row.taskKey },
        'could not send an obligation reminder',
      );
    }
  }

  /** The second expiry: a decision hand-over or one todo. A crash never repeats an existing item. */
  private async handOver(row: Obligation, minutes: number, at: string, view: ProjectView): Promise<void> {
    const source = this.sourceOf(row.kind);
    const result = await source.handOver?.(row, view);
    if (source.handOver && !result) {
      this.ctx.repos.obligations.close(row.id, 'fulfilled', at);
      return;
    }
    // The source wrote the hand-over and its record itself.
    if (result === 'settled') return;
    const responsible = row.responsible;
    if (responsible === null) throw new Error(`${row.kind} has no responsible to hand over from`);
    const decision = result ?? null;
    const decisionItem = decision ? this.ctx.repos.inbox.get(decision.decisionItemId) : null;
    if (decision && !decisionItem) throw new Error(`missing hand-over decision ${decision.decisionItemId}`);
    const found = decision ? null : this.todoOf(row);
    let itemId = decisionItem?.id ?? found?.id ?? null;
    let recipientRefusal: QuestionRecipientRefusal | undefined;
    let recipient = decisionItem
      ? inboxRecipientOf(decisionItem)
      : found
        ? (questionPayloadOf(found)?.recipient ?? 'owner')
        : null;
    if (!itemId) {
      const content = source.todo?.(row, minutes, minutesBetween(row.openedAt, at), view);
      if (!content) throw new Error(`no hand-over todo for ${row.kind}`);
      const { question, todo } = content;
      const opened = await this.inbox.openIntegratorTodo({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        askedBy: 'system',
        question,
        todo,
        obligation: this.ref(row),
      });
      itemId = opened.itemId;
      recipient = opened.recipient;
      recipientRefusal = opened.recipientRefusal ?? undefined;
    }
    const to = recipient ?? 'owner';
    this.ctx.unitOfWork(() => {
      this.ctx.repos.obligations.update(row.id, { handedOverAt: at, inboxItemId: itemId! }, at);
      this.timeline.append({
        projectKey: row.projectKey,
        taskKey: row.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'obligation_handed_over',
        data: {
          obligationId: row.id,
          kind: row.kind,
          responsible,
          subject: row.subject,
          openedAt: row.openedAt,
          minutes,
          inboxItemId: itemId!,
          recipient: to,
          ...(recipientRefusal ? { recipientRefusal } : {}),
          ...(decision ? { decisionItemId: decision.decisionItemId } : {}),
        },
      });
    });
  }

  /** Only the row's todo, never a decision: by its id or the obligation it names after a crash. */
  private todoOf(row: Obligation): InboxItem | null {
    const inbox = this.ctx.repos.inbox;
    const pending = new Set<string>(PENDING_INBOX_STATES);
    if (row.inboxItemId) {
      const item = inbox.get(row.inboxItemId);
      if (item && pending.has(item.state) && isObligationTodo(item)) return item;
    }
    return (
      inbox
        .list(row.projectKey, { state: PENDING_INBOX_STATES })
        .find((item) => item.taskKey === row.taskKey && questionPayloadOf(item)?.obligation?.id === row.id) ??
      null
    );
  }

  /** The step is not open any more: the row ends as its kind says, and its todo, if open, closes with it. */
  private async end(row: Obligation, view: ProjectView, at: string): Promise<void> {
    const outcome = this.sourceOf(row.kind).closedAs(row, view);
    // The todo first: if closing it fails the row stays, and the next round closes both.
    const todo = this.todoOf(row);
    if (todo) await this.inbox.closeObligationTodo(todo.id, at);
    const source = this.sourceOf(row.kind);
    this.ctx.unitOfWork(() => {
      this.ctx.repos.obligations.close(row.id, outcome, at);
      source.onClosed?.(row, outcome, view);
    });
  }
}
