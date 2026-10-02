import { useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { TaskKind, Visibility } from '@projectman/shared';
import { useBoard, useConfig, useCreateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { DescriptionEditor } from '../../components/DescriptionEditor';
import { Dialog, DialogActions } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/Field';
import { Fold } from '../../components/Fold';
import { SegmentedControl } from '../../components/SegmentedControl';
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
  const titleInput = useRef<HTMLInputElement>(null);
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
  const [titleError, setTitleError] = useState<string | null>(null);
  const repos = config.data?.config.project.repos ?? [];
  const repo = pickedRepo ?? (repos.length === 1 ? repos[0]!.name : '');
  const themeTitle = themes.find((entry) => entry.key === theme)?.title;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) {
      setTitleError(t('newTask.titleRequired'));
      titleInput.current?.focus();
      return;
    }
    setTitleError(null);
    // A theme takes no repository or theme of its own. Labels go on the card that opens next.
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

  // What the closed "More settings" row shows: the values a person would otherwise have to open it to see.
  const peek = [
    ...(isTheme ? [] : [repo || t('newTask.peekNoRepo')]),
    ...(isTheme || !themeTitle ? [] : [themeTitle]),
    t(`visibility.${visibility}`),
  ].join(' · ');

  return (
    <form id={formId} className={styles.form} onSubmit={onSubmit} noValidate>
      <div className={styles.kind}>
        <SegmentedControl<TaskKind>
          label={t('newTask.kind')}
          value={kind}
          onChange={onKind}
          options={[
            { value: 'task', label: t('newTask.kinds.task') },
            { value: 'theme', label: t('newTask.kinds.theme') },
          ]}
        />
        <p className={styles.hint}>{t(isTheme ? 'newTask.kinds.themeHint' : 'newTask.kinds.taskHint')}</p>
      </div>
      <TextField
        ref={titleInput}
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
      <Fold summary={t('newTask.more')} plain peek={peek}>
        {isTheme ? null : (
          <>
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
        <div className={styles.visibility}>
          <span className={styles.legend}>{t('newTask.fields.visibility')}</span>
          <SegmentedControl<Visibility>
            label={t('newTask.fields.visibility')}
            value={visibility}
            onChange={setVisibility}
            options={[
              { value: 'internal', label: t('visibility.internal') },
              { value: 'shared', label: t('visibility.shared') },
            ]}
          />
          <p className={styles.hint}>{t(`visibility.${visibility}Hint`)}</p>
        </div>
      </Fold>
      <DialogActions error={create.isError ? <ErrorBanner>{errorMessage(create.error)}</ErrorBanner> : null}>
        <Button variant="secondary" size="md" onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" form={formId} variant="primary" size="md" loading={create.isPending}>
          {create.isPending ? t('newTask.submitting') : t('newTask.submit')}
        </Button>
      </DialogActions>
    </form>
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
