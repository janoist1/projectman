import { coordinationMemberOf, OPERATOR_SILENT_WORK_MINUTES } from '@projectman/shared';
import type { Session, Task } from '@projectman/shared';
import type { EventBus } from '../../contracts';
import type { DomainContext } from '../../core/base';
import type { AlertPmSignals } from '../../core/inbox';
import type { ProjectService } from '../../core/projects';
import type { BackgroundTasks } from '../../kernel';
import { relationCheckCase } from './signals';
import type { OperatorSignals } from './signals';

/** How long a process cleanup may keep failing before the project manager is told (PM-1204). */
const PROCESS_CLEANUP_SIGNAL_GRACE_MS = 2 * 60_000;

/**
 * Where the alerts the route rule sends to the project manager land (PM-1250): an outage is the `outage`
 * signal of its episode, a relation check the `relation_check` signal of the card and its relations. Both
 * are idempotent per case, so a repeated alert opens no second signal.
 */
export function createAlertPmSignals(deps: {
  operatorSignals: Pick<OperatorSignals, 'raise' | 'deliver'>;
  background: BackgroundTasks;
  logger: DomainContext['logger'];
}): AlertPmSignals {
  const { operatorSignals, background, logger } = deps;
  return {
    raise(projectKey, alert) {
      if (alert.alert === 'work_outage')
        operatorSignals.raise({
          projectKey,
          kind: 'outage',
          caseKey: `outage:${alert.outage.id}`,
          subject: alert.outage.id,
        });
      else
        operatorSignals.raise({
          projectKey,
          kind: 'relation_check',
          taskKey: alert.taskKey,
          ...relationCheckCase(alert.taskKey, alert.relations),
        });
      background.run(
        () => operatorSignals.deliver(projectKey),
        (err) => logger.warn({ err, projectKey }, 'operator signal delivery failed'),
      );
    },
  };
}

/** Register signal lifecycle listeners at their original position in domain assembly. */
export function wireOperatorSignals(deps: {
  ctx: DomainContext;
  bus: EventBus;
  projects: Pick<ProjectService, 'cachedConfig'>;
  sessions: { find(sessionId: string): Session | null };
  operatorSignals: Pick<OperatorSignals, 'finish' | 'deliver' | 'raise' | 'resolve' | 'sweep'>;
  background: BackgroundTasks;
}): () => void {
  const { ctx, bus, projects, sessions, operatorSignals, background } = deps;
  const { events, logger } = ctx;
  const finishOperatorSignals = (session: Session) => {
    const config = projects.cachedConfig(session.projectKey);
    if (config && session.member === coordinationMemberOf(config)?.handle)
      operatorSignals.finish(session.projectKey);
  };
  events.on('session_idle', finishOperatorSignals);
  events.on('session_ended', finishOperatorSignals);
  const wakeOperatorSignals = (projectKey: string) =>
    background.run(
      () => operatorSignals.deliver(projectKey),
      (err) => logger.warn({ err, projectKey }, 'operator signal delivery failed'),
    );
  events.on('session_cleanup_failed', ({ projectKey, sessionId, scopeId }) => {
    // Slowly exiting processes usually settle on the next retry: signal only a failure that lasted.
    // The record keeps the first failure's time; every retry that fails again emits this event once more.
    // A retry that cannot run (an unreachable engine) emits nothing; the engine outage has its own signal.
    const failedAt = ctx.repos.sessionCleanups.get(scopeId)?.failedAt;
    const ageMs = failedAt ? ctx.now().getTime() - Date.parse(failedAt) : Infinity;
    if (ageMs < PROCESS_CLEANUP_SIGNAL_GRACE_MS) {
      logger.info({ projectKey, scopeId, ageMs }, 'process cleanup failed; signal held back during grace');
      return;
    }
    const session = sessions.find(sessionId);
    operatorSignals.raise({
      projectKey,
      kind: 'process_cleanup_failed',
      caseKey: `cleanup:${scopeId}`,
      subject: scopeId,
      taskKey: session?.workItem.type === 'task' ? session.workItem.taskKey : null,
    });
    wakeOperatorSignals(projectKey);
  });
  events.on('session_cleanup_recovered', ({ projectKey, scopeId }) =>
    operatorSignals.resolve(projectKey, `cleanup:${scopeId}`),
  );
  events.on('session_cleanup_released', ({ projectKey, scopeId }) =>
    operatorSignals.resolve(projectKey, `cleanup:${scopeId}`),
  );
  events.on('work_outage_ended', ({ projectKey, outageId }) =>
    operatorSignals.resolve(projectKey, `outage:${outageId}`),
  );
  events.on('session_input_stalled', ({ projectKey, sessionId, inboxItemId }) => {
    const session = sessions.find(sessionId);
    operatorSignals.raise({
      projectKey,
      kind: 'stalled',
      caseKey: `stalled:${sessionId}`,
      subject: sessionId,
      inboxItemId,
      taskKey: session?.workItem.type === 'task' ? session.workItem.taskKey : null,
    });
    wakeOperatorSignals(projectKey);
  });
  const sessionSignalEnded = (session: Session) => {
    operatorSignals.resolve(session.projectKey, `stalled:${session.id}`);
    operatorSignals.resolve(session.projectKey, `silent:${session.id}`);
  };
  events.on('session_input_released', sessionSignalEnded);
  events.on('session_ended', sessionSignalEnded);
  const unsubscribeSignalActivity = bus.subscribe((event) => {
    if (event.type === 'session_upserted' || event.type === 'chat_appended') {
      const id = event.type === 'session_upserted' ? event.session.id : event.sessionId;
      const session = sessions.find(id);
      if (
        event.type === 'chat_appended' ||
        !session ||
        session.state !== 'working' ||
        ctx.now().getTime() - Date.parse(session.lastActivityAt) < OPERATOR_SILENT_WORK_MINUTES * 60_000
      )
        operatorSignals.resolve(event.projectKey, `silent:${id}`);
      if (session?.state !== 'waiting_input') operatorSignals.resolve(event.projectKey, `stalled:${id}`);
    }
  });
  const checkOperatorCards = ({ task }: { task: Task }) => {
    background.run(
      () => operatorSignals.sweep(task.projectKey),
      (err) => logger.warn({ err, taskKey: task.key }, 'operator signal card check failed'),
    );
  };
  events.on('task_stage_changed', checkOperatorCards);
  events.on('task_labels_changed', checkOperatorCards);
  events.on('task_assigned', checkOperatorCards);
  return unsubscribeSignalActivity;
}
