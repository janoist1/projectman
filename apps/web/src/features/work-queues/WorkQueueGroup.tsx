import { useEffect, useRef, useState } from 'react';
import { isWorkQueueLongWait } from '@projectman/shared';
import type { WorkQueueGroup as Group } from '@projectman/shared';
import { useWorkQueue } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import { OpenWorkQueueItem } from './WorkQueueItem';
import { hiddenItemCount, isCutGroup, matchesWorkQueueFilter } from './workQueueFilters';
import type { WorkQueueFilter } from './workQueueFilters';
import styles from './WorkQueueGroup.module.css';

/** Whether the connected Claude is attached now: a key that has not expired. */
function connectedOwners(group: Group, nowMs: number): string[] {
  return (group.connections ?? [])
    .filter((connection) => connection.expiresAt === null || Date.parse(connection.expiresAt) > nowMs)
    .map((connection) => connection.owner);
}

function GroupHead({ group, nowMs, counts }: { group: Group; nowMs: number; counts: boolean }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const { queue } = group;
  const owners = connectedOwners(group, nowMs);
  const name =
    queue.type === 'integrator' ? t('workQueues.integrator.name') : nameOf(queue.member, members, myHandle);
  const sub =
    queue.type === 'integrator'
      ? [
          owners.map((owner) => nameOf(owner, members, myHandle)).join(', ') || null,
          t('workQueues.integrator.meta'),
          t(owners.length > 0 ? 'workQueues.integrator.connected' : 'workQueues.integrator.disconnected'),
        ]
          .filter(Boolean)
          .join(' · ')
      : `@${queue.member}`;
  const long = group.items.filter((item) => isWorkQueueLongWait(item, nowMs)).length;
  return (
    <header className={styles.head}>
      <div className={styles.identity}>
        <span className={styles.avatar} aria-hidden="true">
          {queue.type === 'integrator' ? 'C' : queue.member.slice(0, 2)}
        </span>
        <div>
          <h3 className={styles.name}>{name}</h3>
          <small>{sub}</small>
        </div>
      </div>
      {counts ? (
        <div className={styles.counts}>
          <span>{t('workQueues.group.waiting', { count: group.queued ?? 0 })}</span>
          {(group.processing ?? 0) > 0 ? (
            <span className={styles.live}>
              {t('workQueues.group.processing', { count: group.processing ?? 0 })}
            </span>
          ) : null}
          {long > 0 ? (
            <span className={styles.warn}>
              {t('workQueues.group.long', { count: isCutGroup(group) ? `≥ ${long}` : long })}
            </span>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}

/** One queue: its head and the items that match the filters; a cut group loads the rest on request. */
export function WorkQueueGroup({
  group,
  filter,
  nowMs,
  emptyText,
}: {
  group: Group;
  filter: WorkQueueFilter;
  nowMs: number;
  /** What an empty queue says (the overview's own sentence when not given). */
  emptyText?: string;
}) {
  const { key } = useProject();
  const [expanded, setExpanded] = useState(false);
  const detail = useWorkQueue(key, group.queue, null, expanded);
  const list = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);
  const cut = isCutGroup(group);
  const full = expanded ? detail.data : undefined;
  const source = full?.items ?? group.items;
  const items = source.filter((item) => matchesWorkQueueFilter(item, filter, nowMs));

  // After "További tételek" the focus goes to the first item that was not on screen before.
  useEffect(() => {
    if (!full || focusFrom.current === null) return;
    const rows = list.current?.querySelectorAll<HTMLElement>('[data-work-queue-item]');
    rows?.[focusFrom.current]?.focus();
    focusFrom.current = null;
  }, [full]);

  const loadMore = () => {
    if (!expanded) {
      focusFrom.current = group.items.filter((item) => matchesWorkQueueFilter(item, filter, nowMs)).length;
      setExpanded(true);
    } else if (detail.isError) {
      void detail.refetch();
    }
  };
  const loading = expanded && !full && !detail.isError;
  const stillCut = full ? full.items.length < (full.queued ?? 0) + (full.processing ?? 0) : cut;

  return (
    <section className={styles.group}>
      <GroupHead group={group} nowMs={nowMs} counts />
      {items.length > 0 ? (
        <ul ref={list} className={styles.list}>
          {items.map((item) => (
            <OpenWorkQueueItem key={item.id} item={item} nowMs={nowMs} />
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{emptyText ?? t('workQueues.group.empty')}</p>
      )}
      {cut && !full ? (
        <div className={styles.more}>
          {detail.isError ? (
            <span role="alert" className={styles.warn}>
              {t('workQueues.group.moreFailed')}
            </span>
          ) : null}
          <Button variant="secondary" size="md" onClick={loadMore}>
            {loading
              ? t('workQueues.group.moreLoading')
              : t('workQueues.group.more', { count: hiddenItemCount(group) })}
          </Button>
        </div>
      ) : null}
      {full && stillCut ? (
        <p className={styles.limited}>{t('workQueues.group.limited', { count: full.items.length })}</p>
      ) : null}
    </section>
  );
}

/** A queue the viewer sees but whose items they may not (the connected Claude's, to an admin). */
export function RestrictedWorkQueueGroup({ group, nowMs }: { group: Group; nowMs: number }) {
  return (
    <section className={styles.group}>
      <GroupHead group={group} nowMs={nowMs} counts={false} />
      <p className={styles.empty}>{t('workQueues.integrator.restricted')}</p>
    </section>
  );
}
