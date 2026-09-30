import { useState } from 'react';
import { Link } from 'react-router';
import type { Task } from '@projectman/shared';
import { useCreateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { isTaskClosed } from '../../lib/taskState';
import styles from './TaskDrawer.module.css';

export function TaskSubtasks({
  task,
  children,
  members,
  pipeline,
}: {
  task: Task;
  children: Task[];
  members: MemberIndex;
  pipeline: PipelineIndex;
}) {
  const { key, can, myHandle } = useProject();
  const create = useCreateTask(key);
  const [title, setTitle] = useState('');
  return (
    <section className={styles.section} aria-label={t('task.subtasks')}>
      <h3 className={styles.sectionTitle}>{t('task.subtasks')}</h3>
      <p>
        {t('task.subtaskProgress', {
          done: children.filter((child) => child.status === 'done').length,
          total: children.length,
        })}
      </p>
      <ul className={styles.subtasks}>
        {children.map((child) => (
          <li key={child.key}>
            <Link to={`/p/${key}/tasks/${child.key}`}>
              {child.key} – {child.title}
            </Link>
            <Chip>
              {isTaskClosed(child)
                ? t(`taskStatus.statuses.${child.status}`)
                : (pipeline.stageById.get(child.stageId)?.name ?? child.stageId)}
            </Chip>
            <span>{child.assignee ? nameOf(child.assignee, members, myHandle) : t('task.unassigned')}</span>
          </li>
        ))}
      </ul>
      {can.createTasks ? (
        <form
          className={styles.quickAdd}
          onSubmit={(event) => {
            event.preventDefault();
            if (!title.trim() || create.isPending) return;
            create.mutate(
              { title: title.trim(), parentKey: task.key, repo: task.repo, visibility: task.visibility },
              { onSuccess: () => setTitle('') },
            );
          }}
        >
          <TextField
            label={t('task.subtaskTitle')}
            value={title}
            disabled={create.isPending}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" loading={create.isPending} disabled={!title.trim()}>
            {t('task.addSubtask')}
          </Button>
          {create.isError ? (
            <p className={styles.error} role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
