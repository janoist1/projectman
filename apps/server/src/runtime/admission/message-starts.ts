import { assertIntegratorAccess, assertSuperMutation } from '../../kernel';
import {
  hasSuperOrigin,
  isOpenTask,
  isOperator,
  memberOf,
  operatorConversationOf,
  quoteOf,
  sessionWorkItemOf,
} from '@projectman/shared';
import type { Actor, Session, Task, TaskStartWaiting, WorkItemRef } from '@projectman/shared';
import type { WakeStart } from '../../contracts';
import { encodeWorkItem } from '../../db';
import { requireAiMember } from '../../core/members';
import { isoNow } from '../../core/base';
import { DomainError } from '../../kernel';
import type { MessageService } from '../../core/messages';
import type { MessageDelivery } from '../delivery';
import type { ProjectService } from '../../core/projects';
import { LIVE_SESSION_STATES } from '../sessions';
import type { SessionStartCause } from '../sessions';
import type { TaskService } from '../../core/tasks';
import { unique } from '../../kernel';
import type { Admission, AttemptOutcome } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';

/**
 * Sessions that messages need: a member's general chat a person opens, and the wake-up of an
 * AI recipient of waiting messages. Both pass admission; a refused wake-up waits and is
 * retried while its messages wait (they stay in SQLite). Answers and forwarded questions follow
 * their open card across stage changes; ordinary messages expire when the stage changes.
 */
export class MessageStarts {
  private readonly ctx: import('../../core/base').DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly admission: Admission;
  private readonly messages: MessageService;
  private readonly delivery: MessageDelivery;
  /** The last failed wake-up per start key since the server started (PM-543); a success clears it. */
  private readonly failures = new Map<string, { code: string; at: string }>();

