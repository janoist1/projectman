import {
  isOpenTask,
  labelDefinition,
  memberOf,
  messageStaleReason,
  messageWakes,
  permissionDelegationOf,
  permissionDelegationState,
  stageOf,
  stageOwners,
} from '@projectman/shared';
import type { ProjectConfig, StaleReason, TeamMessage } from '@projectman/shared';
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

export function wakesFor(
  ctx: DomainContext,
  config: ProjectConfig,
  message: TeamMessage,
  recipient: string,
): boolean {
  return messageWakes(
    message,
    { fromHuman: memberOf(config, message.from)?.kind === 'human' },
    staleReasonFor(ctx, config, message, recipient),
  );
}
