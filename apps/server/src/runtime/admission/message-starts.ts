import { assertIntegratorAccess, assertSuperMutation, SYSTEM_ACTOR } from '../../kernel';
import {
  hasGuestConversations,
  isOperator,
  managerConversationOf,
  memberOf,
  sessionWorkItemOf,
  stageOf,
} from '@projectman/shared';
import type { Actor, Session, Task, TaskStartWaiting, WorkItemRef } from '@projectman/shared';
import { requireAiMember } from '../../core/members';
import { DomainError } from '../../kernel';
import type { ProjectService } from '../../core/projects';
import { LIVE_SESSION_STATES } from '../sessions';
import type { TaskService } from '../../core/tasks';
import type { Admission } from './admission';
import type { AutomaticStart, StartSpec } from './deferred-starts';
import type { WorkStarts } from './work-starts';

/**
 * Sessions that people and providers need: a member's general chat a person opens, the admission preview of
 * an answer's recipient, and the continuation of a task after a provider quota or login. The wake-up of the
 * recipient of waiting messages is the member queue's (`runtime/member-queue`, PM-925).
 */
export class MessageStarts {
  private readonly ctx: import('../../core/base').DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly admission: Admission;
  private readonly workStarts: WorkStarts;

  constructor(deps: {
    ctx: import('../../core/base').DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    admission: Admission;
    workStarts: WorkStarts;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.admission = deps.admission;
    this.workStarts = deps.workStarts;
  }

  /** Release the interrupted implementer's card through the existing handoff and work-start paths. */
  async reassignAfterQuota(session: Session, stageId: string): Promise<void> {
    if (session.workItem.type !== 'task') return;
    const config = await this.projects.config(session.projectKey);
    if (stageOf(config, stageId)?.kind !== 'work') return;
    const task = this.tasks.find(session.projectKey, session.workItem.taskKey);
    if (!task || task.status !== 'active' || task.stageId !== stageId || task.assignee !== session.member)
      return;
    const unassigned = this.tasks.assign(session.projectKey, task.key, null, SYSTEM_ACTOR, {
      reason: 'handover',
      handoff: 'provider_quota',
    });
    // Automatic selection excludes the held provider, including the previous implementer.
    // WorkStarts also persists the wait when nobody else can take it or the handoff is still open.
    await this.workStarts.begin({ task: unassigned, from: stageId, to: stageId, actor: SYSTEM_ACTOR });
  }

  /** The member's general chat: the running one, else one admission allows now. */
  async startConversation(projectKey: string, handle: string, by?: Actor): Promise<Session> {
    return this.admission.exclusive(async () => {
      const config = await this.projects.config(projectKey);
      const member = requireAiMember(config, handle);
      assertIntegratorAccess(config, 'write', by);
      assertSuperMutation(config, { kind: 'runtime_start', providers: [member.provider ?? 'claude'] }, by);
      // The Operator and the PM talk with each person in a conversation of their own (PM-475, PM-1080);
      // only the Operator's owners' one stays outside the capacity.
      const workItem: WorkItemRef =
        hasGuestConversations(config, member) && by?.kind === 'human' && by.handle
          ? managerConversationOf(config, by.handle)
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
}

/** The code a failed start is reported with: the DomainError's, else `start_failed` (PM-543). */
function errorCodeOf(err: unknown): string {
  return err instanceof DomainError ? err.code : 'start_failed';
}
