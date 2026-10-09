import { isOpenTask, memberOf, quoteOf, sessionWorkItemOf } from '@projectman/shared';
import type { Actor, Session, Task, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import { requireAiMember } from '../access';
import type { MessageDelivery, MessageService } from '../messaging';
import type { ProjectService } from '../projects';
import type { SessionStartCause } from '../sessions';
import type { TaskService } from '../tasks';
import { unique } from '../util';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';

/**
 * Sessions that messages need: a member's general chat a person opens, and the wake-up of an
 * AI recipient of waiting messages. Both pass admission; a refused wake-up waits and is
 * retried while its messages wait (they stay in SQLite) and its task stays in that stage.
 */
export class MessageStarts {
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly admission: Admission;
  private readonly messages: MessageService;
  private readonly delivery: MessageDelivery;

  constructor(deps: {
    projects: ProjectService;
    tasks: TaskService;
    admission: Admission;
    messages: MessageService;
    delivery: MessageDelivery;
  }) {
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
      return (
        await this.admission.start({
          config,
          member,
          workItem: { type: 'general' },
          cause: { kind: 'conversation', by },
        })
      ).session;
    });
  }

  /**
   * An AI recipient of waiting messages has no running session for their work item: its session
   * starts or resumes through admission, then the messages are typed in (once each). A session
   * takes the waiting messages, in full, in its first input.
   */
  async wake(projectKey: string, handle: string, workItem: WorkItemRef): Promise<void> {
    await this.projects.config(projectKey);
    await this.admission.attempt(this.startFor(projectKey, handle, workItem));
  }

  /** A wake-up that was deferred when the server stopped, made again from what was stored. */
  rebuild(spec: Extract<StartSpec, { kind: 'message_wake' }>): AutomaticStart {
    return this.startFor(spec.projectKey, spec.handle, spec.workItem, spec.stageId ?? undefined);
  }

  async resumeAfterQuota(session: Session, stageId: string): Promise<void> {
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
      }),
    );
  }

  rebuildQuota(spec: Extract<StartSpec, { kind: 'provider_resume' }>): AutomaticStart {
    return this.quotaStartFor(spec);
  }

  private quotaStartFor(spec: Extract<StartSpec, { kind: 'provider_resume' }>): AutomaticStart {
    const { projectKey, taskKey, handle, stageId } = spec;
    const valid = (task: Task | null): boolean =>
      task?.status === 'active' && task.stageId === stageId && task.assignee === handle;
    const start: AutomaticStart = {
      key: `provider-resume:${projectKey}:${taskKey}:${handle}`,
      projectKey,
      taskKey,
      spec: () => spec,
      stillValid: valid,
      waitsFor: () => handle,
      retry: () => this.admission.attempt(start),
      log: {
        deferred: 'provider quota task resume deferred',
        retryFailed: 'provider quota task resume failed',
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
            'Your previous turn stopped because NanoGPT reached a provider limit. The hold has ended; continue your task from where you stopped.',
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
    const wi = encodeWorkItem(workItem);
    const taskKey = workItem.type === 'task' ? workItem.taskKey : null;
    /** The task's stage when the wake-up was tried: a move makes a waiting wake-up obsolete. */
    let triedIn = stageId;
    return {
      key: `message:${projectKey}:${handle}:${wi.type}:${wi.ref}`,
      projectKey,
      taskKey,
      spec: () => ({ kind: 'message_wake', projectKey, handle, workItem, stageId: triedIn ?? null }),
      stillValid: (task) => {
        const config = this.projects.cachedConfig(projectKey);
        return (
          !!config &&
          (task ? isOpenTask(task) && task.stageId === triedIn : taskKey === null) &&
          this.messages
            .waiting(projectKey, handle, workItem)
            .some((m) => this.messages.wakes(config, m, handle))
        );
      },
      waitsFor: () => handle,
      retry: () => this.wake(projectKey, handle, workItem),
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
        triedIn = task?.stageId;
        const waiting = this.messages.waiting(projectKey, handle, workItem);
        const first = waiting.find((message) => this.messages.wakes(config, message, handle));
        if (!first) return;
        const origin = first.origin;
        const cause: SessionStartCause = {
          kind:
            origin?.kind === 'note'
              ? 'mention'
              : origin?.kind === 'label'
                ? 'sent_back'
                : origin?.kind === 'answer'
                  ? 'answer'
                  : 'message',
          by: {
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
          this.admission.start({ config, member, workItem, messages, cause }),
        );
      },
    };
  }
}
