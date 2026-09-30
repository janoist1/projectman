import type { LabelView, Session, Task, TimelineEvent } from '@projectman/shared';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { describeEvent } from '../../lib/timeline';

export interface Participant {
  handle: string;
  what: string;
}

export function participantsFor(
  session: Session,
  task: Task | null,
  timeline: readonly TimelineEvent[],
  pipeline: PipelineIndex | null,
  members: MemberIndex,
  myHandle: string | null,
  labels?: readonly LabelView[],
): Participant[] {
  const list = new Map<string, string>();
  list.set(session.member, t('session.participantSession'));
  if (task?.assignee && !list.has(task.assignee)) list.set(task.assignee, t('session.participantAssignee'));
  const latest = [...timeline].reverse();
  for (const event of latest) {
    const handle = event.actor.handle;
    if (!handle || list.has(handle)) continue;
    list.set(
      handle,
      t('session.participantActivity', {
        text: describeEvent(event, { pipeline, members, labels, myHandle, openInboxIds: new Set() }).text,
      }),
    );
  }
  const stage = task && pipeline ? pipeline.stageById.get(task.stageId) : undefined;
  for (const owner of stage?.owners ?? []) {
    if (!list.has(owner)) list.set(owner, t('session.participantOwner', { stage: stage?.name ?? '' }));
  }
  return [...list.entries()].slice(0, 8).map(([handle, what]) => ({ handle, what }));
}
