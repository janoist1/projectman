import type { Session, Task } from '@projectman/shared';
import { joinNames, t } from '../../i18n/t';
import { namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { nextStage } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';

/** The session to open for a task: the assignee's latest, otherwise the latest one. */
export function primarySession(task: Task, sessions: readonly Session[]): Session | null {
  const sorted = [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted.find((session) => session.member === task.assignee) ?? sorted[0] ?? null;
}

export function nextStepText(
  task: Task,
  pipeline: PipelineIndex,
  members: MemberIndex,
  myHandle: string | null,
): string | null {
  if (task.status === 'done' || task.status === 'cancelled') return null;
  const next = nextStage(pipeline, task.stageId);
  if (!next) return t('task.lastStage');
  if ((next.owners ?? []).length === 0) return t('task.nextStageNoOwner', { stage: next.name });
  return t('task.nextStage', {
    stage: next.name,
    owners: joinNames(namesOf(next.owners ?? [], members, myHandle)),
  });
}
