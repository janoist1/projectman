import clsx from 'clsx';
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
import drawer from './drawer.module.css';
import styles from './TaskSubtasks.module.css';

/** The subtasks row: the progress and a small "+" that opens the quick-add form; the children below. */
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
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  return (
    <section className={drawer.prop} aria-label={t('task.subtasks')}>
      <h3 className={drawer.propLabel}>{t('task.subtasks')}</h3>
      <span className={clsx(children.length === 0 && drawer.propMuted)}>
        {children.length > 0
          ? t('task.subtaskProgress', {
              done: children.filter((child) => child.status === 'done').length,
              total: children.length,
            })
          : t('task.subtasksNone')}
      </span>
      {can.createTasks ? (
        <Button
          size="sm"
          variant="muted"
          iconOnly
          icon="plus"
          aria-label={t('task.subtaskNew')}
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        />
      ) : (
        <span />
      )}
      {children.length > 0 ? (
        <ul className={clsx(styles.subtasks, drawer.propWide)}>
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
      ) : null}
      {can.createTasks && adding ? (
        <form
          className={clsx(styles.quickAdd, drawer.propWide)}
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
            autoFocus
            disabled={create.isPending}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Button type="submit" size="md" loading={create.isPending} disabled={!title.trim()}>
            {t('task.addSubtask')}
          </Button>
          {create.isError ? (
            <p className={drawer.error} role="alert">
              {errorMessage(create.error)}
            </p>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
