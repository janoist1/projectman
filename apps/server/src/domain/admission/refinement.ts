import {
  ALERT_SEEN_OPTION,
  REFINE_LABEL,
  alertPayloadOf,
  dutyMembers,
  formatInjectedTeamMessage,
  isOnLeave,
  isOpenTask,
  memberOf,
  refinementTurn,
  turnStalled,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  InboxItem,
  ProjectConfig,
  RefinementAlert,
  Session,
  Task,
} from '@projectman/shared';
import { ownerHandles } from '../access';
import type { InboxService } from '../inbox';
import type { MessageDelivery } from '../messaging';
import type { ProjectService } from '../projects';
import type { SessionOrchestrator } from '../sessions';
import type { StageChange, TaskService } from '../tasks';
import type { TimelineService } from '../timeline';
import { KeyedMutex, SYSTEM_ACTOR } from '../util';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';

type RefinementSpec = Extract<StartSpec, { kind: 'refinement_turn' }>;
type Step = Extract<NonNullable<ReturnType<typeof refinementTurn>>, { kind: 'step' }>;

/** What the latest `refinement_turn` event of a card says. */
interface RecordedTurn {
  label: string | null;
  member: string | null;
  reason: string;
  at: string;
}

/** Session states in which a member is in the middle of a turn. */
const ENGAGED = new Set<Session['state']>(['starting', 'working', 'waiting_permission', 'waiting_input']);

/**
 * Refinement line (decision 31): a card that is being refined (`refinementTurn`) is worked out one
 * step at a time, each step by one member. A step is a label the gates before the development stage
 * ask for; its turn belongs to one member who may set it: an AI member is started (or told, when its
 * session already works the card), a person gets an alert, since only they can do it. Nothing
 * happens while a session is in the middle of a turn on the card: the next step is looked at when it
 * ends. A step that was handed to a member is not handed again (no restart for the same step): when
 * its turn ends without the label, the owners get one `stalled` alert. When every label is on, the
 * card leaves refinement: the system takes `refine` off, moves it to the stage before development and
 * tells the people who prioritise (`done`). Every change of turn is a `refinement_turn` event on the
 * card. A refused start waits like a hand-over does, and is retried by the usual events and timer.
 * The card moves only when its labels change, it changes stage, or a session on it goes idle or ends.
 */
