import {
  hasCardRole,
  isOpenTask,
  isOperator,
  isTheme,
  labelDefinition,
  memberOf,
  messageStaleReason,
  messageWakeBlock,
  messageWakes,
  permissionDelegationOf,
  permissionDelegationState,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { ProjectConfig, StaleReason, Task, TeamMessage, WakeBlock, WakeFacts } from '@projectman/shared';
import type { DomainContext } from '../context';

/** Server facts for the shared message validity rule; no git lookup is needed at delivery. */
export function staleReasonFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): StaleReason | null {
  const task = message.taskKey ? ctx.repos.tasks.get(message.taskKey) : null;
  const stage = task ? stageOf(config, task.stageId) : null;
  const subject = message.subject ? ctx.repos.inbox.get(message.subject.inboxItemId) : null;
  const delegation = subject ? permissionDelegationOf(subject) : null;
  const results = message.taskKey
    ? ctx.repos.timeline
        .roundEvents(message.projectKey, message.taskKey)
        .filter((e) => e.type === 'task_labels_changed')
    : [];
  return messageStaleReason(message, {
    fromHuman: memberOf(config, message.from)?.kind === 'human',
    card: task ? { open: isOpenTask(task), stageId: task.stageId } : null,
    recipientOwnsStage:
      task?.assignee === recipient || !!(stage && stageOwners(config, stage).includes(recipient)),
    superseded: ctx.repos.messages.hasNewerAction(message, recipient),
    senderResultLabel: senderResultLabelFor(ctx, config, message, recipient),
    resultCommits: results
      .filter((e) => e.actor.handle === recipient && e.createdAt > message.createdAt)
      .flatMap((e) => (typeof e.data.resultCommit === 'string' ? [e.data.resultCommit] : [])),
    subjectClosed:
      !!message.subject &&
      (!subject ||
        subject.state !== 'open' ||
        !delegation ||
        permissionDelegationState(config, subject.source, delegation, ctx.now().getTime()) !==
          'pending_lead'),
  });
}

export function senderResultLabelFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): string | null {
  if (!message.taskKey || ctx.repos.tasks.get(message.taskKey)?.assignee !== recipient) return null;
  const labels = ctx.repos.timeline
    .roundEvents(message.projectKey, message.taskKey)
    .filter(
      (e) =>
        e.type === 'task_labels_changed' &&
        e.actor.handle === message.from &&
        e.createdAt > message.createdAt,
    )
    .flatMap((e) => e.data.added as string[])
    .filter((id) => {
      const definition = labelDefinition(config, id);
      return !!definition?.group && definition.notifyAssignee !== true;
    });
  return labels.at(-1) ?? null;
}

/**
 * Whether the recipient has a role on the card (PM-426): the shared rule, with the server fact that they
 * have or had a session on the card, or on its parent when it is a subtask (the sessions table keeps one
 * row per member and work item and is never emptied).
 */
export function recipientHasCardRole(
  ctx: DomainContext,
  config: ProjectConfig,
  task: Task,
  recipient: string,
): boolean {
  const worked = (taskKey: string) =>
    ctx.repos.sessions.findByWorkItem(task.projectKey, recipient, { type: 'task', taskKey }) !== null;
  return hasCardRole(
    config,
    task,
    recipient,
    worked(task.key) || (!!task.parentKey && worked(task.parentKey)),
  );
}

/** The shared wake facts: a message about no card, a missing card or a theme never lacks a role. */
export function wakeFactsFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): WakeFacts {
  const sender = memberOf(config, message.from);
  const task = message.taskKey ? ctx.repos.tasks.get(message.taskKey) : null;
  return {
    fromHuman: sender?.kind === 'human',
    fromAi: sender?.kind === 'ai',
    recipientHasRole: !task || isTheme(task) || recipientHasCardRole(ctx, config, task, recipient),
    recipientIsOperator: isOperator(memberOf(config, recipient)),
    // An owner's own login only: the integrator key acts for the owner but does not wake the Operator.
    fromOwner: sender?.kind === 'human' && sender.access === 'owner' && message.via !== 'integrator',
  };
}

export function wakesFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): boolean {
  return messageWakes(
    message,
    wakeFactsFor(ctx, config, message, recipient),
    staleReasonFor(ctx, config, message, recipient),
  );
}

/** Why a valid action message starts no session for the recipient, or null (PM-426). */
export function wakeBlockFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): WakeBlock | null {
  return messageWakeBlock(
    message,
    wakeFactsFor(ctx, config, message, recipient),
    staleReasonFor(ctx, config, message, recipient),
  );
}
