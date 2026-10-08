import {
  LOOP_LET_RUN_OPTION,
  LOOP_STOP_OPTION,
  countsForLoop,
  findLoop,
  formatInjectedTeamMessage,
  isOpenTask,
  isTheme,
  loopDecisionOf,
  loopDeciders,
  loopWatchOf,
  loopWatchers,
  memberOf,
} from '@projectman/shared';
import type {
  AiMemberConfig,
  InboxItem,
  LoopDecisionPayload,
  LoopFinding,
  LoopTalk,
  ProjectConfig,
  Task,
  TimelineEvent,
  TimelineEventData,
} from '@projectman/shared';
import type { TaskLoopRecord } from '../db';
import { ownerHandles } from './access';
import type { Admission, AutomaticStart, StartSpec } from './admission';
import { isoNow } from './context';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { MessageDelivery } from './messaging';
import type { ConfigChange, ProjectService } from './projects';
import type { SessionOrchestrator } from './sessions';
import type { TaskService } from './tasks';
import type { TimelineService } from './timeline';
import { KeyedMutex, SYSTEM_ACTOR, humanActor, newId } from './util';

/** The most entries of a card read at once: far more than a threshold (50 at most) needs. */
const TALK_LIMIT = 1000;
const MINUTE_MS = 60_000;

type EndReason = NonNullable<TimelineEventData['task_loop']['endReason']>;

/**
 * The loop watch (PM-261, replacing the message storm alert of PM-186). AI members writing to each
 * other on a card with no progress in between (no stage change, label change or commit) are a loop
 * (`findLoop` in `packages/shared`). The first to hear of it is the AI member who holds the
 * scheduling duty: it gets a system message (not stored as a team message) asking it to read the
 * conversation and tell the participants the next step and who decides. A notice that admission only
 * makes wait (the AI limit, the member's capacity, ...) is kept and retried like any automatic start,
 * and the loop counts a going-on from its delivery. When nobody holds the duty, or admission refuses
 * the notice for good, or the loop goes on after it was told (as many counted messages again),
 * the people who decide get a decision item: stop the card's AI work, or let it run. A loop closes
 * itself when it is over: the card moved on, its labels changed, its branch got a commit, nobody
 * wrote for a whole window, or the watch was switched off; its item then closes by the system.
 */
