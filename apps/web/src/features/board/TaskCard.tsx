import type { LabelView } from '@projectman/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Task } from '@projectman/shared';
import { StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { StageProgress } from '../../components/StageProgress';
import { formatAge } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState } from '../../lib/taskState';
import { prChip, stageRows } from './cardModel';
import { LabelChip } from '../../components/LabelChip';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: Task;
  subtasks?: readonly Task[];
  state: TaskState;
  pipeline: PipelineIndex;
  to: string;
  selected?: boolean;
  /** Phone list: no checks, stage name next to the status. */
  compact?: boolean;
  /** The project's label definitions (names, colours, meanings). */
  labels?: readonly LabelView[];
  /** Where the small preview of the card's first image is (its cover); none: the card has no image. */
  coverSrc?: string | null;
  /** Files of this card on their way (waiting or sending). */
  uploading?: number;
  /** A file is dragged over the card: it will be attached here (`over`) or may not be (`denied`). */
  fileState?: 'over' | 'denied' | null;
}

/**
 * The card's first image: a low strip over the whole card (a small thumbnail on the phone). The place
 * is fixed from the start, so the card does not jump when the image arrives; an image that does not
 * load leaves no trace.
 */
function CardCover({ src, thumbnail }: { src: string; thumbnail: boolean }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  if (state === 'failed') return null;
  return (
    <span className={clsx(styles.cover, thumbnail && styles.thumbnail)} data-state={state} aria-hidden="true">
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onLoad={() => setState('loaded')}
        onError={() => setState('failed')}
      />
    </span>
  );
}

export function TaskCard({
  task,
  state,
  pipeline,
  to,
  selected = false,
  compact = false,
  subtasks = [],
  labels = [],
  coverSrc = null,
  uploading = 0,
  fileState = null,
}: TaskCardProps) {
  const pr = prChip(task);
  const rows = compact ? [] : stageRows(task, pipeline);
  const stage = pipeline.stageById.get(task.stageId);
  const showMeta = !compact && (pr !== null || task.labels.length > 0);
  return (
    <Link
      to={to}
      draggable={false}
      className={clsx(
        styles.card,
        selected && styles.selected,
        compact && styles.compact,
        compact && coverSrc && styles.hasThumbnail,
        fileState && styles.fileTarget,
      )}
      aria-current={selected ? 'true' : undefined}
      data-phase={state.phase}
      data-file={fileState ?? undefined}
    >
      {coverSrc ? <CardCover key={coverSrc} src={coverSrc} thumbnail={compact} /> : null}
      <StageProgress pipeline={pipeline} stageId={task.stageId} phase={state.phase} />
      <span className={styles.titleRow}>
        <span className={styles.title}>{task.title}</span>
      </span>
      {task.parentKey || subtasks.length ? (
        <span className={styles.meta}>
          {task.parentKey ? (
            <span className={styles.label}>{t('task.parentChip', { key: task.parentKey })}</span>
          ) : null}
          {subtasks.length ? (
            <span
              className={styles.label}
              aria-label={t('task.subtaskProgress', {
                done: subtasks.filter((child) => child.status === 'done').length,
                total: subtasks.length,
              })}
            >
              {t('task.subtaskCount', {
                done: subtasks.filter((child) => child.status === 'done').length,
                total: subtasks.length,
              })}
            </span>
          ) : null}
        </span>
      ) : null}
      {showMeta || uploading > 0 ? (
        <span className={styles.meta}>
          {uploading > 0 ? (
            <span className={styles.uploading} role="status">
              <span className={styles.spinner} aria-hidden="true" />
              {uploading > 1
                ? t('attachments.uploadingCount', { count: uploading })
                : t('attachments.uploading')}
            </span>
          ) : null}
          {pr ? (
            <span className={clsx(styles.pr, pr.merged && styles.prMerged)}>
              <Icon name={pr.merged ? 'prMerged' : 'prOpen'} size={13} strokeWidth={2.1} />
              <span>{pr.label}</span>
            </span>
          ) : null}
          {task.labels.map((label) => (
            <LabelChip key={label} id={label} labels={labels} />
          ))}
        </span>
      ) : null}
      {rows.length > 0 ? (
        <ul className={styles.stageRows} aria-label={t('taskCard.stageRows')}>
          {rows.map((row) => (
            <li key={row.label} className={styles.stageRow} data-state={row.state}>
              <span className={styles.stageIcon} aria-hidden="true">
                <Icon name={row.state === 'done' ? 'check' : 'wait'} size={10} strokeWidth={3.2} />
              </span>
              <span>{row.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className={styles.status}>
        <StatusDot phase={state.phase} pulse={state.phase === 'working'} />
        <span className={styles.statusText}>{state.label}</span>
        {compact ? (
          <span className={styles.age}>
            {stage?.name}
            {' · '}
            <span className={styles.key}>{task.key}</span>
          </span>
        ) : state.phase !== 'done' ? (
          <span className={styles.age}>{formatAge(state.since)}</span>
        ) : null}
      </span>
      {compact ? null : <span className="visually-hidden">{task.key}</span>}
      {fileState ? (
        <span className={styles.dropBar}>
          <Icon name={fileState === 'over' ? 'paperclip' : 'close'} size={14} strokeWidth={2.4} />
          {t(fileState === 'over' ? 'attachments.dropActive' : 'attachments.dropDenied')}
        </span>
      ) : null}
    </Link>
  );
}
