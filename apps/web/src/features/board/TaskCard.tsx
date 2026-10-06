import type { LabelView } from '@projectman/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router';
import type { Task } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { PriorityMark } from '../../components/PriorityMark';
import { StageProgress } from '../../components/StageProgress';
import { formatAge } from '../../i18n/format';
import { t } from '../../i18n/t';
import { seniorMarkLabel, showsSeniorMark } from '../../lib/developerLevel';
import { loopSummary } from '../../lib/loop';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { PipelineIndex } from '../../lib/pipeline';
import { cardWorkerRows, prerequisiteLabel } from '../../lib/taskState';
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
  /** The card can be reordered by keyboard (Alt+Up/Down); this element explains how. */
  reorderHelpId?: string | undefined;
  /** The team, to draw the responsible member; without it the member is named by the handle. */
  members?: MemberIndex;
  /** The viewer's handle: their own card shows "Te". */
  myHandle?: string | null;
}

const noMembers: MemberIndex = new Map();

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
  reorderHelpId,
  members = noMembers,
  myHandle = null,
}: TaskCardProps) {
  const pr = prChip(task);
  const rows = compact ? [] : stageRows(task, pipeline);
  const stage = pipeline.stageById.get(task.stageId);
  // A label the status line already names ("● Válaszra vár") is not a chip as well; the drawer lists them all.
  const chipLabels = task.labels.filter((label) => !state.holdingLabels?.includes(label));
  const showMeta = !compact && (pr !== null || chipLabels.length > 0);
  // Said by the status line already when the card stands on it: never twice on one card.
  const prerequisite = state.prerequisite?.key && !state.prerequisite.inLabel ? state.prerequisite : null;
  const workerRows = cardWorkerRows(state);
  const seniorMark = showsSeniorMark(task, pipeline);
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
      aria-describedby={reorderHelpId}
      aria-keyshortcuts={reorderHelpId ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
      data-phase={state.phase}
      data-file={fileState ?? undefined}
    >
      {coverSrc ? <CardCover key={coverSrc} src={coverSrc} thumbnail={compact} /> : null}
      <span className={styles.head}>
        <span className={styles.key}>{task.key}</span>
        {task.priority && task.status !== 'done' && task.status !== 'cancelled' ? (
          <span title={t('priority.markLabel', { level: t(`priority.levels.${task.priority}`) })}>
            <PriorityMark priority={task.priority} />
            <span className="visually-hidden">
              {t('priority.markLabel', { level: t(`priority.levels.${task.priority}`) })}
            </span>
          </span>
        ) : null}
        <StageProgress
          pipeline={pipeline}
          stageId={task.stageId}
          phase={state.phase}
          className={styles.progress}
        />
        {task.assignee ? (
          <Avatar
            member={members.get(task.assignee)}
            handle={task.assignee}
            isMe={task.assignee === myHandle}
            size="xs"
            label={t('board.assigneeLabel', { name: nameOf(task.assignee, members, myHandle) })}
          />
        ) : null}
      </span>
      <span className={styles.titleRow}>
        <span className={styles.title}>{task.title}</span>
      </span>
      {task.parentKey || subtasks.length || prerequisite || task.loop || seniorMark ? (
        <span className={styles.meta}>
          {seniorMark ? (
            <span
              className={clsx(styles.label, styles.senior)}
              title={seniorMarkLabel(task)}
              aria-label={seniorMarkLabel(task)}
            >
              {t('task.level.mark')}
            </span>
          ) : null}
          {task.loop ? (
            <span
              className={clsx(styles.label, styles.loop)}
              title={loopSummary(task.loop, members, myHandle, new Date())}
              aria-label={`${t('loop.mark')}. ${loopSummary(task.loop, members, myHandle, new Date())}`}
            >
              <Icon name="loop" size={12} strokeWidth={2.4} />
              <span>{t('loop.mark')}</span>
            </span>
          ) : null}
          {task.parentKey ? (
            <span className={styles.label}>{t('task.parentChip', { key: task.parentKey })}</span>
          ) : null}
          {prerequisite ? (
            <span
              className={clsx(styles.label, styles.prerequisite)}
              title={prerequisite.cards.map((card) => `${card.key} – ${card.title}`).join('\n')}
              aria-label={
                prerequisite.more > 0
                  ? t('taskStatus.prerequisiteOnMoreLabel', {
                      key: prerequisite.key!,
                      more: prerequisite.more,
                    })
                  : prerequisiteLabel(prerequisite)
              }
            >
              <Icon name="wait" size={12} strokeWidth={2.4} />
              <span>{prerequisiteLabel(prerequisite)}</span>
            </span>
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
          {chipLabels.map((label) => (
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
      <span className={clsx(styles.status, workerRows && styles.statusRows)}>
        <StatusDot phase={state.phase} pulse={state.phase === 'working'} />
        {workerRows ? (
          <span className={styles.workerRows} title={state.workers.map((worker) => worker.line).join('\n')}>
            {workerRows.rows.map((worker, index) => (
              <span key={worker.sessionId} className={styles.workerRow}>
                <span
                  className={clsx(styles.workerText, workerRows.rows.length === 1 && styles.workerTextWrap)}
                >
                  {worker.doing ? (
                    <>
                      <span className="visually-hidden">{worker.line}</span>
                      <span className={styles.workerName} aria-hidden="true">
                        {t('taskStatus.workerName', { name: worker.member.displayName })}
                      </span>{' '}
                      {/* The key replays the fade-in when the member changes its sentence. */}
                      <span key={worker.doing.summary} className={styles.workerSummary} aria-hidden="true">
                        {worker.doing.summary}
                      </span>
                    </>
                  ) : (
                    <span className={styles.workerName}>{worker.sentence}</span>
                  )}
                </span>
                {index === 1 && workerRows.more > 0 ? (
                  <>
                    <span className={styles.workerMore} aria-hidden="true">
                      {t('taskStatus.workersMore', { more: workerRows.more })}
                    </span>
                    <span className="visually-hidden">
                      {t('taskStatus.workersMoreLabel', { more: workerRows.more })}
                    </span>
                  </>
                ) : null}
              </span>
            ))}
          </span>
        ) : (
          <span
            className={styles.statusText}
            title={
              state.workers.length > 0
                ? state.workers.map((worker) => worker.sentence).join('\n')
                : state.prerequisite?.inLabel
                  ? state.prerequisite.cards.map((card) => `${card.key} – ${card.title}`).join('\n')
                  : undefined
            }
          >
            {state.label}
          </span>
        )}
        {compact ? (
          <span className={styles.age}>{stage?.name}</span>
        ) : state.phase !== 'done' ? (
          <span className={styles.age}>{formatAge(state.since)}</span>
        ) : null}
      </span>
      {fileState ? (
        <span className={styles.dropBar}>
          <Icon name={fileState === 'over' ? 'paperclip' : 'close'} size={14} strokeWidth={2.4} />
          {t(fileState === 'over' ? 'attachments.dropActive' : 'attachments.dropDenied')}
        </span>
      ) : null}
    </Link>
  );
}
