import type { Session, Task } from '@projectman/shared';
import type { DomainEvents } from '../../core/base';
import type { TaskService } from '../../core/tasks';
import type { BackgroundTasks } from '../../kernel';
import type { FastifyBaseLogger } from 'fastify';
import type { AutoAdvance } from './auto-advance';

/** Coalesce card checks without losing a change that arrives during a running check. */
export function wireCardAdvance(deps: {
  events: DomainEvents;
  tasks: Pick<TaskService, 'find'>;
  merges: { reconcile(projectKey: string, taskKey: string): Promise<void> };
  autoAdvance: Pick<AutoAdvance, 'check'>;
  background: BackgroundTasks;
  logger: FastifyBaseLogger;
}): void {
  const { events, tasks, merges, autoAdvance, background, logger } = deps;
  const advancing = new Map<string, { again: boolean }>();
  const advanceCard = (task: Task | null): void => {
    if (!task) return;
    const id = `${task.projectKey}\u0000${task.key}`;
    const running = advancing.get(id);
    if (running) {
      running.again = true;
      return;
    }
    const round = { again: false };
    advancing.set(id, round);
    background.run(
      async () => {
        try {
          do {
            round.again = false;
            await merges.reconcile(task.projectKey, task.key);
            const fresh = tasks.find(task.projectKey, task.key);
            if (fresh) await autoAdvance.check(fresh);
          } while (round.again);
        } finally {
          advancing.delete(id);
        }
      },
      (err) => logger.warn({ err, taskKey: task.key }, 'automatic stage advance failed'),
    );
  };
  events.on('task_labels_changed', ({ task }) => advanceCard(task));
  events.on('task_stage_changed', (change) => advanceCard(change.task));
  const advanceSessionCard = (session: Session) =>
    advanceCard(
      session.workItem.type === 'task' ? tasks.find(session.projectKey, session.workItem.taskKey) : null,
    );
  events.on('session_idle', advanceSessionCard);
  events.on('session_ended', advanceSessionCard);
}
