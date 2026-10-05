import clsx from 'clsx';
import type { CSSProperties, ReactNode } from 'react';
import { Avatar, AvatarStack } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { labelName } from '../../lib/labels';
import { memberLike, useMapView, useShowProps } from './MapContext';
import { showValue } from './model';
import type { ShowTarget } from './model';
import styles from './HowWeWork.module.css';

/** A label as a button that opens its details; `when` marks a condition that binds only some cards, `lacks` one that must not hold. */
export function LabelButton({ id, when, lacks = false }: { id: string; when?: string; lacks?: boolean }) {
  const { map, labels } = useMapView();
  const props = useShowProps({ kind: 'label', id });
  const entry = map.labels.find((label) => label.label.id === id);
  const style = entry?.label.color
    ? ({
        '--lab-fg': `var(--column-${entry.label.color}-fg)`,
        '--lab-bg': `var(--column-${entry.label.color}-bg)`,
      } as CSSProperties)
    : undefined;
  return (
    <button
      type="button"
      className={clsx(styles.chip, when && styles.cond, lacks && styles.lacks)}
      style={style}
      title={entry?.label.meaning || undefined}
      {...props}
    >
      {entry?.approval ? (
        <span className={styles.human} title={t('howWeWork.humanOnlyHidden')}>
          <Icon name="user" size={13} strokeWidth={2.4} />
        </span>
      ) : null}
      <span className={styles.chipName}>{labelName(id, labels)}</span>
      {when ? (
        <span className={styles.when}>{t('howWeWork.flow.when', { name: labelName(when, labels) })}</span>
      ) : null}
    </button>
  );
}

/** A label shown in its colour, but not a button (a heading of its own panel, the legend). */
export function LabelTag({ id, big = false }: { id: string; big?: boolean }) {
  const { map, labels } = useMapView();
  const entry = map.labels.find((label) => label.label.id === id);
  const style = entry?.label.color
    ? ({
        '--lab-fg': `var(--column-${entry.label.color}-fg)`,
        '--lab-bg': `var(--column-${entry.label.color}-bg)`,
      } as CSSProperties)
    : undefined;
  return (
    <span className={clsx(styles.chip, styles.chipStatic, big && styles.chipBig)} style={style}>
      {entry?.approval ? (
        <span className={styles.human}>
          <Icon name="user" size={13} strokeWidth={2.4} />
        </span>
      ) : null}
      <span className={styles.chipName}>{labelName(id, labels)}</span>
    </span>
  );
}

/** A word in a sentence that opens another item's details. */
export function ShowLink({ target, children }: { target: ShowTarget; children: ReactNode }) {
  const { select } = useMapView();
  return (
    <button
      type="button"
      className={styles.link}
      data-show={showValue(target)}
      onClick={(event) => select(target, event.currentTarget)}
    >
      {children}
    </button>
  );
}

export function LabelLink({ id }: { id: string }) {
  const { labels } = useMapView();
  return <ShowLink target={{ kind: 'label', id }}>{labelName(id, labels)}</ShowLink>;
}

export function StageLink({ id }: { id: string }) {
  const { stageName } = useMapView();
  return <ShowLink target={{ kind: 'stage', id }}>{stageName(id)}</ShowLink>;
}

export function LabelLinks({ ids }: { ids: readonly string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index === 0 ? null : index === ids.length - 1 ? t('common.and') : t('common.listSeparator')}
          <LabelLink id={id} />
        </span>
      ))}
    </>
  );
}

export function StageLinks({ ids }: { ids: readonly string[] }) {
  return (
    <>
      {ids.map((id, index) => (
        <span key={id}>
          {index === 0 ? null : index === ids.length - 1 ? t('common.and') : t('common.listSeparator')}
          <StageLink id={id} />
        </span>
      ))}
    </>
  );
}

/** The owners of a stage as avatars (the names go next to them, or a count on a phone). */
export function OwnerStack({ handles }: { handles: readonly string[] }) {
  const { member } = useMapView();
  const members = handles.flatMap((handle) => {
    const config = member(handle);
    return config ? [{ member: memberLike(config), handle }] : [];
  });
  return <AvatarStack members={members} max={4} size="sm" />;
}

/** One person or AI member as a row that opens their details. */
export function PersonRow({ handle }: { handle: string }) {
  const { member } = useMapView();
  const config = member(handle);
  if (!config) return null;
  return (
    <ShowRow target={{ kind: 'member', id: handle }}>
      <Avatar member={memberLike(config)} size="sm" />
      <span>{config.displayName}</span>
      <span className={styles.personKind}>
        {config.kind === 'ai' ? t('howWeWork.member.kindAi') : t('howWeWork.member.kindHuman')}
      </span>
    </ShowRow>
  );
}

function ShowRow({ target, children }: { target: ShowTarget; children: ReactNode }) {
  const { select } = useMapView();
  return (
    <button
      type="button"
      className={styles.personRow}
      data-show={showValue(target)}
      onClick={(event) => select(target, event.currentTarget)}
    >
      {children}
    </button>
  );
}
