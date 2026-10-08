import clsx from 'clsx';
import { Link } from 'react-router';
import type { MapGroup, MapState } from '@projectman/shared';
import { ColumnBar } from '../../components/ColumnBar';
import { StateMark } from '../../components/StateMark';
import { t } from '../../i18n/t';
import { columnSegments } from '../../lib/pipeline';
import type { PipelineIndex } from '../../lib/pipeline';
import styles from './GroupTile.module.css';

/** The most urgent signal of a group colours the tile's left edge. */
function topSignal(group: MapGroup): 'needs' | 'blocked' | 'working' | null {
  if (group.signals.needsYou > 0) return 'needs';
  if (group.signals.blocked > 0) return 'blocked';
  if (group.signals.working > 0) return 'working';
  return null;
}

function Signal({ state, text }: { state: MapState; text: string }) {
  return (
    <span className={styles.signal} data-phase={state}>
      <StateMark state={state} />
      {text}
    </span>
  );
}

/**
 * One group of the overview (PM-379): its kind and key, its title, the progress bar by board column
 * and the signals that need a look. The whole tile is a link to the group's zoomed view.
 */
export function GroupTile({
  group,
  title,
  base,
  pipeline,
  flash,
  itemRef,
}: {
  group: MapGroup;
  title: string;
  /** The map's path in the project, `/p/AC/map`. */
  base: string;
  pipeline: PipelineIndex;
  flash: boolean;
  itemRef: (element: HTMLLIElement | null) => void;
}) {
  const { signals, progress } = group;
  const segments = columnSegments(progress.byStage, pipeline);
  const distribution = segments
    .map(({ column, count }) => t('board.themes.columnCount', { column: column.name, count }))
    .join(' · ');
  const kind = t(`map.kind.${group.kind}`);
  const hasSignal = signals.needsYou + signals.blocked + signals.working > 0;
  return (
    <li ref={itemRef} className={clsx(styles.item, flash && styles.flash)} data-group={group.key}>
      <Link
        to={`${base}/${group.key}`}
        className={styles.tile}
        data-top={topSignal(group) ?? undefined}
        aria-label={t('map.tileLabel', {
          kind,
          title,
          needs: signals.needsYou,
          blocked: signals.blocked,
          working: signals.working,
          done: progress.done,
          total: progress.total,
        })}
      >
        <span className={styles.kind}>
          <span className={styles.kindName}>{kind}</span>
          {group.kind !== 'other' ? <span className={styles.key}>{group.key}</span> : null}
        </span>
        <span className={styles.title} title={title}>
          {title}
        </span>
        <span className={styles.progress} title={distribution || undefined}>
          <ColumnBar segments={segments} total={progress.total} />
          <span className={styles.count}>
            {t('map.progress', { done: progress.done, total: progress.total })}
          </span>
        </span>
        <span className={styles.signals}>
          {signals.needsYou > 0 ? (
            <Signal state="needs_you" text={t('map.signals.needsYou', { count: signals.needsYou })} />
          ) : null}
          {signals.blocked > 0 ? (
            <Signal state="blocked" text={t('map.signals.blocked', { count: signals.blocked })} />
          ) : null}
          {signals.working > 0 ? (
            <Signal state="working" text={t('map.signals.working', { count: signals.working })} />
          ) : null}
          {!hasSignal ? <Quiet group={group} /> : null}
        </span>
      </Link>
    </li>
  );
}

/** What a group says when nothing needs a look: who it waits for, or why there is nothing to wait for. */
function Quiet({ group }: { group: MapGroup }) {
  const { signals, progress } = group;
  if (signals.waiting > 0) {
    return <Signal state="waiting" text={t('map.signals.waiting', { count: signals.waiting })} />;
  }
  if (progress.total > 0 && progress.done === progress.total) {
    return <Signal state="done" text={t('map.allDone')} />;
  }
  return (
    <span className={styles.signal} data-phase="waiting">
      {progress.total === 0 ? t('map.signals.noCards') : t('map.signals.noneOpen')}
    </span>
  );
}
