import type { Task } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { shortCommit } from '../../lib/timeline';
import type { PipelineIndex } from '../../lib/pipeline';
import { TaskAssigneeSelect } from './TaskLifecycle';
import { TaskLabels } from './TaskLabels';
import { TaskRepo } from './TaskRepo';
import { TaskSubtasks } from './TaskSubtasks';
import { TaskTheme } from './TaskTheme';
import styles from './drawer.module.css';

/**
 * The task's properties as tight rows: assignee, repository, visibility, labels, subtasks. Each row
 * is one line of label and value, with a small "+" where something can be added.
 */
export function TaskProperties({
  task,
  subtasks,
  tasks,
  members,
  pipeline,
}: {
  task: Task;
  subtasks: Task[];
  /** Every card of the board: the themes and a collecting card's subtasks are looked up in them. */
  tasks: readonly Task[];
  members: MemberIndex;
  pipeline: PipelineIndex;
}) {
  const { can, myHandle } = useProject();
  return (
    <section className={styles.props}>
      <div className={styles.prop}>
        <span className={styles.propLabel}>{t('taskLifecycle.assignee')}</span>
        {can.manageTeam ? (
          <TaskAssigneeSelect key={task.key} task={task} members={members} />
        ) : (
          <span className={task.assignee ? undefined : styles.propMuted}>
            {task.assignee ? nameOf(task.assignee, members, myHandle) : t('task.unassigned')}
          </span>
        )}
      </div>
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
      <TaskTheme task={task} tasks={tasks} />
      <TaskLabels task={task} />
      {!task.parentKey ? (
        <TaskSubtasks
          key={`subtasks:${task.key}`}
          task={task}
          children={subtasks}
          members={members}
          pipeline={pipeline}
        />
      ) : null}
    </section>
  );
}
