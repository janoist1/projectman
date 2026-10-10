import clsx from 'clsx';
import { Fragment } from 'react';
import { Link } from 'react-router';
import { staleDays } from '@projectman/shared';
import type { BoardColumnView } from '@projectman/shared';
import { Chip } from '../../components/Chip';
import { StateMark } from '../../components/StateMark';
import { formatAge } from '../../i18n/format';
import { t } from '../../i18n/t';
import { NextLine } from '../board/NextLine';
import type { ZoomCard, Waiting } from './groupModel';
import styles from './MapCard.module.css';

const SENTINEL = '\u0000';

export interface MapCardProps {
  card: ZoomCard;
  /** The card's drawer, over the map. */
  to: string;
  now: number;
  /** What the card waits for beyond the arrows. */
  waiting: Waiting;
  /** The cards outside this group, by key: their wait is marked "(másik csoport)". */
  elsewhere: ReadonlySet<string>;
  /** Where a prerequisite that is not on the map opens. */
  hrefOf: (taskKey: string) => string;
  /** The prerequisites on the map, to scroll to (the phone list has no arrows). */
  jumpable: ReadonlySet<string>;
  onJump: (taskKey: string) => void;
  /** The column chip, on the phone list. */
  column: BoardColumnView | null;
  /** The arrows touching this card: lit, and the others dim. */
  linked: boolean;
  flash: boolean;
  onActive: (taskKey: string | null) => void;
  itemRef: (element: HTMLLIElement | null) => void;
}

/** "Vár erre: {keys}" with each key a link of its own: the text around the keys comes from the locale. */
function Waits({
  waiting,
  elsewhere,
  hrefOf,
  jumpable,
  onJump,
}: Pick<MapCardProps, 'waiting' | 'elsewhere' | 'hrefOf' | 'jumpable' | 'onJump'>) {
  const [before = '', after = ''] = t('map.waitsFor', { keys: SENTINEL }).split(SENTINEL);
  return (
    <p className={styles.waits}>
      <span aria-hidden="true">↳ </span>
      {before}
      {waiting.keys.map((key, index) => (
        <Fragment key={key}>
          <span className={styles.wait}>
            {jumpable.has(key) ? (
              <button type="button" className={styles.keyLink} onClick={() => onJump(key)}>
                {key}
              </button>
            ) : (
              <Link to={hrefOf(key)} className={styles.keyLink}>
                {key}
              </Link>
            )}
            {elsewhere.has(key) ? ` ${t('map.otherGroup')}` : null}
            {index < waiting.keys.length - 1 ? ',' : null}
          </span>
          {/* Outside the unbreakable part: a long list wraps between the keys. */}
          {index < waiting.keys.length - 1 ? ' ' : null}
        </Fragment>
      ))}
      {after}
    </p>
  );
}

/**
 * One open card on the map (PM-407): the board's own state line, its key and age, the title, and what it
 * still waits for. The card opens by its link; the prerequisites are links of their own beside it, never
 * inside it. The arrows are decoration: the same wait is in the text, shown or hidden.
 */
export function MapCard({
  card,
  to,
  now,
  waiting,
  elsewhere,
  hrefOf,
  jumpable,
  onJump,
  column,
  linked,
  flash,
  onActive,
  itemRef,
}: MapCardProps) {
  const { task, state, mapState, stale } = card;
  const label = stale ? t('map.stale', { label: state.label }) : state.label;
  const drawn = waiting.drawn.length > 0 ? t('map.waitsFor', { keys: waiting.drawn.join(', ') }) : null;
  return (
    <li
      ref={itemRef}
      className={clsx(styles.card, flash && styles.flash)}
      data-card-key={task.key}
      data-phase={mapState}
      data-linked={linked ? '' : undefined}
      onPointerEnter={() => onActive(task.key)}
      onPointerLeave={() => onActive(null)}
      onFocus={() => onActive(task.key)}
      onBlur={(event) => {
        // Moving on to the card's own prerequisite links keeps it lit.
        if (!event.currentTarget.contains(event.relatedTarget)) onActive(null);
      }}
    >
      <Link to={to} className={styles.open}>
        <span className={styles.head}>
          <span className={styles.key}>{task.key}</span>
          {column ? (
            <Chip tone="column" data-column-color={column.color} className={styles.column}>
              {column.name}
            </Chip>
          ) : null}
          {stale ? (
            <span className={clsx(styles.age, styles.staleAge)}>
              {t('map.staleAge', { days: staleDays(task, now) })}
            </span>
          ) : (
            <span className={styles.age}>{formatAge(state.since)}</span>
          )}
        </span>
        <span className={styles.title}>{task.title}</span>
        <span className={styles.status} title={state.next ? undefined : label}>
          <StateMark state={mapState} />
          <span className="visually-hidden">{t(`map.legend.${mapState}`)}: </span>
          {state.next ? (
            <NextLine
              next={state.next}
              className={styles.statusText}
              prefix={stale ? t('map.stalePrefix') : undefined}
            />
          ) : (
            <span className={styles.statusText}>{label}</span>
          )}
        </span>
      </Link>
      {drawn ? <span className="visually-hidden">{drawn}</span> : null}
      {waiting.keys.length > 0 ? (
        <Waits waiting={waiting} elsewhere={elsewhere} hrefOf={hrefOf} jumpable={jumpable} onJump={onJump} />
      ) : null}
    </li>
  );
}
