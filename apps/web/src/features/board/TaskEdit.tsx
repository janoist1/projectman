import { useState } from 'react';
import type { Ref } from 'react';
import type { Task } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { Markdown } from '../../components/Markdown';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';
import styles from './TaskEdit.module.css';

/** The title, with a pencil that turns it into an input in place: Enter saves, Escape cancels. */
export function TaskTitle({ task, headingRef }: { task: Task; headingRef: Ref<HTMLHeadingElement> }) {
  const { key, can } = useProject();
  const update = useUpdateTask(key);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const save = () => {
    const next = title.trim();
    if (!next || update.isPending) return;
    if (next === task.title) return setEditing(false);
    update.mutate({ taskKey: task.key, body: { title: next } }, { onSuccess: () => setEditing(false) });
  };
  if (!editing)
    return (
      <div className={styles.titleRow}>
        <h2 ref={headingRef} tabIndex={-1} className={styles.title}>
          {task.title}
        </h2>
        {can.createTasks ? (
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon="pencil"
            aria-label={t('task.editTitle')}
            onClick={() => {
              setTitle(task.title);
              update.reset();
              setEditing(true);
            }}
          />
        ) : null}
      </div>
    );
  return (
    <form
      className={styles.titleForm}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <div className={styles.titleRow}>
        <input
          className={styles.titleInput}
          aria-label={t('newTask.fields.title')}
          value={title}
          required
          autoFocus
          disabled={update.isPending}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            // Escape cancels the edit, not the drawer around it.
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            setEditing(false);
          }}
        />
        <Button
          type="submit"
          variant="primary"
          size="sm"
          iconOnly
          icon="check"
          aria-label={t('task.save')}
          loading={update.isPending}
          disabled={!title.trim()}
        />
        <Button
          variant="muted"
          size="sm"
          iconOnly
          icon="close"
          aria-label={t('common.cancel')}
          disabled={update.isPending}
          onClick={() => setEditing(false)}
        />
      </div>
      {update.isError ? (
        <p role="alert" className={drawer.error}>
          {errorMessage(update.error)}
        </p>
      ) : null}
    </form>
  );
}

/** The description with a pencil that opens the editor in place; it is shown when it exists or can be written. */
export function TaskDescription({ task, className }: { task: Task; className?: string }) {
  const { key, can } = useProject();
  const update = useUpdateTask(key);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(task.description);
  if (!task.description && !can.createTasks) return null;
  return (
    <section className={drawer.section}>
      <div className={styles.descriptionHead}>
        <h3 className={drawer.sectionTitle}>{t('task.description')}</h3>
        {can.createTasks && !editing ? (
          <Button
            variant="muted"
            size="sm"
            iconOnly
            icon="pencil"
            aria-label={t('task.editDescription')}
            onClick={() => {
              setDescription(task.description);
              update.reset();
              setEditing(true);
            }}
          />
        ) : null}
      </div>
      {editing ? (
        <form
          className={drawer.section}
          onSubmit={(event) => {
            event.preventDefault();
            if (update.isPending) return;
            update.mutate(
              { taskKey: task.key, body: { description } },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <DescriptionEditor
            label={t('task.description')}
            value={description}
            onChange={setDescription}
            disabled={update.isPending}
          />
          {update.isError ? (
            <p role="alert" className={drawer.error}>
              {errorMessage(update.error)}
            </p>
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" size="md" loading={update.isPending}>
              {t('task.save')}
            </Button>
            <Button size="md" disabled={update.isPending} onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      ) : task.description ? (
        <Markdown text={task.description} className={className} />
      ) : (
        <p className={styles.empty}>{t('task.descriptionNone')}</p>
      )}
    </section>
  );
}