export class LoopWatch {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly sessions: SessionOrchestrator;
  private readonly admission: Admission;
  private readonly delivery: MessageDelivery;
  private readonly inbox: InboxService;
  private readonly timeline: TimelineService;
  /** One look at a card at a time, so that two messages do not raise the same loop twice. */
  private readonly cards = new KeyedMutex();

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    sessions: SessionOrchestrator;
    admission: Admission;
    delivery: MessageDelivery;
    inbox: InboxService;
    timeline: TimelineService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.sessions = deps.sessions;
    this.admission = deps.admission;
    this.delivery = deps.delivery;
    this.inbox = deps.inbox;
    this.timeline = deps.timeline;
  }

  /*
   * The listeners below return nothing when there is nothing to do: the domain events wait for a
   * listener that returns a promise before they run the next one, so a promise on every stage or
   * label change would delay the listeners registered after these.
   */

  /** After a message or a note was recorded on a card: only a team message can start or feed a loop. */
  check(event: TimelineEvent): Promise<void> | void {
    const { projectKey, taskKey } = event;
    if (!taskKey || event.type !== 'team_message' || !event.actor.handle) return;
    return this.cards.run(taskKey, () => this.looked(projectKey, taskKey, event));
  }

  /** The card changed stage, its labels changed or it closed: its loop is over. */
  progressed(
    task: Pick<Task, 'projectKey' | 'key'>,
    reason: 'stage' | 'label' | 'closed',
  ): Promise<void> | void {
    if (!this.ctx.repos.taskLoops.open(task.key)) return;
    return this.cards.run(task.key, async () => {
      const loop = this.ctx.repos.taskLoops.open(task.key);
      if (loop) this.end(loop, reason);
    });
  }

  /** The watch was switched off for the project: its open loops close. */
  configChanged(change: ConfigChange): Promise<void> | void {
    if (loopWatchOf(change.next.team.limits).enabled) return;
    return this.sweep(change.projectKey);
  }

  /** A person answered a loop's decision item. */
  decided(item: InboxItem): Promise<void> | void {
    const payload = loopDecisionOf(item);
    if (!payload || !item.taskKey || item.resolution?.rule === 'loop_ended') return;
    return this.cards.run(item.taskKey, async () => {
      const loop = this.ctx.repos.taskLoops.get(payload.loopId);
      if (!loop || loop.endedAt) return;
      const by = item.resolution?.by ?? 'system';
      if (item.resolution?.optionId === LOOP_STOP_OPTION.id) {
        await this.sessions.stopTask(loop.projectKey, loop.taskKey, {
          kind: 'loop_stopped',
          ...(by !== 'system' ? { by: humanActor(by) } : {}),
        });
        this.end(loop, 'stopped', by);
      } else if (item.resolution?.optionId === LOOP_LET_RUN_OPTION.id) {
        this.letRun(loop, by);
      }
    });
  }

  /**
   * Looks at every open loop: the ones whose card closed, whose watch was switched off, whose branch
   * got a commit or that went quiet end. With `projectKey` only that project's loops are looked at.
   */
  async sweep(projectKey?: string): Promise<void> {
    for (const loop of this.ctx.repos.taskLoops.listOpen(projectKey)) {
      try {
        await this.cards.run(loop.taskKey, () => this.sweepLoop(loop.id));
      } catch (err) {
        this.ctx.logger.warn({ err, taskKey: loop.taskKey }, 'could not check the loop on a card');
      }
    }
  }

  private async sweepLoop(loopId: string): Promise<void> {
    const loop = this.ctx.repos.taskLoops.get(loopId);
    if (!loop || loop.endedAt) return;
    const config = this.projects.cachedConfig(loop.projectKey);
    const task = this.tasks.find(loop.projectKey, loop.taskKey);
    if (!task || !isOpenTask(task)) return this.end(loop, 'closed');
    if (!config) return;
    const watch = loopWatchOf(config.team.limits);
    if (!watch.enabled) return this.end(loop, 'disabled');
    const head = await this.sessions.sourceHead(config, task);
    if (head && head.commit !== loop.headCommit) return this.end(loop, 'commit');
    if (this.ctx.now().getTime() - Date.parse(loop.lastMessageAt) >= watch.minutes * MINUTE_MS)
      this.end(loop, 'quiet');
  }

  private async looked(projectKey: string, taskKey: string, event: TimelineEvent): Promise<void> {
    const config = this.projects.cachedConfig(projectKey);
    if (!config) return;
    const watch = loopWatchOf(config.team.limits);
    const task = this.tasks.find(projectKey, taskKey);
    if (!watch.enabled || !task || !isOpenTask(task) || isTheme(task)) return;
    const talk = talkOf(event);
    const open = this.ctx.repos.taskLoops.open(taskKey);
    if (open) return this.feed(config, task, open, talk, event.createdAt);
    if (!countsForLoop(config, talk, [])) return;
    const found = await this.find(config, task, watch);
    if (found) await this.raise(config, task, found.finding, found.head);
  }

  /** A counted message of a card whose loop is open: the loop grows, and may reach the people. */
  private feed(config: ProjectConfig, task: Task, loop: TaskLoopRecord, talk: LoopTalk, at: string): void {
    const ignore = loop.phase === 'notified' && loop.notified ? [loop.notified] : [];
    if (!countsForLoop(config, talk, ignore)) return;
    const grown: TaskLoopRecord = {
      ...loop,
      count: loop.count + 1,
      lastMessageAt: at,
      members: [...new Set([...loop.members, talk.from, ...talk.to])].sort(),
    };
    const watch = loopWatchOf(config.team.limits);
    // Counted from the delivery of the notice: while admission keeps it waiting, nothing was told yet.
    if (
      grown.phase === 'notified' &&
      grown.notifiedCount > 0 &&
      grown.count - grown.notifiedCount >= watch.count
    ) {
      this.escalate(config, task, grown, 'continued');
      return;
    }
    this.ctx.repos.taskLoops.save(grown);
    this.tasks.publish(task);
  }

  /** The loop the card's conversation makes now, with the head of its branch that was read; null when none. */
  private async find(
    config: ProjectConfig,
    task: Task,
    watch: ReturnType<typeof loopWatchOf>,
  ): Promise<{ finding: LoopFinding; head: string | null } | null> {
    const now = isoNow(this.ctx);
    const since = this.progressPoint(task, null);
    const first = this.findSince(config, task, since, now, watch);
    if (!first) return null;
    // The head of the branch is read only for a candidate: a commit later than the last progress is progress.
    const head = await this.sessions.sourceHead(config, task);
    const committed = head?.committedAt ?? null;
    if (committed === null || committed <= since) return { finding: first, head: head?.commit ?? null };
    const again = this.findSince(config, task, this.progressPoint(task, committed), now, watch);
    return again ? { finding: again, head: head?.commit ?? null } : null;
  }

  private findSince(
    config: ProjectConfig,
    task: Task,
    since: string,
    now: string,
    watch: ReturnType<typeof loopWatchOf>,
  ): LoopFinding | null {
    const from = new Date(Math.max(Date.parse(since), Date.parse(now) - watch.minutes * MINUTE_MS));
    const talk = this.ctx.repos.timeline
      .talkSince(task.projectKey, task.key, from.toISOString(), TALK_LIMIT)
      .filter((entry) => entry.type === 'team_message')
      .map(talkOf)
      .filter((entry) => countsForLoop(config, entry, []));
    return findLoop(talk, since, now, watch);
  }

  /** The last progress on the card: a stage or label change, a commit (when read), the end of an earlier loop. */
  private progressPoint(task: Task, committedAt: string | null): string {
    const times = [
      task.createdAt,
      this.timeline.latest(task.projectKey, task.key, 'task_stage_changed')?.createdAt,
      this.timeline.latest(task.projectKey, task.key, 'task_labels_changed')?.createdAt,
      this.ctx.repos.taskLoops.lastEndedAt(task.key),
      committedAt,
    ].filter((time): time is string => typeof time === 'string');
    return times.reduce((latest, time) => (Date.parse(time) > Date.parse(latest) ? time : latest));
  }

  /** A loop was found: the card gets it, and the member who holds the scheduling duty is told. */
  private async raise(
    config: ProjectConfig,
    task: Task,
    finding: LoopFinding,
    headCommit: string | null,
  ): Promise<void> {
    const watcher = loopWatchers(config, finding.members)[0];
    const told = watcher && memberOf(config, watcher)?.kind === 'ai' ? watcher : null;
    const record: TaskLoopRecord = {
      id: newId('loop'),
      projectKey: task.projectKey,
      taskKey: task.key,
      startedAt: finding.startedAt,
      raisedAt: isoNow(this.ctx),
      lastMessageAt: finding.lastMessageAt,
      members: finding.members,
      count: finding.count,
      notified: told,
      notifiedCount: 0,
      phase: 'notified',
      ownerReason: null,
      deciders: [],
      inboxItemId: null,
      headCommit,
      endedAt: null,
      endReason: null,
      letRunBy: null,
    };
    this.ctx.repos.taskLoops.create(record);
    this.tasks.publish(task);
    if (told) await this.deliver(record.id);
    else this.escalate(config, task, record, 'no_watcher');
  }

  /**
   * The watcher of a loop whose notice is still to be delivered gets it. Admission may make the
   * start wait (the AI limit, the member's capacity, paused plan usage, low disk space): the loop
   * stays with the watcher then, and the notice is retried like any automatic start. Only a refusal
   * that no retry can overcome sends the loop to the people, as if nobody held the duty.
   * Runs under the card's lock.
   */
  private async deliver(loopId: string): Promise<void> {
    const loop = this.ctx.repos.taskLoops.get(loopId);
    const task = loop && this.tasks.find(loop.projectKey, loop.taskKey);
    if (!loop || !task || !isOpenTask(task) || !noticePending(loop)) return;
    let told = false;
    const start = this.noticeStart(loop, () => {
      told = true;
    });
    try {
      await this.admission.attempt(start);
    } catch (err) {
      this.ctx.logger.warn(
        { err, taskKey: task.key, watcher: loop.notified },
        'could not tell the loop watcher',
      );
      const config = this.projects.cachedConfig(loop.projectKey);
      if (config) this.escalate(config, task, { ...loop, notified: null }, 'no_watcher');
      return;
    }
    if (told) this.told(task, loopId);
  }

  /** The notice reached its watcher: the loop counts a going-on from here. */
  private told(task: Task, loopId: string): void {
    const loop = this.ctx.repos.taskLoops.get(loopId);
    if (!loop || loop.endedAt) return;
    const notified: TaskLoopRecord = { ...loop, notifiedCount: loop.count };
    this.ctx.repos.taskLoops.save(notified);
    this.record(task, notified, 'raised', { notified: notified.notified });
    this.tasks.publish(task);
  }

  /** A notice that was deferred when the server stopped, made again from what was stored. */
  rebuild(spec: Extract<StartSpec, { kind: 'loop_notice' }>): AutomaticStart | null {
    const loop = this.ctx.repos.taskLoops.get(spec.loopId);
    return loop && !loop.endedAt ? this.noticeStart(loop, () => undefined) : null;
  }

  /** The automatic start that tells the watcher; `onTold` is called once it was delivered. */
  private noticeStart(loop: TaskLoopRecord, onTold: () => void): AutomaticStart {
    const { projectKey, taskKey, id: loopId } = loop;
    const watcher = loop.notified ?? '';
    return {
      key: `loop:${loopId}`,
      projectKey,
      taskKey,
      spec: () => ({ kind: 'loop_notice', projectKey, taskKey, loopId, watcher }),
      stillValid: (task) => {
        const current = this.ctx.repos.taskLoops.get(loopId);
        return task !== null && isOpenTask(task) && current !== null && noticePending(current);
      },
      waitsFor: () => watcher,
      retry: () => this.cards.run(taskKey, () => this.deliver(loopId)),
      log: {
        deferred: 'loop notice start deferred',
        retryFailed: 'loop notice start retry failed',
        fields: () => ({ taskKey, watcher }),
      },
      run: async () => {
        const current = this.ctx.repos.taskLoops.get(loopId);
        const task = this.tasks.find(projectKey, taskKey);
        if (!current || !noticePending(current) || !task || !isOpenTask(task)) return;
        const config = await this.projects.config(projectKey);
        const member = memberOf(config, watcher);
        if (member?.kind !== 'ai') throw new Error(`loop watcher ${watcher} is not an AI member`);
        const workItem = { type: 'task', taskKey } as const;
        const text = noticeText(taskKey, current, loopWatchOf(config.team.limits).minutes);
        const running = this.sessions.findRunning(projectKey, watcher, workItem);
        // A paused session takes nothing in: admission refuses with `team_paused` and the notice waits.
        if (running && !this.sessions.isPaused(running)) {
          this.delivery.notice(running, 'projectman', text, taskKey);
        } else {
          await this.delivery.startAndDeliver(projectKey, watcher, workItem, (messages) =>
            this.admission.start({
              config,
              member: member as AiMemberConfig,
              workItem,
              cause: {
                kind: 'loop',
                loopId,
                eventId: this.timeline.latest(projectKey, taskKey, 'task_loop')?.id,
              },
              messages: [...messages, formatInjectedTeamMessage('projectman', text, taskKey)],
            }),
          );
        }
        onTold();
      },
    };
  }

  /** The loop goes to the people who decide: one decision item, stop the work or let it run. */
  private escalate(
    config: ProjectConfig,
    task: Task,
    loop: TaskLoopRecord,
    reason: 'no_watcher' | 'continued',
  ): void {
    const deciders = loopDeciders(config, ownerHandles(config));
    const watch = loopWatchOf(config.team.limits);
    const payload: LoopDecisionPayload = {
      loopId: loop.id,
      taskKey: task.key,
      members: loop.members,
      count: loop.count,
      minutes: watch.minutes,
      startedAt: loop.startedAt,
      reason,
      watcher: loop.notified,
    };
    const item =
      deciders.length > 0
        ? this.inbox.create({
            projectKey: task.projectKey,
            kind: 'decision',
            assignees: deciders,
            source: 'system',
            taskKey: task.key,
            title: `Loop on ${task.key}: ${loop.members.join(', ')}`,
            payload: { loop: payload },
            options: [LOOP_STOP_OPTION, LOOP_LET_RUN_OPTION],
          })
        : null;
    const escalated: TaskLoopRecord = {
      ...loop,
      phase: 'owner',
      ownerReason: reason,
      deciders,
      inboxItemId: item?.id ?? null,
    };
    // A row that was just created is saved too: `save` only writes fields that change over a loop's life.
    this.ctx.repos.taskLoops.save(escalated);
    this.record(task, escalated, reason === 'continued' ? 'escalated' : 'raised', {
      notified: loop.notified,
      deciders,
      reason,
    });
    this.tasks.publish(task);
  }

  /** A person let the loop run: it stays open, with no more items. */
  private letRun(loop: TaskLoopRecord, by: string): void {
    const task = this.tasks.find(loop.projectKey, loop.taskKey);
    const letRun: TaskLoopRecord = { ...loop, phase: 'let_run', letRunBy: by };
    this.ctx.repos.taskLoops.save(letRun);
    if (!task) return;
    this.record(task, letRun, 'let_run', { by });
    this.tasks.publish(task);
  }

  /** The loop is over: its row closes, its decision item closes by the system, the card is published again. */
  private end(loop: TaskLoopRecord, reason: EndReason, by?: string): void {
    const task = this.tasks.find(loop.projectKey, loop.taskKey);
    this.ctx.unitOfWork(() => {
      this.ctx.repos.taskLoops.close(loop.id, isoNow(this.ctx), reason);
      if (loop.inboxItemId) this.inbox.resolveByRule(loop.inboxItemId, 'ended', 'loop_ended');
      this.timeline.append({
        projectKey: loop.projectKey,
        taskKey: loop.taskKey,
        actor: SYSTEM_ACTOR,
        type: 'task_loop',
        data: {
          loopId: loop.id,
          phase: 'ended',
          members: loop.members,
          count: loop.count,
          minutes: this.minutesOf(loop.projectKey),
          endReason: reason,
          ...(by ? { by } : {}),
        },
      });
    });
    if (task) this.tasks.publish(task);
  }

  private minutesOf(projectKey: string): number {
    const config = this.projects.cachedConfig(projectKey);
    return loopWatchOf(config?.team.limits).minutes;
  }

  private record(
    task: Pick<Task, 'projectKey' | 'key'>,
    loop: TaskLoopRecord,
    phase: 'raised' | 'escalated' | 'let_run',
    extra: {
      notified?: string | null;
      deciders?: string[];
      reason?: 'no_watcher' | 'continued';
      by?: string;
    },
  ): void {
    this.timeline.append({
      projectKey: task.projectKey,
      taskKey: task.key,
      actor: SYSTEM_ACTOR,
      type: 'task_loop',
      data: {
        loopId: loop.id,
        phase,
        members: loop.members,
        count: loop.count,
        minutes: this.minutesOf(task.projectKey),
        ...extra,
      },
    });
  }
}

/** Whether the watcher of a loop is still to be told (admission may keep the notice waiting). */
function noticePending(loop: TaskLoopRecord): boolean {
  return !loop.endedAt && loop.phase === 'notified' && loop.notified !== null && loop.notifiedCount === 0;
}

/** A team message of a card as the rule reads it. */
function talkOf(event: TimelineEvent): LoopTalk {
  const to = Array.isArray(event.data.to)
    ? event.data.to.filter((t): t is string => typeof t === 'string')
    : [];
  return { at: event.createdAt, from: event.actor.handle ?? '', to };
}

/** What the member who holds the scheduling duty is told. */
function noticeText(taskKey: string, loop: TaskLoopRecord, minutes: number): string {
  return [
    `${loop.members.join(', ')} have written ${loop.count} messages to each other on ${taskKey} in the last ${minutes} minutes,`,
    'with no stage change, label change or commit in between: they may be going round in circles.',
    `Read the conversation on ${taskKey}, then write once to the participants: what the next step is and who decides it.`,
    'Do not write to people about it; if a person has to decide, say so on the card.',
    'What you write does not count as part of the loop.',
  ].join(' ');
}
