import { isOpenTask, memberOf } from '@projectman/shared';
import type { Session, WorkItemRef } from '@projectman/shared';
import { encodeWorkItem } from '../../db';
import { requireAiMember } from '../access';
import type { MessageDelivery, MessageService } from '../messaging';
import type { ProjectService } from '../projects';
import type { TaskService } from '../tasks';
import type { Admission } from './admission';

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
  async startConversation(projectKey: string, handle: string): Promise<Session> {
    return this.admission.exclusive(async () => {
      const config = await this.projects.config(projectKey);
      const member = requireAiMember(config, handle);
      return (await this.admission.start({ config, member, workItem: { type: 'general' } })).session;
    });
  }

  /**
   * An AI recipient of waiting messages has no running session for their work item: its session
   * starts or resumes through admission, then the messages are typed in (once each).
   */
  async wake(projectKey: string, handle: string, workItem: WorkItemRef): Promise<void> {
    const wi = encodeWorkItem(workItem);
    const taskKey = workItem.type === 'task' ? workItem.taskKey : null;
    /** The task's stage when the wake-up was tried: a move makes a waiting wake-up obsolete. */
    let stageId: string | undefined;
    await this.admission.attempt({
      key: `message:${projectKey}:${handle}:${wi.type}:${wi.ref}`,
      projectKey,
      taskKey,
      stillValid: (task) => (task ? task.stageId === stageId && isOpenTask(task) : taskKey === null),
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
        stageId = task?.stageId;
        if (this.messages.waiting(projectKey, handle, workItem).length === 0) return;
        const { session } = await this.admission.start({ config, member, workItem });
        this.delivery.deliverWaiting(session);
      },
    });
  }
}
