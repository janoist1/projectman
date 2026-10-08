import type { Session, Task } from '@projectman/shared';
import { HandoffNoteButton } from './HandoffNote';
import { useProject } from '../../app/contexts';
import { MemberNames } from '../../components/LeaveChip';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';
import { shortCommit } from '../../lib/timeline';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskPhase } from '../../lib/taskState';
import { TaskAssigneeSelect } from './TaskLifecycle';
import { TaskPrioritySelect } from './TaskPriority';
import { TaskLabels } from './TaskLabels';
import { TaskLevel } from './TaskLevel';
import { TaskRepo } from './TaskRepo';
import { TaskRelations } from './TaskRelations';
import { TaskTheme } from './TaskTheme';
import styles from './drawer.module.css';

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
        <HandoffNoteButton task={task} members={members} />
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
      {task.reviewPin ? (
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
    </section>
  );
}
