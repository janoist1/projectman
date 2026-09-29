import clsx from 'clsx';
import { Link } from 'react-router';
import type { Task } from '@projectman/shared';
import { StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { StageProgress } from '../../components/StageProgress';
import { formatAge } from '../../i18n/format';
import { t } from '../../i18n/t';
import type { PipelineIndex } from '../../lib/pipeline';
import type { TaskState } from '../../lib/taskState';
import { cardChecks, prChip } from './cardModel';
import styles from './TaskCard.module.css';

interface TaskCardProps {
  task: Task;
  state: TaskState;
  pipeline: PipelineIndex;
  to: string;
  selected?: boolean;
  /** Phone list: no checks, stage name next to the status. */
  compact?: boolean;
}

export function TaskCard({ task, state, pipeline, to, selected = false, compact = false }: TaskCardProps) {
  const pr = prChip(task);
  const checks = compact ? [] : cardChecks(task, pipeline);
  const stage = pipeline.stageById.get(task.stageId);
  const showMeta = !compact && (pr !== null || task.labels.length > 0);
  return (
    <Link
      to={to}
      className={clsx(styles.card, selected && styles.selected, compact && styles.compact)}
      aria-current={selected ? 'true' : undefined}
      data-phase={state.phase}
    >
      <StageProgress pipeline={pipeline} stageId={task.stageId} phase={state.phase} />
      <span className={styles.titleRow}>
        <span className={styles.title}>{task.title}</span>
      </span>
      {showMeta ? (
        <span className={styles.meta}>
          {pr ? (
            <span className={clsx(styles.pr, pr.merged && styles.prMerged)}>
              <Icon name={pr.merged ? 'prMerged' : 'prOpen'} size={13} strokeWidth={2.1} />
              <span>{pr.label}</span>
            </span>
          ) : null}
          {task.labels.map((label) => (
            <span key={label} className={styles.label}>
              {label}
            </span>
          ))}
        </span>
      ) : null}
      {checks.length > 0 ? (
        <ul className={styles.checks} aria-label={t('taskCard.checks')}>
          {checks.map((check) => (
            <li key={check.label} className={styles.check} data-check={check.tone}>
              <span className={styles.checkIcon} aria-hidden="true">
                <Icon name={check.tone === 'ok' ? 'check' : check.tone === 'warn' ? 'exclamation' : 'wait'} size={10} strokeWidth={3.2} />
              </span>
              <span>{check.label}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <span className={styles.status}>
        <StatusDot phase={state.phase} pulse={state.phase === 'working'} />
        <span className={styles.statusText}>{state.label}</span>
        {compact ? (
          <span className={styles.age}>{stage?.name}</span>
        ) : state.phase !== 'done' ? (
          <span className={styles.age}>{formatAge(state.since)}</span>
        ) : null}
      </span>
      <span className="visually-hidden">{task.key}</span>
    </Link>
  );
}
