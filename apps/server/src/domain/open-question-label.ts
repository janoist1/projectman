import { isRefining, labelDefinition, stageOf, WAITING_ANSWER_LABEL } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import type { DomainContext } from './context';
import type { InboxService } from './inbox';
import type { ProjectService } from './projects';
import type { TaskService } from './tasks';
import { excerpt, SYSTEM_ACTOR } from './util';

/**
 * The waiting label of an open AI question (PM-185, rule 3 of PM-176). While an AI member's
 * question about a card is open, the card carries the standard blocking label `waiting-answer`, so
 * the move rules keep it from going forward and no hand-over starts a session on it. The system puts
 * the label on and takes it off again, but only when it put it on itself: a question records that as
 * `payload.autoLabel`.
 *
 * - A project that does not define the label gets nothing.
 * - Only work and step stages, and a card that is being refined (PM-264) in any stage: a queue stage
 *   hands nothing over, and the label would stop the owner's own sorting there, but a card under
 *   refinement has a member's turn that waits for the answer.
 * - The label comes off when the last question that carries `autoLabel` closes. A person who took it
 *   off in the meantime is not overruled: nothing is put back, and removing a label that is gone
 *   changes nothing.
 */
export class OpenQuestionLabel {
  private readonly ctx: DomainContext;
  private readonly projects: ProjectService;
  private readonly tasks: TaskService;
  private readonly inbox: InboxService;

  constructor(deps: {
    ctx: DomainContext;
    projects: ProjectService;
    tasks: TaskService;
    inbox: InboxService;
  }) {
    this.ctx = deps.ctx;
    this.projects = deps.projects;
    this.tasks = deps.tasks;
    this.inbox = deps.inbox;
  }

  /**
   * Before `asker` asks `question` about `taskKey`: puts the label on the card when it is due, and
   * returns whether the question then carries `autoLabel`. A failure never stops the question.
   */
  async claim(projectKey: string, taskKey: string | null, asker: string, question: string): Promise<boolean> {
    if (!taskKey) return false;
    try {
      const config = await this.projects.config(projectKey);
      const task = this.tasks.find(projectKey, taskKey);
      if (!task || task.status !== 'active' || !labelDefinition(config, WAITING_ANSWER_LABEL)) return false;
      const kind = stageOf(config, task.stageId)?.kind;
      if (kind !== 'work' && kind !== 'step' && !isRefining(task, config)) return false;
      if (task.labels.includes(WAITING_ANSWER_LABEL))
        return this.openAutoQuestions(projectKey, taskKey).length > 0;
      await this.tasks.changeLabels(projectKey, taskKey, { add: [WAITING_ANSWER_LABEL] }, SYSTEM_ACTOR, {
        reason: 'open_question',
        comment: `${asker} asked an open question: "${excerpt(question, 200)}". The label comes off when it is answered.`,
      });
      return true;
    } catch (err) {
      this.ctx.logger.warn({ err, projectKey, taskKey }, 'could not put the waiting label on the card');
      return false;
    }
  }

  /** A question closed (answered, dismissed, cancelled): the label goes when no such question is left. */
  async release(item: InboxItem): Promise<void> {
    if (item.kind !== 'question' || item.payload.autoLabel !== true || !item.taskKey) return;
    try {
      const { projectKey, taskKey } = item;
      if (this.openAutoQuestions(projectKey, taskKey).length > 0) return;
      const task = this.tasks.find(projectKey, taskKey);
      if (!task?.labels.includes(WAITING_ANSWER_LABEL)) return;
      await this.tasks.changeLabels(projectKey, taskKey, { remove: [WAITING_ANSWER_LABEL] }, SYSTEM_ACTOR, {
        reason: 'open_question',
      });
    } catch (err) {
      this.ctx.logger.warn({ err, taskKey: item.taskKey }, 'could not take the waiting label off the card');
    }
  }

  private openAutoQuestions(projectKey: string, taskKey: string): InboxItem[] {
    return this.inbox
      .list(projectKey, { state: 'open', kind: 'question', taskKey })
      .filter((item) => item.payload.autoLabel === true);
  }
}