  constructor(deps: {
    ctx: import('../../core/base').DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    admission: Admission;
    messages: MessageService;
    delivery: MessageDelivery;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.admission = deps.admission;
    this.messages = deps.messages;
    this.delivery = deps.delivery;
  }

  /** The member's general chat: the running one, else one admission allows now. */
  async startConversation(projectKey: string, handle: string, by?: Actor): Promise<Session> {
    return this.admission.exclusive(async () => {
      const config = await this.projects.config(projectKey);
      const member = requireAiMember(config, handle);
      assertIntegratorAccess(config, 'write', by);
      assertSuperMutation(config, { kind: 'runtime_start', providers: [member.provider ?? 'claude'] }, by);
      // The Operator talks with each person in a conversation of their own (PM-475); only the
      // owners' one stays outside the capacity.
      const workItem: WorkItemRef =
        isOperator(member) && by?.kind === 'human' && by.handle
          ? operatorConversationOf(config, by.handle)
          : { type: 'general' };
      return (
        await this.admission.start({
          config,
          member,
          workItem,
          cause: { kind: 'conversation', by },
          ...(isOperator(member) && !('with' in workItem) ? { capacity: false } : {}),
        })
      ).session;
    });
  }

  /**
   * An AI recipient of waiting messages has no running session for their work item: its session
   * starts or resumes through admission, then the messages are typed in (once each). A session
   * takes the waiting messages, in full, in its first input.
   */
  async wake(projectKey: string, handle: string, workItem: WorkItemRef): Promise<WakeStart> {
    try {
      const outcome = await this.attemptWake(projectKey, handle, workItem);
      if (outcome.kind === 'deferred') return { state: 'waiting', reason: outcome.waiting.reason };
      // The attempt ran: the member has a live session on this path, or nothing was started.
      const config = await this.projects.config(projectKey);
      const session = this.ctx.repos.sessions.findByWorkItem(
        projectKey,
        handle,
        sessionWorkItemOf(memberOf(config, handle), workItem),
      );
      return session && LIVE_SESSION_STATES.includes(session.state)
        ? { state: 'started', sessionId: session.id }
        : { state: 'failed', code: 'not_started' };
    } catch (err) {
      this.ctx.logger.warn({ err, projectKey, member: handle }, 'team message session start failed');
      return { state: 'failed', code: errorCodeOf(err) };
    }
  }

  /** One admission attempt of the wake-up; a failure is remembered (`lastFailure`) and thrown. */
  private async attemptWake(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<AttemptOutcome> {
    await this.projects.config(projectKey);
    const start = this.startFor(projectKey, handle, workItem);
    try {
      const outcome = await this.admission.attempt(start);
      if (outcome.kind === 'deferred') {
        for (const message of this.messages.waiting(projectKey, handle, workItem))
          this.messages.recordAnswerDelivery(message, handle, {
            state: 'waiting',
            reason: outcome.waiting.reason,
            since: outcome.waiting.since,
          });
      }
      if (outcome.kind === 'done') this.failures.delete(start.key);
      return outcome;
    } catch (err) {
      this.failures.set(start.key, { code: errorCodeOf(err), at: isoNow(this.ctx) });
      throw err;
    }
  }

  /** Admission preview for an answer's recipient, without starting or deferring work. */
  async waitingReason(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): Promise<TaskStartWaiting['reason'] | null> {
    const config = await this.projects.config(projectKey);
    const member = memberOf(config, handle);
    if (member?.kind !== 'ai') return null;
    workItem = sessionWorkItemOf(member, workItem);
    const session = this.ctx.repos.sessions.findByWorkItem(projectKey, handle, workItem);
    const running = session && LIVE_SESSION_STATES.includes(session.state);
    try {
      await this.admission.check({
        config,
        member,
        workItem,
        ...(isOperator(member) && !(workItem.type === 'general' && workItem.with) ? { capacity: false } : {}),
      });
      return null;
    } catch (err) {
      const code = errorCodeOf(err);
      // Typing into a live session bypasses start admission, but still waits for provider cooldowns.
      if (running && code !== 'provider_rate_limited') return null;
      const reasons = [
        'member_on_leave',
        'plan_usage_paused',
        'provider_rate_limited',
        'member_at_capacity',
        'ai_limit_reached',
        'team_paused',
      ] as const;
      return reasons.find((reason) => reason === code) ?? null;
    }
  }

  /**
   * The last failed wake-up of the member's start on `workItem` since the server started, or null
   * (PM-543). A success clears it; it is not stored.
   */
  lastFailure(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
  ): { code: string; at: string } | null {
    return this.failures.get(this.wakeKey(projectKey, handle, workItem)) ?? null;
  }

  /** The key of the member's wake-up on `workItem` in the deferred starts (`DeferredStarts`). */
  wakeKey(projectKey: string, handle: string, workItem: WorkItemRef): string {
    const config = this.projects.cachedConfig(projectKey);
    const wi = encodeWorkItem(sessionWorkItemOf(config ? memberOf(config, handle) : undefined, workItem));
    return `message:${projectKey}:${handle}:${wi.type}:${wi.ref}`;
  }

  /** A wake-up that was deferred when the server stopped, made again from what was stored. */
  rebuild(spec: Extract<StartSpec, { kind: 'message_wake' }>): AutomaticStart {
    return this.startFor(spec.projectKey, spec.handle, spec.workItem, spec.stageId ?? undefined);
  }

  /** The task of an interrupted session continues once its provider allows it again (quota, or login). */
  async resumeAfter(session: Session, stageId: string, after: 'quota' | 'login'): Promise<void> {
    if (session.workItem.type !== 'task') return;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || task.status !== 'active' || task.stageId !== stageId || task.assignee !== session.member)
      return;
    await this.admission.attempt(
      this.quotaStartFor({
        kind: 'provider_resume',
        projectKey: session.projectKey,
        taskKey: task.key,
        handle: session.member,
        stageId,
        after,
      }),
    );
  }

  rebuildQuota(spec: Extract<StartSpec, { kind: 'provider_resume' }>): AutomaticStart {
    return this.quotaStartFor(spec);
  }

  private quotaStartFor(spec: Extract<StartSpec, { kind: 'provider_resume' }>): AutomaticStart {
    const { projectKey, taskKey, handle, stageId } = spec;
    const after = spec.after ?? 'quota';
    const valid = (task: Task | null): boolean =>
      task?.status === 'active' && task.stageId === stageId && task.assignee === handle;
    const start: AutomaticStart = {
      key: `provider-resume:${projectKey}:${taskKey}:${handle}`,
      projectKey,
      taskKey,
      spec: () => spec,
      stillValid: valid,
      waitsFor: () => handle,
      retry: async () => {
        await this.admission.attempt(start);
      },
      log: {
        deferred: `provider ${after} task resume deferred`,
        retryFailed: `provider ${after} task resume failed`,
        fields: () => ({ projectKey, taskKey, member: handle }),
      },
      run: async () => {
        if (!valid(this.tasks.find(projectKey, taskKey))) return;
        const config = await this.projects.config(projectKey);
        const member = memberOf(config, handle);
        if (member?.kind !== 'ai') return;
        await this.admission.start({
          config,
          member,
          workItem: { type: 'task', taskKey },
          messages: [
            after === 'login'
              ? 'Your previous turn stopped because the provider login was lost. The login is back; continue your task from where you stopped.'
              : 'Your previous turn stopped because NanoGPT reached a provider limit. The hold has ended; continue your task from where you stopped.',
          ],
          cause: { kind: 'provider_resume' },
        });
      },
    };
    return start;
  }

  /** `stageId`: the task's stage when the wake-up was tried before (the stored one, when rebuilt). */
  private startFor(
    projectKey: string,
    handle: string,
    workItem: WorkItemRef,
    stageId?: string,
  ): AutomaticStart {
    const config = this.projects.cachedConfig(projectKey);
    workItem = sessionWorkItemOf(config ? memberOf(config, handle) : undefined, workItem);
    const taskKey = workItem.type === 'task' ? workItem.taskKey : null;
    /** Ordinary messages expire on a move; answers and forwarded questions survive it. */
    let triedIn = stageId;
    const survivesMove = () =>
      this.messages
        .waiting(projectKey, handle, workItem)
        .some((m) => m.origin?.kind === 'answer' || m.origin?.kind === 'question_forward');
    return {
      key: this.wakeKey(projectKey, handle, workItem),
      projectKey,
      taskKey,
      spec: () => ({ kind: 'message_wake', projectKey, handle, workItem, stageId: triedIn ?? null }),
      stillValid: (task) => {
        const config = this.projects.cachedConfig(projectKey);
        if (task && isOpenTask(task) && survivesMove()) triedIn = task.stageId;
        return (
          !!config &&
          (task ? isOpenTask(task) && task.stageId === triedIn : taskKey === null) &&
          this.messages
            .waiting(projectKey, handle, workItem)
            .some((m) => this.messages.wakes(config, m, handle))
        );
      },
      waitsFor: () => handle,
      retry: async () => {
        await this.attemptWake(projectKey, handle, workItem);
      },
      log: {
        deferred: 'team message start deferred',
        retryFailed: 'team message start retry failed',
        fields: () => ({ projectKey, member: handle }),
      },
      run: async () => {
        const config = await this.projects.config(projectKey);
        const member = memberOf(config, handle);
        if (member?.kind !== 'ai') return;
        const task = taskKey ? this.tasks.get(projectKey, taskKey) : null;
        if (task && !isOpenTask(task)) return;
        if (task && triedIn !== undefined && task.stageId !== triedIn && !survivesMove()) return;
        triedIn = task?.stageId;
        const waiting = this.messages.waiting(projectKey, handle, workItem);
        const first = waiting.find((message) => this.messages.wakes(config, message, handle));
        if (!first) return;
        const origin = first.origin;
        const mergeEvent =
          origin?.kind === 'note' && first.from === 'system'
            ? this.ctx.repos.timeline.get(projectKey, origin.eventId)
            : null;
        const cause: SessionStartCause = {
          kind: mergeEvent?.type.startsWith('task_merge_')
            ? 'merge'
            : origin?.kind === 'note'
              ? 'mention'
              : origin?.kind === 'label'
                ? 'sent_back'
                : origin?.kind === 'answer'
                  ? 'answer'
                  : 'message',
          by:
            hasSuperOrigin(first.actor) && first.actor.handle === first.from
              ? first.actor
              : {
                  kind: memberOf(config, first.from)?.kind ?? 'system',
                  handle: first.from,
                  ...(first.via ? { via: first.via } : {}),
                },
          messageId: first.id,
          ...(origin?.kind === 'note' ? { eventId: origin.eventId } : {}),
          ...(origin?.kind === 'label'
            ? { labels: origin.labels, eventId: origin.eventId }
            : { quote: quoteOf(first.answer?.answer ?? first.body) }),
          ...(origin?.kind === 'answer' ? { inboxItemId: origin.inboxItemId } : {}),
        };
        await this.delivery.startAndDeliver(projectKey, handle, workItem, (messages) =>
          this.admission.start({
            config,
            member,
            workItem,
            messages,
            cause,
            // The owners' conversation with the Operator never waits behind another person's (PM-475).
            ...(isOperator(member) && !(workItem.type === 'general' && workItem.with)
              ? { capacity: false }
              : {}),
          }),
        );
      },
    };
  }
}

/** The code a failed start is reported with: the DomainError's, else `start_failed` (PM-543). */
function errorCodeOf(err: unknown): string {
  return err instanceof DomainError ? err.code : 'start_failed';
}
