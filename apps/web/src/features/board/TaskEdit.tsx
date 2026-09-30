import { useState } from 'react';
import type { Task } from '@projectman/shared';
import { useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import drawer from './drawer.module.css';
import styles from './TaskEdit.module.css';

/** Edits the title and description; labels have their own section with the label rules. */
export function TaskEdit({ task }: { task: Task }) {
  const { key } = useProject();
  const update = useUpdateTask(key);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  if (!editing)
    return (
      <Button
        onClick={() => {
          setTitle(task.title);
          setDescription(task.description);
          update.reset();
          setEditing(true);
        }}
      >
        {t('task.edit')}
      </Button>
    );
  return (
    <form
      className={drawer.section}
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || update.isPending) return;
        update.mutate(
          {
            taskKey: task.key,
            body: {
              title: title.trim(),
              description,
            },
          },
          { onSuccess: () => setEditing(false) },
        );
      }}
    >
      <TextField
        label={t('newTask.fields.title')}
        value={title}
        required
        disabled={update.isPending}
        onChange={(event) => setTitle(event.target.value)}
      />
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
        <Button type="submit" loading={update.isPending} disabled={!title.trim()}>
          {t('task.save')}
        </Button>
        <Button disabled={update.isPending} onClick={() => setEditing(false)}>
          {t('common.cancel')}
        </Button>
      </div>
    </form>
  );
}
