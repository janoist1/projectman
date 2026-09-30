import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { InboxKind } from '@projectman/shared';
import type { InboxItem } from '@projectman/shared';
import { useBoard, useInbox, useResolveInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatAgo, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import {
  decisionSubject,
  detailsHrefFor,
  isAssignedTo,
  isPositiveResolution,
  newestFirst,
  resolutionLabel,
} from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { InboxCard } from './InboxCard';
import styles from './InboxPage.module.css';

type KindFilter = 'all' | InboxKind;

function RecentDecisions({
  items,
  members,
  myHandle,
}: {
  items: InboxItem[];
  members: MemberIndex;
  myHandle: string | null;
}) {
  return (
    <section className={styles.recent} aria-labelledby="inbox-recent">
      <h2 id="inbox-recent" className={styles.recentTitle}>
        {t('inbox.recent')}
      </h2>
      {items.length === 0 ? <p className={styles.recentEmpty}>{t('inbox.recentEmpty')}</p> : null}
      <ul className={styles.recentList}>
        {items.map((item) => {
          const positive = isPositiveResolution(item);
          return (
            <li key={item.id} className={styles.recentItem}>
              <span
                className={clsx(styles.recentIcon, positive ? styles.recentOk : styles.recentNo)}
                aria-hidden="true"
              >
                <Icon name={positive ? 'check' : 'close'} size={12} strokeWidth={3} />
              </span>
              <span className={styles.recentText}>
                <span className={styles.recentLine}>
                  {t('inbox.resolutionLine', {
                    decision: resolutionLabel(item),
                    title: decisionSubject(item),
                  })}
                </span>
                <span className={styles.recentMeta}>
                  {item.resolution
                    ? t('inbox.resolvedBy', {
                        who: nameOf(
                          item.resolution.by === 'system' ? null : item.resolution.by,
                          members,
                          myHandle,
                        ),
                        time: formatAgo(item.resolution.at),
                      })
                    : formatAgo(item.createdAt)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Everything that waits for the viewer, by kind. */
export function InboxPage() {
  const { key, myHandle } = useProject();
  const isMobile = useIsMobile();
  const inbox = useInbox(key);
  const board = useBoard(key);
  const { members, pipeline } = useProjectIndexes(key);
  const resolve = useResolveInbox(key, myHandle);
  const toast = useToast();
  const [filter, setFilter] = useState<KindFilter>('all');
  useDocumentTitle(t('inbox.title'), board.data?.project.name);

  const items = inbox.data?.items;
  const mine = useMemo(
    () => newestFirst((items ?? []).filter((item) => item.state === 'open' && isAssignedTo(item, myHandle))),
    [items, myHandle],
  );
  const recent = useMemo(
    () =>
      (items ?? [])
        .filter(
          (item) =>
            item.state !== 'open' && (item.resolution?.by === myHandle || isAssignedTo(item, myHandle)),
        )
        .sort((a, b) => (b.resolution?.at ?? b.createdAt).localeCompare(a.resolution?.at ?? a.createdAt))
        .slice(0, 8),
    [items, myHandle],
  );
  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );

  if (inbox.isPending) return <LoadingState />;
  if (inbox.isError) return <ErrorState error={inbox.error} onRetry={() => void inbox.refetch()} />;

  const visible = filter === 'all' ? mine : mine.filter((item) => item.kind === filter);
  const latest = mine[0];

  return (
    <div className={styles.page}>
      <div className={styles.main}>
        <header className={styles.header}>
          <h1 className={styles.title}>{t('inbox.title')}</h1>
          {/* On phones an empty inbox says it in the empty state below; no repeat here. */}
          {isMobile && !latest ? null : (
            <p className={styles.subtitle}>
              {isMobile && latest
                ? t('inbox.mobileSubtitle', { count: mine.length, time: formatTime(latest.createdAt) })
                : t('inbox.subtitle')}
            </p>
          )}
        </header>
        {isMobile ? null : (
          <SegmentedControl<KindFilter>
            label={t('inbox.filtersLabel')}
            appearance="pills"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: t('inbox.filters.all'), count: mine.length },
              ...InboxKind.options.map((kind) => ({
                value: kind,
                label: t(`inbox.kinds.${kind}`),
                count: mine.filter((item) => item.kind === kind).length,
              })),
            ]}
          />
        )}
        <div className={styles.list}>
          {visible.map((item) => (
            <InboxCard
              key={item.id}
              item={item}
              members={members}
              myHandle={myHandle}
              pipeline={pipeline}
              mobile={isMobile}
              taskTitle={item.taskKey ? (titles.get(item.taskKey) ?? item.taskKey) : null}
              detailsHref={detailsHrefFor(item, key)}
              pending={resolve.isPending && resolve.variables?.item.id === item.id}
              onResolve={(target, body) =>
                resolve.mutate(
                  { item: target, body },
                  { onError: () => toast.show(t('inbox.resolveFailed'), 'error') },
                )
              }
            />
          ))}
          {visible.length === 0 ? (
            <EmptyState
              tone="ok"
              icon="check"
              title={filter === 'all' ? t('inbox.allDoneEverywhere') : t('inbox.allDone')}
            />
          ) : null}
        </div>
        {isMobile ? (
          <RecentDecisions items={recent.slice(0, 4)} members={members} myHandle={myHandle} />
        ) : null}
      </div>
      {isMobile ? null : (
        <aside className={styles.aside}>
          <RecentDecisions items={recent} members={members} myHandle={myHandle} />
        </aside>
      )}
    </div>
  );
}
