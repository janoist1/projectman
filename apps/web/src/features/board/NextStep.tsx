import type { ReactNode } from 'react';
import type { Task } from '@projectman/shared';
import { MemberNames } from '../../components/LeaveChip';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import { nextStage } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { isTaskClosed } from '../../lib/taskState';

/** What happens next and who carries it: the next stage and its owners, a member on leave marked. */
export function nextStepLine(
  task: Task,
  pipeline: PipelineIndex,
  members: MemberIndex,
  myHandle: string | null,
): ReactNode {
  if (isTaskClosed(task)) return null;
  const next = nextStage(pipeline, task.stageId);
  if (!next) return t('task.lastStage');
  const owners = next.owners ?? [];
  if (owners.length === 0) return t('task.nextStageNoOwner', { stage: next.name });
  return (
    <>
      {next.name} · <MemberNames handles={owners} members={members} myHandle={myHandle} />
    </>
  );
}
