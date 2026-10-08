import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import { useBoard } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState } from '../../components/States';
import { formatDayHeading, formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { describeStart, describeStop, involvementText } from '../../lib/involvement';
import { useDocumentTitle } from '../../lib/hooks';
import type { InvolvementItem } from '@projectman/shared';
import styles from './InvolvementsPage.module.css';

export function InvolvementRows({
  items,
  arriving,
}: {
  items: readonly InvolvementItem[];
  arriving?: ReadonlySet<string>;
}) {
  const { key, myHandle } = useProject();
  const indexes = useProjectIndexes(key);
  const board = useBoard(key);
  const ctx = { ...indexes, myHandle, labels: board.data?.labels, openInboxIds: new Set<string>() };
  let previousDay = '';
  return (
    <ol className={styles.list}>
      {items.map(({ event, taskTitle }) => {
        const handle = String(event.data.member ?? '');
        const member = indexes.members.get(handle);
        const description =
          event.type === 'session_started' ? describeStart(event, ctx) : describeStop(event, ctx);
        const detail =
          event.data.cause || event.data.stop
            ? involvementText({ ...description, verb: '' })
            : t('involvement.unknown');
        const day = formatDayHeading(event.createdAt);
        const heading = previousDay !== day;
        previousDay = day;
        return (
          <li key={event.id}>
            {heading ? <h3>{day}</h3> : null}
            <div className={clsx(styles.row, arriving?.has(event.id) && styles.arriving)}>
              <Avatar member={member} handle={handle} size="md" />
              <div className={styles.body}>
                <div className={styles.line}>
                  <Link to={`/p/${key}/team/${handle}`}>{member?.displayName ?? handle}</Link>
                  <Chip tone={description.tone ?? 'neutral'}>{description.verb}</Chip>
                  {event.taskKey ? (
                    <Link to={`/p/${key}/tasks/${event.taskKey}#timeline-${event.id}`}>
                      {event.taskKey} · {taskTitle}
                    </Link>
                  ) : (
                    <span>
                      {t(
                        event.data.cause && (event.data.cause as { kind?: string }).kind === 'schedule'
                          ? 'involvement.scheduled'
                          : 'involvement.general',
                      )}
                    </span>
                  )}
                  {event.sessionId ? (
                    <Link to={`/p/${key}/sessions/${event.sessionId}`}>
                      <time dateTime={event.createdAt}>{formatStamp(event.createdAt)}</time>
                    </Link>
                  ) : (
                    <time dateTime={event.createdAt}>{formatStamp(event.createdAt)}</time>
                  )}
                </div>
                {detail ? <p>{detail}</p> : null}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function RecentInvolvements() {
  const { key } = useProject();
  const query = useQuery({
    queryKey: ['involvements', key, 'recent'],
    queryFn: () => api.involvements(key, '?limit=5'),
  });
  if (!query.isError && !query.isPending && !query.data?.items.length) return null;
  return (
    <section className={styles.section} aria-labelledby="recent-involvements">
      <h2 id="recent-involvements">{t('involvement.recent')}</h2>
      {query.isPending ? (
        <div role="status" aria-label={t('app.loading')} className={styles.skeleton} />
      ) : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data ? <InvolvementRows items={query.data.items} /> : null}
      <Link className={styles.all} to={`/p/${key}/sessions`}>
        <span>{t('involvement.all')}</span>
        <Icon name="arrowRight" size={14} />
      </Link>
    </section>
  );
}

export function InvolvementsPage() {
  const { key, myHandle } = useProject();
  const indexes = useProjectIndexes(key);
  const [params, setParams] = useSearchParams();
  const board = useBoard(key);
  useDocumentTitle(t('involvement.title'));
  const period = params.get('period') ?? '7';
  const queryString = new URLSearchParams(params);
  queryString.delete('period');
  if (period !== 'all') {
    const since = new Date();
    if (period === 'today') since.setHours(0, 0, 0, 0);
    else {
      since.setDate(since.getDate() - (period === '30' ? 30 : 7));
      since.setHours(0, 0, 0, 0);
    }
    queryString.set('since', since.toISOString());
  }
  const filter = queryString.toString();
  const query = useInfiniteQuery({
    queryKey: ['involvements', key, filter],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      api.involvements(key, `?${filter}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const change = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(name, value);
    else next.delete(name);
    setParams(next);
  };
  const select = (
    name: string,
    label: string,
    options: [string, string][],
    value = params.get(name) ?? '',
  ) => (
    <label>
      {label}
      <select value={value} onChange={(event) => change(name, event.target.value)}>
        {options.map(([id, text]) => (
          <option key={id} value={id}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const members: [string, string][] = [...indexes.members.values()].map((member) => [
    member.handle,
    member.displayName,
  ]);
  const items = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered =
    ['member', 'by', 'task', 'kind'].some((name) => Boolean(params.get(name))) || period !== '7';
  const firstUse =
    period === 'all' && !['member', 'by', 'task', 'kind'].some((name) => Boolean(params.get(name)));
  const previous = useRef<{ filter: string; head: string; headId: string; ids: Set<string> } | null>(null);
  const [arriving, setArriving] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (!query.data) return;
    const rows = query.data.pages.flatMap((page) => page.items);
    const head = rows[0]?.event.createdAt ?? '';
    const headId = rows[0]?.event.id ?? '';
    const prior = previous.current;
    const newIds =
      prior?.filter === filter && headId !== prior.headId && head >= prior.head
        ? rows
            .filter(({ event }) => !prior.ids.has(event.id) && event.createdAt >= prior.head)
            .map(({ event }) => event.id)
        : [];
    previous.current = { filter, head, headId, ids: new Set(rows.map(({ event }) => event.id)) };
    setArriving(new Set(newIds));
  }, [query.data, filter]);
  return (
    <div className={styles.page}>
      <Link to={`/p/${key}/team`}>{t('team.title')}</Link>
      <PageHeader title={t('involvement.title')} subtitle={t('involvement.subtitle')} />
      <div className={styles.filters}>
        <div className={styles.period}>
          <span>{t('involvement.period')}</span>
          <SegmentedControl
            label={t('involvement.period')}
            value={period}
            onChange={(value) => change('period', value)}
            options={[
              { value: 'today', label: t('involvement.today') },
              { value: '7', label: t('involvement.week') },
              { value: '30', label: t('involvement.month') },
              { value: 'all', label: t('involvement.anytime') },
            ]}
          />
        </div>
        {select('member', t('involvement.member'), [['', t('involvement.anyone')], ...members])}
        {select('by', t('involvement.by'), [
          ['', t('involvement.anyone')],
          ...(myHandle ? [[myHandle, t('common.you')] as [string, string]] : []),
          ['integrator', t('involvement.integrator')],
          ['system', t('common.system')],
          ...members.filter(([id]) => id !== myHandle),
        ])}
        {select('task', t('involvement.task'), [
          ['', t('involvement.anytime')],
          ...(board.data?.tasks ?? []).map((task): [string, string] => [
            task.key,
            `${task.key} · ${task.title}`,
          ]),
        ])}
        {select('kind', t('involvement.kind'), [
          ['', t('involvement.anytime')],
          ['started', t('involvement.starts')],
          ['stopped', t('involvement.stopsLabel')],
        ])}
      </div>
      {filtered ? (
        <Button variant="secondary" onClick={() => setParams({})}>
          {t('involvement.clear')}
        </Button>
      ) : null}
      {query.isPending ? (
        <div role="status" aria-label={t('app.loading')}>
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className={styles.skeleton} />
          ))}
        </div>
      ) : null}
      {query.isError ? (
        <ErrorState
          error={query.error}
          message={t('involvement.error')}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.data ? (
        <>
          <p>{t('involvement.counts', query.data.pages[0]!.counts)}</p>
          {items.length ? (
            <InvolvementRows items={items} arriving={arriving} />
          ) : (
            <EmptyState
              title={t(firstUse ? 'involvement.empty' : 'involvement.noResults')}
              body={t(firstUse ? 'involvement.emptyHint' : 'involvement.noResultsHint')}
            />
          )}
          {query.hasNextPage ? (
            <Button
              variant="secondary"
              loading={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
            >
              {t('involvement.more')}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