export class RefinementSteps {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly delivery: MessageDelivery;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  /** One look at a card at a time, so that two events do not hand the same step out twice. */
  private readonly cards = new KeyedMutex();

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
    inbox: InboxService;
    timeline: TimelineService;
  }) {
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.delivery = deps.delivery;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
  }

  /** Label change and stage change listener. */
  async changed(task: Pick<Task, 'projectKey' | 'key'>): Promise<void> {
    await this.advance(task.projectKey, task.key);
  }

  /** Listener of a session that went idle or ended: its member's turn on the card may be over. */
  async turnEnded(session: Session): Promise<void> {
    if (session.workItem.type !== 'task') return;
    // A pause cut the turn (or the session ended with the process held): not a stalled turn. After the
    // resume `PauseService` calls this again for the sessions that stopped between turns (PM-219).
    if (this.sessions.isPaused(session)) return;
    await this.advance(session.projectKey, session.workItem.taskKey, session.member);
  }

  /** Stage change listener. */
  async moved(change: StageChange): Promise<void> {
    await this.advance(change.task.projectKey, change.task.key);
  }

  /**
   * The member whose turn it is on the card: the one the latest turn event names, null when the
   * turn is a person's, blocked, over, or the card was never refined.
   */
  turnMember(projectKey: string, taskKey: string): string | null {
    const turn = this.recorded(projectKey, taskKey);
    return turn && turn.reason !== 'done' ? turn.member : null;
  }

  /**
   * A refinement start that was deferred when the server stopped, made again from what was stored;
   * null when its task is gone.
   */
  rebuild(spec: RefinementSpec): AutomaticStart | null {
    return this.tasks.find(spec.projectKey, spec.taskKey) ? this.startFor(spec) : null;
  }

  private advance(projectKey: string, taskKey: string, endedMember?: string): Promise<void> {
    return this.cards.run(`${projectKey}:${taskKey}`, () => this.look(projectKey, taskKey, endedMember));
  }

  /** One look at a card: closes alerts that no longer apply, then does what the turn calls for. */
  private async look(projectKey: string, taskKey: string, endedMember?: string): Promise<void> {
    const task = this.tasks.find(projectKey, taskKey);
    if (!task) return;
    const config = await this.projects.config(projectKey);
    const turn = refinementTurn(task, config);
    this.closeAlerts(task, turn?.kind === 'step' ? turn.label : null);
    if (!turn || this.midTurn(task)) return;
    // Held back: the turn stays with its member, and goes on from there once the card is free.
    if (turn.kind === 'blocked') return;
    if (turn.kind === 'done') return this.finish(config, task, turn.targetStageId);
    if (turn.aiSetters.length === 0) {
      if (this.record(task, turn.label, null))
        this.alert(config, task, turn.label, 'manual_step', turn.humanSetters);
      return;
    }
    const taken = this.recorded(projectKey, taskKey);
    if (taken && taken.label === turn.label && taken.member !== null && taken.reason !== 'done') {
      // Handed out already: not again. Its member's turn having ended without the label is told once.
      // An open question of an AI member is no stall: it waits for the answer.
      const items = this.inbox.list(projectKey, { state: 'open', kind: 'question', taskKey });
      if (
        endedMember === taken.member &&
        turnStalled(items, config) &&
        !this.alerted(task, 'stalled', turn.label, taken.at)
      )
        this.alert(config, task, turn.label, 'stalled', []);
      return;
    }
    await this.admission.attempt(
      this.startFor({
        kind: 'refinement_turn',
        projectKey,
        taskKey,
        stageId: task.stageId,
        label: turn.label,
      }),
    );
  }

  private startFor(spec: RefinementSpec): AutomaticStart {
    const { projectKey, taskKey, label } = spec;
    let waitsFor: string | undefined;
    return {
      key: `refinement:${projectKey}:${taskKey}`,
      projectKey,
      taskKey,
      spec: () => spec,
      stillValid: (task) =>
        task !== null && isOpenTask(task) && task.stageId === spec.stageId && !task.labels.includes(label),
      waitsFor: () => waitsFor,
      retry: () => this.advance(projectKey, taskKey),
      log: {
        deferred: 'refinement step start deferred',
        retryFailed: 'refinement step start retry failed',
        fields: () => ({ taskKey, label }),
      },
      run: async () => {
        const task = this.tasks.get(projectKey, taskKey);
        const config = await this.projects.config(projectKey);
        const turn = refinementTurn(task, config);
        if (turn?.kind !== 'step' || turn.label !== label || this.midTurn(task)) return;
        const owners = turn.aiSetters
          .map((handle) => memberOf(config, handle))
          .filter((m): m is AiMemberConfig => m?.kind === 'ai');
        if (owners.length === 0) return;
        const workItem = { type: 'task', taskKey } as const;
        const text = stepText(task, turn);
        const working = owners.find((m) => this.sessions.findRunning(projectKey, m.handle, workItem));
        if (working) {
          this.delivery.notice(
            this.sessions.findRunning(projectKey, working.handle, workItem)!,
            'projectman',
            text,
            taskKey,
          );
          this.record(task, label, working.handle);
          this.handOverWaiting(projectKey, working.handle, workItem);
          return;
        }
        // Members on leave are not picked; when every owner is away, admission refuses the first.
        const present = owners.filter((m) => !isOnLeave(m));
        const candidates = present.length > 0 ? present : owners;
        const free = present
          .map((member) => ({ member, load: this.admission.memberLoad(config, member.handle, taskKey) }))
          .filter(({ member, load }) => load < member.capacity)
          .sort((a, b) => a.load - b.load)[0]?.member;
        const member = free ?? candidates[0]!;
        waitsFor = (free ?? (candidates.length === 1 ? candidates[0] : undefined))?.handle;
        await this.delivery.startAndDeliver(projectKey, member.handle, workItem, (messages) =>
          this.admission.start({
            config,
            member,
            workItem,
            messages: [...messages, formatInjectedTeamMessage('projectman', text, taskKey)],
            cause: { kind: 'refinement', label },
          }),
        );
        this.record(this.tasks.get(projectKey, taskKey), label, member.handle);
        this.handOverWaiting(projectKey, member.handle, workItem);
      },
    };
  }

  /**
   * The member's turn began: the messages that waited for it (PM-255) are typed into its session.
   * A session that was started took them in its first input already; this catches the ones that
   * came in after that and before the turn was recorded.
   */
  private handOverWaiting(projectKey: string, handle: string, workItem: { type: 'task'; taskKey: string }) {
    const session = this.sessions.findRunning(projectKey, handle, workItem);
    if (session) this.delivery.deliverWaiting(session);
  }

  /** Every label is on: `refine` goes, the card moves to the stage before development, people are told. */
  private async finish(config: ProjectConfig, task: Task, targetStageId: string | null): Promise<void> {
    const { projectKey, key: taskKey } = task;
    let changed = false;
    // Moved first: when a gate refuses, the card stays marked and is looked at again.
    if (targetStageId !== null && task.stageId !== targetStageId) {
      await this.tasks.moveToStage(projectKey, taskKey, targetStageId, SYSTEM_ACTOR);
      changed = true;
    }
    if (this.tasks.get(projectKey, taskKey).labels.includes(REFINE_LABEL)) {
      await this.tasks.changeLabels(projectKey, taskKey, { remove: [REFINE_LABEL] }, SYSTEM_ACTOR);
      changed = true;
    }
    // Nothing to change (the card stands in a refinement stage right before development, without
    // the label): the end of an earlier turn is still told, once.
    const latest = this.recorded(projectKey, taskKey);
    if (!changed && (!latest || latest.reason === 'done')) return;
    this.append(task, null, null, 'done');
    this.alert(config, task, null, 'done', []);
  }

  /**
   * Writes a change of turn: `label` (the step's) and its member. Not written
   * again for the same turn; false then. The reason is derived from the card: the earlier step's
   * label is on it now (`label_set`), or is not (`label_removed`: it went back).
   */
  private record(task: Task, label: string, member: string | null): boolean {
    const latest = this.recorded(task.projectKey, task.key);
    if (latest && latest.label === label && latest.member === member && latest.reason !== 'done')
      return false;
    const reason =
      !latest || latest.reason === 'done' || latest.label === null || latest.label === label
        ? 'started'
        : task.labels.includes(latest.label)
          ? 'label_set'
          : 'label_removed';
    this.append(task, label, member, reason);
    return true;
  }

  private append(
    task: Task,
    label: string | null,
    member: string | null,
    reason: 'started' | 'label_set' | 'label_removed' | 'done',
  ): void {
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor: SYSTEM_ACTOR,
      type: 'refinement_turn',
      data: { label, member, reason },
    });
  }

  private recorded(projectKey: string, taskKey: string): RecordedTurn | null {
    const event = this.timeline.latest(projectKey, taskKey, 'refinement_turn');
    if (!event) return null;
    const { label, member, reason } = event.data as Record<string, unknown>;
    return {
      label: typeof label === 'string' ? label : null,
      member: typeof member === 'string' ? member : null,
      reason: typeof reason === 'string' ? reason : 'started',
      at: event.createdAt,
    };
  }

  /** Whether a session of the card is in the middle of a turn. */
  private midTurn(task: Task): boolean {
    return this.sessions
      .list(task.projectKey, { taskKey: task.key })
      .some(
        (s) => this.sessions.isRunning(s.id) && (ENGAGED.has(s.state) || this.sessions.awaitsFirstTurn(s.id)),
      );
  }

  private alertsOf(task: Task): { item: InboxItem; payload: RefinementAlert }[] {
    return this.inbox.list(task.projectKey, { kind: 'alert', taskKey: task.key }).flatMap((item) => {
      const payload = alertPayloadOf(item);
      return payload?.alert === 'refinement' ? [{ item, payload }] : [];
    });
  }

  /** Whether the alert was raised since `since` (an ISO time), however it was answered. */
  private alerted(
    task: Task,
    reason: RefinementAlert['reason'],
    label: string | null,
    since: string,
  ): boolean {
    return this.alertsOf(task).some(
      ({ item, payload }) => payload.reason === reason && payload.label === label && item.createdAt >= since,
    );
  }

  /** The open alerts that wait for a step other than `label` are over: the step was done or the card moved on. */
  private closeAlerts(task: Task, label: string | null): void {
    for (const { item, payload } of this.alertsOf(task)) {
      if (item.state !== 'open' || payload.reason === 'done') continue;
      if (payload.label !== label) this.inbox.cancel(item.id);
    }
  }

  /** Raises an alert: for `manual_step`, to the people who may set the label; else to who prioritises. */
  private alert(
    config: ProjectConfig,
    task: Task,
    label: string | null,
    reason: RefinementAlert['reason'],
    setters: string[],
  ): void {
    const humans = (handles: string[]) =>
      handles.filter((handle) => memberOf(config, handle)?.kind === 'human');
    const prioritising = dutyMembers(config, 'prioritization')
      .filter((m) => m.kind === 'human')
      .map((m) => m.handle);
    const assignees = [
      humans(setters),
      reason === 'stalled' ? [...prioritising, ...ownerHandles(config)] : prioritising,
      ownerHandles(config),
    ].find((handles) => handles.length > 0);
    if (!assignees) return;
    const subject =
      reason === 'manual_step'
        ? `${task.key} waits for a person to set the label ${label}`
        : reason === 'stalled'
          ? `${task.key}: the turn for the label ${label} ended without it`
          : `${task.key} is worked out`;
    this.inbox.create({
      projectKey: task.projectKey,
      kind: 'alert',
      assignees: [...new Set(assignees)],
      source: 'system',
      taskKey: task.key,
      title: subject,
      payload: { alert: 'refinement', taskKey: task.key, label, reason } satisfies RefinementAlert,
      options: [ALERT_SEEN_OPTION],
    });
  }
}

/** What a member is told when it is its turn to set a step's label. */
function stepText(task: Task, step: Step): string {
  return (
    `Task ${task.key} is being worked out before development, one step at a time, and it is your turn: ` +
    `bring it to the point where label \`${step.label}\` is true, then set the label with update_task ` +
    '(add_labels). Do only this step; when it is done, end your turn. get_task shows the latest state. ' +
    'If you cannot go on, ask with ask_human instead of setting the label.'
  );
}
