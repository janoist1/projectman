import clsx from 'clsx';
import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { isOpenTask, isTheme, Task } from '@projectman/shared';
import { useCreateTask, useUpdateTask } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { TextField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import {
  DIALOG_KINDS,
  addRelationChange,
  candidateRefusal,
  candidates,
  relationErrorText,
  whyText,
} from './relationModel';
import type { Candidate, DialogKind } from './relationModel';
import drawer from './drawer.module.css';
import styles from './RelationDialog.module.css';

/** What the dialog says that will happen, with the direction spoken out. */
function previewText(kind: DialogKind | null, target: string | null, task: Task): string {
  if (!kind) return t('relationDialog.preview.pickKind');
  if (kind === 'subtask') return t('relationDialog.preview.subtask');
  if (!target) return t('relationDialog.preview.pickCard');
  switch (kind) {
    case 'part_of':
      return [
        t('relationDialog.preview.part_of', { key: target }),
        task.parentKey ? t('relationDialog.preview.leaveParent', { key: task.parentKey }) : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'prerequisite':
      return t('relationDialog.preview.prerequisite', { key: target });
    case 'related':
      return t('relationDialog.preview.related', { from: task.key, key: target });
    case 'duplicate_of':
      return isOpenTask(task)
        ? t('relationDialog.preview.duplicate', { key: target })
        : t('relationDialog.preview.duplicateClosed');
  }
}

/** The reason a kind cannot be chosen for this card, or null. */
function kindOff(kind: DialogKind, task: Task, tasks: readonly Task[]): string | null {
  // A theme is no collection, no part and has no prerequisites (the shared rules refuse them too).
  if (isTheme(task)) {
    if (kind === 'part_of') return t('relationDialog.off.themePartOf');
    if (kind === 'prerequisite') return t('relationDialog.off.themePrerequisite');
    if (kind === 'subtask') return t('relationDialog.off.themeSubtask');
  }
  if (kind === 'part_of' && tasks.some((card) => card.parentKey === task.key))
    return t('relationDialog.off.part_of');
  if (kind === 'subtask' && task.parentKey) return t('relationDialog.off.subtask');
  return null;
}

function CandidateRow({
  candidate,
  id,
  active,
  selected,
  pipeline,
  onChoose,
}: {
  candidate: Candidate;
  id: string;
  active: boolean;
  selected: boolean;
  pipeline: PipelineIndex;
  onChoose: () => void;
}) {
  const { card, why } = candidate;
  const closed = !isOpenTask(card);
  const column = pipeline.columnOfStage.get(card.stageId);
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      aria-disabled={why ? true : undefined}
      aria-describedby={why ? `${id}-why` : undefined}
      className={clsx(styles.option, active && styles.active, why && styles.off)}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (!why) onChoose();
      }}
    >
      <span className={styles.optionLine}>
        <span className={styles.key}>{card.key}</span>
        <span className={styles.title}>{card.title}</span>
        <Chip
          tone={closed ? (card.status === 'done' ? 'ok' : 'neutral') : 'column'}
          data-column-color={closed ? undefined : column?.color}
        >
          {closed
            ? t(`taskStatus.statuses.${card.status}`)
            : (pipeline.stageById.get(card.stageId)?.name ?? card.stageId)}
        </Chip>
      </span>
      {why ? (
        <span id={`${id}-why`} className={styles.why}>
          {whyText(why)}
        </span>
      ) : null}
    </li>
  );
}

