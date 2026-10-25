import { mergeRequestOf, memberOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import type { MergeRecord } from '../../db';
import { SYSTEM_ACTOR } from '../../kernel';
import type { MergeDeps } from './deps';

/** Tells the card's merger what the merge needs from them: an inbox request for a human, a message for an AI. */
export async function notifyMerge(
  deps: Pick<MergeDeps, 'ctx' | 'inbox' | 'messaging'>,
  row: MergeRecord,
  config: ProjectConfig,
): Promise<void> {
  const member = memberOf(config, row.merger);
  if (!member) return;
  if (member.kind === 'human' && (row.state === 'requested' || row.state === 'failed')) {
    if (
      deps.inbox
        .list(row.projectKey, { taskKey: row.taskKey, state: 'open' })
        .some((item) => mergeRequestOf(item)?.mergeId === row.id)
    )
      return;
    deps.inbox.create({
      projectKey: row.projectKey,
      taskKey: row.taskKey,
      kind: 'merge_request',
      assignees: [row.merger],
      source: 'system',
      title:
        row.trainId && row.failure?.reason === 'check_failed'
          ? `Group check failed; individual cause unknown: ${row.taskKey}`
          : `Merge ${row.taskKey} into ${row.base}`,
      payload: {
        mergeRequest: {
          taskKey: row.taskKey,
          mergeId: row.id,
          repo: row.repo,
          base: row.base,
          ...(row.failure ? { failure: row.failure } : {}),
        },
      },
      options: [{ id: 'merge', label: 'Merge', style: 'primary' }],
    });
    return;
  }
  if (row.state === 'blocked' && member.kind === 'human') return;
  const type =
    row.state === 'failed'
      ? 'task_merge_failed'
      : row.state === 'blocked'
        ? 'task_merge_blocked'
        : row.state === 'merged'
          ? 'task_merged'
          : 'task_merge_requested';
  let event = deps.ctx.repos.timeline.latestOfType(row.projectKey, row.taskKey, type);
  if (row.state === 'requested') {
    // A later approval gives the merger new work even if the original request was delivered already.
    // Use timeline order rather than timestamps: a label and the request can share a millisecond.
    const latest = deps.ctx.repos.timeline.listOfTypes(
      row.projectKey,
      row.taskKey,
      [type, 'task_labels_changed'],
      1,
    )[0];
    if (
      latest?.type === 'task_labels_changed' &&
      Array.isArray(latest.data.added) &&
      latest.data.added.length
    )
      event = latest;
  }
  const failureDetail = [row.failure?.files?.join('\n'), row.failure?.outputTail].filter(Boolean).join('\n');
  const text =
    row.state === 'merged'
      ? `Merge ${row.taskKey} into ${row.repo}/${row.base} completed at ${row.mergeCommit}.`
      : row.trainId && row.state === 'failed' && row.failure?.reason === 'check_failed'
        ? `The group check failed for merge train ${row.trainId}; the individual cause has not yet been identified. The default branch did not move. Shared run: ${row.check?.runId}.\n${failureDetail}\nDo not attribute the failure to every member or retry the unchanged group automatically.`
        : row.state === 'failed' && row.failure!.reason === 'check_failed'
          ? `The full check (\`${row.failure!.command ?? 'the full test'}\`) failed on the merge result of ${row.taskKey} onto ${row.base}; the default branch did not move.\n${failureDetail}\nIf the card caused it, send the card back to its work stage with update_task (a fix round) and name the failing tests or checks; do not fix it yourself. If the developer could have run the failing check locally, name its local command in the send-back note (for example, npm run dead-code for unused files or exports). If it was missing from the developer hand-over checklist, propose adding it and send the lesson to the Operator for the project's lessons document (docs/LESSONS.md when present). If it is not the card's fault (it fails on the default branch too, a flaky test, the sandbox), retry once with merge_task; if it fails again, ask_human.`
          : row.state === 'failed'
            ? `Merge ${row.taskKey} failed (${row.failure!.reason}).\n${failureDetail}\nFor a simple mechanical conflict, call merge_task with fix_conflict: true; otherwise send the card back with update_task and explain the failure. Submit the committed fix with merge_task and resolution. For other failures, retry with merge_task when ready.`
            : row.state === 'blocked'
              ? `Merge ${row.taskKey} blocked (${row.block!.reason}): ${row.block!.message}.${row.block!.reason === 'check_error' && row.block!.detail ? `\n${row.block!.detail}\n` : ''} Retry with merge_task after fixing the cause; use ask_human if you cannot resolve it.`
              : `Merge ${row.taskKey}'s approved commit into ${row.repo}/${row.base} before entering ${row.toStageId}. Call merge_task; never merge or push manually.`;
  if (
    event &&
    deps.ctx.repos.messages
      .list(row.projectKey, { taskKey: row.taskKey })
      .some(
        (message) =>
          message.from === 'system' &&
          message.to.includes(row.merger) &&
          message.body === text &&
          message.origin?.kind === 'note' &&
          message.origin.eventId === event.id,
      )
  )
    return;
  await deps.messaging.send(
    row.projectKey,
    'system',
    { to: [row.merger], taskKey: row.taskKey, text },
    {
      actor: SYSTEM_ACTOR,
      kind: row.state === 'merged' ? 'info' : 'action',
      ownCard: true,
      ...(event ? { origin: { kind: 'note', eventId: event.id } } : {}),
    },
  );
}
