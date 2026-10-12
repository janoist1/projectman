import { useId, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { FeedbackMarkDetail, Task } from '@projectman/shared';
import { useBoard, useLinkFeedback } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextAreaField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './FeedbackDialogs.module.css';

const MAX_OPTIONS = 8;

function LinkCardForm({
  mark,
  clientAuthor,
  onClose,
}: {
  mark: FeedbackMarkDetail;
  clientAuthor: boolean;
  onClose: () => void;
}) {
  const { key } = useProject();
  const toast = useToast();
  const board = useBoard(key);
  const { pipeline } = useProjectIndexes(key);
  const link = useLinkFeedback(key, mark.id);
  const formId = useId();
  const listId = useId();
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [reply, setReply] = useState('');

  const tasks = board.data?.tasks;
  const options = useMemo(() => {
    const all = tasks ?? [];
    const needle = query.trim().toLowerCase();
    const found = needle
      ? all.filter(
          (task) => task.key.toLowerCase().includes(needle) || task.title.toLowerCase().includes(needle),
        )
      : [...all].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return found.slice(0, MAX_OPTIONS);
  }, [tasks, query]);
  const chosenTask: Task | undefined = (tasks ?? []).find((task) => task.key === chosen);

  const stageName = (task: Task) => pipeline?.stageById.get(task.stageId)?.name ?? task.stageId;
  const submit = () => {
    if (!chosenTask || link.isPending) return;
    link.mutate(
      { taskKey: chosenTask.key, ...(reply.trim() ? { reply: reply.trim() } : {}) },
      {
        onSuccess: () => {
          toast.show(t('feedback.link.done', { key: chosenTask.key }));
          onClose();
        },
      },
    );
  };
  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (options.length === 0) return;
      const at = options.findIndex((task) => task.key === active);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(options[(at + step + options.length) % options.length]!.key);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = options.find((task) => task.key === active);
      // Enter chooses the highlighted card; Enter once a card is chosen goes ahead.
      if (row && row.key !== chosen) setChosen(row.key);
      else submit();
    }
  };

  return (
    <form
      id={formId}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <label className={styles.label} htmlFor={`${listId}-search`}>
          {t('feedback.link.card')}
        </label>
        <input
          id={`${listId}-search`}
          className={styles.search}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active ? `${listId}-${active}` : undefined}
          placeholder={t('feedback.link.search')}
          autoComplete="off"
          autoFocus
          value={query}
          disabled={link.isPending}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(null);
          }}
          onKeyDown={onSearchKey}
        />
        {options.length > 0 ? (
          <ul id={listId} role="listbox" aria-label={t('feedback.link.card')} className={styles.options}>
            {options.map((task) => (
              <li
                key={task.key}
                id={`${listId}-${task.key}`}
                role="option"
                aria-selected={chosen === task.key}
                data-active={active === task.key}
                className={styles.option}
                onClick={() => {
                  setChosen(task.key);
                  setActive(task.key);
                }}
              >
                <span className={styles.optionHead}>
                  <span className={styles.optionKey}>{task.key}</span>
                  <span className={styles.optionTitle}>{task.title}</span>
                </span>
                <span className={styles.optionMeta}>
                  {t(`feedback.visibility.${task.visibility === 'shared' ? 'shared' : 'internal'}`)} ·{' '}
                  {stageName(task)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p id={listId} className={styles.empty}>
            {t('feedback.link.noMatch')}
          </p>
        )}
      </div>
      {chosenTask ? (
        <>
          <p className={styles.info}>{t('feedback.link.chosen', { key: chosenTask.key })}</p>
          {clientAuthor && chosenTask.visibility !== 'shared' ? (
            <p className={styles.warn}>{t('feedback.internalHidden', { name: mark.author.name })}</p>
          ) : null}
        </>
      ) : null}
      <TextAreaField
        label={t('feedback.reply.label')}
        optional
        rows={3}
        value={reply}
        maxLength={4000}
        disabled={link.isPending}
        onChange={(event) => setReply(event.target.value)}
      />
      <DialogActions error={link.error ? <ErrorBanner>{errorMessage(link.error)}</ErrorBanner> : null}>
        <Button type="button" variant="secondary" size="md" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          type="submit"
          form={formId}
          variant="primary"
          size="md"
          loading={link.isPending}
          disabled={!chosenTask}
        >
          {t('feedback.link.submit')}
        </Button>
      </DialogActions>
    </form>
  );
}

/** "Kártyához kötöm": the mark joins a card that already exists; an internal card shows a client only its state. */
export function LinkCardDialog({
  open,
  mark,
  clientAuthor,
  onClose,
}: {
  open: boolean;
  mark: FeedbackMarkDetail;
  clientAuthor: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('feedback.link.heading')} size="md">
      {open ? <LinkCardForm mark={mark} clientAuthor={clientAuthor} onClose={onClose} /> : null}
    </Dialog>
  );
}
