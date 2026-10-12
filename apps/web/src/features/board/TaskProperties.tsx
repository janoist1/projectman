import type { Session, Task, TaskMerged } from '@projectman/shared';
import { HandoffNoteButton } from './HandoffNote';
import { useProject } from '../../app/contexts';
import { MemberNames } from '../../components/LeaveChip';
import { formatAgo } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { shortCommit } from '../../lib/timeline';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskPhase } from '../../lib/taskState';
import { TaskFeedbackRow } from '../feedback/TaskFeedbackRow';
import { TaskAssigneeSelect } from './TaskLifecycle';
import { TaskPrioritySelect } from './TaskPriority';
import { TaskLabels } from './TaskLabels';
import { TaskLevel } from './TaskLevel';
import { TaskRepo } from './TaskRepo';
import { TaskRelations } from './TaskRelations';
import { TaskTheme } from './TaskTheme';
import styles from './drawer.module.css';

/** Where the approved work went (PM-453): the merge commit, the branch, who merged it and when. */
function MergedValue({
  merged,
  members,
  myHandle,
}: {
  merged: TaskMerged;
  members: MemberIndex;
  myHandle: string | null;
}) {
  if (merged.via === 'found' || !merged.mergeCommit)
    return (
      <span>
        {t('task.merge.merged.found', {
          commit: shortCommit(merged.commit),
          base: merged.base,
        })}
      </span>
    );
  const commit = shortCommit(merged.mergeCommit);
  const link = merged.pushed?.commitUrl;
  const tip = merged.check
    ? t('task.merge.merged.checked', { check: merged.check.command })
    : t('task.merge.merged.unchecked');
  const ago = formatAgo(merged.at);
  const base = merged.base;
  return (
    <span title={tip}>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer">
          <code>{commit}</code>
        </a>
      ) : (
        <code>{commit}</code>
      )}
      {' · '}
      {merged.by
        ? t('task.merge.merged.value', { base, by: nameOf(merged.by, members, myHandle), ago })
        : t('task.merge.merged.valueNoBy', { base, ago })}
    </span>
  );
}

/**
 * The task's properties as tight rows: assignee, repository, visibility, labels, relations. Each row
 * is one line of label and value, with a small "+" where something can be added.
 */
export function TaskProperties({
  task,
  tasks,
  phases,
  members,
  pipeline,
  sessions,
}: {
  task: Task;
  /** The project's cards as the viewer sees them (the board's, closed ones included). */
  tasks: readonly Task[];
  phases: ReadonlyMap<string, TaskPhase>;
  members: MemberIndex;
  pipeline: PipelineIndex;
  /** The card's sessions: whether the assignee has a conversation on it decides the provider hint. */
  sessions?: readonly Session[];
}) {
  const { can, myHandle } = useProject();
  return (
    <section className={styles.props}>
      <div className={styles.prop}>
        <span className={styles.propLabel}>{t('taskLifecycle.assignee')}</span>
        {can.manageTeam ? (
          <TaskAssigneeSelect key={task.key} task={task} members={members} sessions={sessions} />
        ) : (
          <span className={task.assignee ? undefined : styles.propMuted}>
            {task.assignee ? (
              <MemberNames handles={[task.assignee]} members={members} myHandle={myHandle} />
            ) : (
              t('task.unassigned')
            )}
          </span>
        )}
        <HandoffNoteButton task={task} members={members} className={styles.propNote} />
      </div>
      <TaskLevel key={`level:${task.key}`} task={task} />
      <TaskPrioritySelect key={`priority:${task.key}`} task={task} />
      <div className={styles.prop}>
        <TaskRepo key={task.key} task={task} />
      </div>
      <div className={styles.prop}>
        <span className={styles.propLabel}>{t('newTask.fields.visibility')}</span>
        <span>{t(`visibility.${task.visibility}`)}</span>
      </div>
      {task.merged ? (
        <div className={styles.prop}>
          <span className={styles.propLabel}>{t('task.merge.merged.label')}</span>
          <MergedValue merged={task.merged} members={members} myHandle={myHandle} />
        </div>
      ) : task.reviewPin ? (
        <div className={styles.prop}>
          <span className={styles.propLabel}>{t('task.reviewPin.label')}</span>
          <span title={t('task.reviewPin.hint', { commit: task.reviewPin.commit })}>
            <code>{shortCommit(task.reviewPin.commit)}</code> · {task.reviewPin.branch}
          </span>
        </div>
      ) : null}
      <TaskLabels task={task} />
      <TaskTheme task={task} tasks={tasks} />
      <TaskRelations
        key={`relations:${task.key}`}
        task={task}
        tasks={tasks}
        phases={phases}
        pipeline={pipeline}
      />
      <TaskFeedbackRow key={`feedback:${task.key}`} taskKey={task.key} />
    </section>
  );
}