function RelationForm({
  task,
  tasks,
  pipeline,
  onClose,
}: {
  task: Task;
  tasks: readonly Task[];
  pipeline: PipelineIndex;
  onClose: () => void;
}) {
  const { key } = useProject();
  const toast = useToast();
  const update = useUpdateTask(key);
  const create = useCreateTask(key);
  const [kind, setKind] = useState<DialogKind | null>(null);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<string | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const listId = useId();
  const pending = update.isPending || create.isPending;
  const error = update.error ?? create.error;
  const kinds: DialogKind[] = [...DIALOG_KINDS, 'subtask'];
  const off = (candidate: DialogKind) => kindOff(candidate, task, tasks);

  const list =
    kind && kind !== 'subtask' ? candidates(kind, task, tasks, query) : { rows: [] as Candidate[], total: 0 };
  // The chosen card stays on the list (first) when a later search no longer matches it.
  const relation = kind && kind !== 'subtask' ? kind : null;
  const keptCard =
    relation && target && !list.rows.some((row) => row.card.key === target)
      ? tasks.find((card) => card.key === target)
      : undefined;
  const rows: Candidate[] =
    relation && keptCard
      ? [{ card: keptCard, why: candidateRefusal(relation, task, keptCard, tasks) }, ...list.rows]
      : list.rows;
  const chosenRow = rows.find((row) => row.card.key === target && !row.why);
  const duplicate = kind === 'duplicate_of' && isOpenTask(task);
  const ready = kind === 'subtask' ? title.trim() !== '' : Boolean(kind && chosenRow);

  const pick = (next: DialogKind) => {
    if (off(next) || next === kind) return;
    setKind(next);
    setTarget(null);
    setActive(null);
    update.reset();
    create.reset();
  };
  const moveKind = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const enabled = kinds.filter((candidate) => !off(candidate));
    const at = kind ? enabled.indexOf(kind) : -1;
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (next) {
      pick(next);
      document.getElementById(`${listId}-kind-${next}`)?.focus();
    }
  };

  const submit = () => {
    if (!ready || pending || !kind) return;
    if (kind === 'subtask') {
      create.mutate(
        { title: title.trim(), parentKey: task.key, repo: task.repo, visibility: task.visibility },
        {
          onSuccess: (created) => {
            const card = Task.safeParse(created);
            toast.show(
              t('timeline.relationAdded', {
                kind: t('relations.kinds.has_part'),
                ref: card.success ? card.data.key : title.trim(),
              }),
            );
            onClose();
          },
        },
      );
      return;
    }
    const to = chosenRow!.card.key;
    update.mutate(
      { taskKey: task.key, body: { relations: addRelationChange(kind, to, task) } },
      {
        onSuccess: () => {
          toast.show(
            duplicate
              ? t('relationDialog.duplicated', { key: to })
              : t('timeline.relationAdded', { kind: t(`relations.kinds.${kind}`), ref: to }),
          );
          onClose();
        },
      },
    );
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const choosable = rows.filter((row) => !row.why);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (choosable.length === 0) return;
      const at = choosable.findIndex((row) => row.card.key === active);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(choosable[(at + step + choosable.length) % choosable.length]!.card.key);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = choosable.find((entry) => entry.card.key === active);
      // Enter chooses the highlighted card; Enter on the chosen one saves.
      if (row && row.card.key !== target) setTarget(row.card.key);
      else if (ready) submit();
    }
  };

  const hint = kind ? t(`relationDialog.hints.${kind}`) : t('relationDialog.kindPrompt');
  const hintMove =
    kind === 'part_of' && task.parentKey ? ` ${t('relationDialog.hintMove', { key: task.parentKey })}` : '';
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className={styles.field}>
        <span className={styles.label} id={`${listId}-kind`}>
          {t('relationDialog.kind')}
        </span>
        <div
          role="radiogroup"
          aria-labelledby={`${listId}-kind`}
          className={styles.kinds}
          onKeyDown={moveKind}
        >
          {kinds.map((candidate) => {
            const reason = off(candidate);
            return (
              <button
                key={candidate}
                id={`${listId}-kind-${candidate}`}
                type="button"
                role="radio"
                aria-checked={kind === candidate}
                aria-disabled={reason ? true : undefined}
                aria-describedby={reason ? `${listId}-off-${candidate}` : undefined}
                tabIndex={
                  kind === candidate || (kind === null && candidate === kinds.find((k) => !off(k))) ? 0 : -1
                }
                className={clsx(styles.kind, reason && styles.kindOff)}
                onClick={() => pick(candidate)}
              >
                {candidate === 'subtask' ? t('relationDialog.newSubtask') : t(`relations.kinds.${candidate}`)}
              </button>
            );
          })}
        </div>
        {kinds
          .filter((candidate) => off(candidate))
          .map((candidate) => (
            <span key={candidate} id={`${listId}-off-${candidate}`} className={styles.why}>
              {off(candidate)}
            </span>
          ))}
        <p className={styles.hint} aria-live="polite">
          {hint}
          {hintMove}
        </p>
      </div>

      {kind === 'subtask' ? (
        <TextField
          label={t('relationDialog.subtaskTitle')}
          value={title}
          autoFocus
          disabled={pending}
          onChange={(event) => setTitle(event.target.value)}
        />
      ) : kind ? (
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${listId}-search`}>
            {t('relationDialog.card')}
          </label>
          <input
            id={`${listId}-search`}
            className={styles.search}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? `${listId}-${active}` : undefined}
            placeholder={t('relationDialog.search')}
            autoComplete="off"
            value={query}
            disabled={pending}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(null);
            }}
            onKeyDown={onSearchKey}
          />
          {rows.length > 0 ? (
            <ul id={listId} role="listbox" aria-label={t('relationDialog.card')} className={styles.options}>
              {rows.map((row) => (
                <CandidateRow
                  key={row.card.key}
                  id={`${listId}-${row.card.key}`}
                  candidate={row}
                  active={active === row.card.key}
                  selected={target === row.card.key}
                  pipeline={pipeline}
                  onChoose={() => {
                    setTarget(row.card.key);
                    setActive(row.card.key);
                  }}
                />
              ))}
            </ul>
          ) : (
            <p id={listId} className={styles.empty}>
              {t('relationDialog.noMatch')}
            </p>
          )}
          {keptCard && list.rows.length === 0 ? (
            <p className={styles.empty}>{t('relationDialog.noMatch')}</p>
          ) : null}
          {list.total > list.rows.length ? <p className={styles.hint}>{t('relationDialog.refine')}</p> : null}
        </div>
      ) : null}

      <div className={styles.foot}>
        {error ? (
          <p className={drawer.error} role="alert">
            {t('relationDialog.failed', { reason: relationErrorText(error) })}
          </p>
        ) : null}
        <p className={clsx(styles.preview, duplicate && styles.warn)}>
          {previewText(kind, chosenRow?.card.key ?? null, task)}
        </p>
        <div className={styles.actions}>
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            variant={duplicate ? 'dangerSolid' : 'primary'}
            loading={pending}
            disabled={!ready}
          >
            {pending
              ? t('relationDialog.saving')
              : kind === 'subtask'
                ? t('relationDialog.submitSubtask')
                : duplicate
                  ? t('relationDialog.submitDuplicate')
                  : t('relationDialog.submit')}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** "+ Kapcsolat": the kind first (no default: the direction matters), then the card, then what will happen. */
export function RelationDialog({
  open,
  onClose,
  task,
  tasks,
  pipeline,
}: {
  open: boolean;
  onClose: () => void;
  task: Task;
  tasks: readonly Task[];
  pipeline: PipelineIndex;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t('relationDialog.title')}
      description={`${task.key} · ${task.title}`}
      size="md"
    >
      <RelationForm task={task} tasks={tasks} pipeline={pipeline} onClose={onClose} />
    </Dialog>
  );
}
