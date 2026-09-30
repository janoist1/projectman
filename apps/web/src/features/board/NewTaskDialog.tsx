import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { Visibility } from '@projectman/shared';
import { useConfig, useCreateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ChoiceCard, SelectField, TextAreaField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './NewTaskDialog.module.css';

/** The created task's key, when the server returns the task (or a detail with it). */
function createdKey(data: unknown): string | null {
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    if (typeof record.key === 'string') return record.key;
    const task = record.task as Record<string, unknown> | undefined;
    if (task && typeof task.key === 'string') return task.key;
  }
  return null;
}

function NewTaskForm({ formId, onDone }: { formId: string; onDone: () => void }) {
  const { key } = useProject();
  const config = useConfig(key);
  const create = useCreateTask(key);
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // null until the user picks one; a project with a single repo defaults to it.
  const [pickedRepo, setRepo] = useState<string | null>(null);
  const [visibility, setVisibility] = useState<Visibility>('internal');
  const [labels, setLabels] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const repos = config.data?.config.project.repos ?? [];
  const repo = pickedRepo ?? (repos.length === 1 ? repos[0]!.name : '');

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError(t('newTask.titleRequired'));
      return;
    }
    setTitleError(null);
    create.mutate(
      {
        title: title.trim(),
        description: description.trim() || undefined,
        repo: repo || null,
        visibility,
        labels: labels
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean),
      },
      {
        onSuccess: (data) => {
          const taskKey = createdKey(data);
          toast.show(t('newTask.created', { key: taskKey ?? title.trim() }));
          onDone();
          if (taskKey) navigate(`/p/${key}/tasks/${taskKey}`);
        },
      },
    );
  };

  return (
    <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
      <TextField
        label={t('newTask.fields.title')}
        placeholder={t('newTask.fields.titlePlaceholder')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={titleError}
        required
        autoFocus
      />
      <TextAreaField
        label={t('newTask.fields.description')}
        hint={t('newTask.fields.descriptionHint')}
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        rows={5}
        optional
      />
      <div className={styles.row}>
        <SelectField
          label={t('newTask.fields.repo')}
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
        >
          <option value="">{t('newTask.fields.repoRoot')}</option>
          {repos.map((entry) => (
            <option key={entry.name} value={entry.name}>
              {entry.github ? `${entry.name} · ${entry.github}` : entry.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('newTask.fields.labels')}
          hint={t('newTask.fields.labelsHint')}
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          optional
        />
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('newTask.fields.visibility')}</legend>
        <div className={styles.choices}>
          <ChoiceCard
            name="visibility"
            value="internal"
            checked={visibility === 'internal'}
            onChange={() => setVisibility('internal')}
            title={t('visibility.internal')}
            description={t('visibility.internalHint')}
          />
          <ChoiceCard
            name="visibility"
            value="shared"
            checked={visibility === 'shared'}
            onChange={() => setVisibility('shared')}
            title={t('visibility.shared')}
            description={t('visibility.sharedHint')}
          />
        </div>
      </fieldset>
      {create.isError ? (
        <p className={styles.error} role="alert">
          {errorMessage(create.error)}
        </p>
      ) : null}
      <SubmitState pending={create.isPending} formId={formId} />
    </form>
  );
}

/** Keeps the footer button in sync with the form's pending state. */
function SubmitState({ pending, formId }: { pending: boolean; formId: string }) {
  return (
    <div className={styles.actions}>
      <Button type="submit" form={formId} variant="primary" loading={pending}>
        {pending ? t('newTask.submitting') : t('newTask.submit')}
      </Button>
    </div>
  );
}

export function NewTaskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const formId = useId();
  return (
    <Dialog open={open} onClose={onClose} title={t('newTask.title')} size="md">
      <NewTaskForm formId={formId} onDone={onClose} />
    </Dialog>
  );
}
