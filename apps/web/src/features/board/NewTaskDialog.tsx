import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { TaskKind, Visibility } from '@projectman/shared';
import { useBoard, useConfig, useCreateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { Dialog } from '../../components/Dialog';
import { ChoiceCard, SelectField, TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { openThemes } from './themeModel';
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

function NewTaskForm({
  formId,
  kind,
  onKind,
  onDone,
}: {
  formId: string;
  /** Kept by the dialog, whose title follows it. */
  kind: TaskKind;
  onKind: (kind: TaskKind) => void;
  onDone: () => void;
}) {
  const { key, themeFilter } = useProject();
  const config = useConfig(key);
  const board = useBoard(key);
  const create = useCreateTask(key);
  const toast = useToast();
  const navigate = useNavigate();
  const isTheme = kind === 'theme';
  // null until the person picks one; a board filtered to an open theme starts with that theme.
  const [pickedTheme, setPickedTheme] = useState<string | null>(null);
  const themes = openThemes(board.data?.tasks ?? []);
  const filterTheme = themes.find((theme) => theme.key === themeFilter)?.key ?? '';
  const theme = pickedTheme ?? filterTheme;
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
    // A theme takes no repository, label or theme of its own.
    create.mutate(
      isTheme
        ? {
            title: title.trim(),
            description: description.trim() || undefined,
            visibility,
            kind: 'theme',
          }
        : {
            title: title.trim(),
            description: description.trim() || undefined,
            repo: repo || null,
            visibility,
            labels: labels
              .split(',')
              .map((label) => label.trim())
              .filter(Boolean),
            ...(theme ? { themeKey: theme } : {}),
          },
      {
        onSuccess: (data) => {
          const taskKey = createdKey(data);
          toast.show(
            t(isTheme ? 'newTask.themeCreated' : 'newTask.created', { key: taskKey ?? title.trim() }),
          );
          onDone();
          if (taskKey) navigate(`/p/${key}/tasks/${taskKey}`);
        },
      },
    );
  };

  return (
    <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{t('newTask.kind')}</legend>
        <div className={styles.choices}>
          <ChoiceCard
            name="kind"
            value="task"
            checked={!isTheme}
            onChange={() => onKind('task')}
            title={t('newTask.kinds.task')}
            description={t('newTask.kinds.taskHint')}
          />
          <ChoiceCard
            name="kind"
            value="theme"
            checked={isTheme}
            onChange={() => onKind('theme')}
            title={t('newTask.kinds.theme')}
            description={t('newTask.kinds.themeHint')}
          />
        </div>
      </fieldset>
      <TextField
        label={t('newTask.fields.title')}
        placeholder={t(isTheme ? 'newTask.fields.themeTitlePlaceholder' : 'newTask.fields.titlePlaceholder')}
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        error={titleError}
        required
        autoFocus
      />
      <DescriptionEditor
        label={t('newTask.fields.description')}
        value={description}
        onChange={setDescription}
        disabled={create.isPending}
      />
      {isTheme ? null : (
        <>
          <div className={styles.row}>
            <SelectField
              label={t('newTask.fields.repo')}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              <option value="">{t('newTask.fields.repoNone')}</option>
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
          {themes.length > 0 ? (
            <SelectField
              label={t('newTask.fields.theme')}
              hint={pickedTheme === null && filterTheme ? t('newTask.fields.themeFromFilter') : undefined}
              value={theme}
              onChange={(event) => setPickedTheme(event.target.value)}
            >
              <option value="">{t('newTask.fields.themeNone')}</option>
              {themes.map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.title}
                </option>
              ))}
            </SelectField>
          ) : null}
        </>
      )}
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
      {create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : null}
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

export function NewTaskDialog({
  open,
  initialKind = 'task',
  onClose,
}: {
  open: boolean;
  /** The kind the dialog opens with: a theme from the theme strip's "+ Téma". */
  initialKind?: TaskKind;
  onClose: () => void;
}) {
  const formId = useId();
  const [kind, setKind] = useState<TaskKind>(initialKind);
  const [wasOpen, setWasOpen] = useState(open);
  // Every opening starts with the kind it was asked for (the form itself is mounted afresh by the dialog).
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setKind(initialKind);
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t(kind === 'theme' ? 'newTask.titleTheme' : 'newTask.title')}
      size="lg"
    >
      <NewTaskForm formId={formId} kind={kind} onKind={setKind} onDone={onClose} />
    </Dialog>
  );
}
