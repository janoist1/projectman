import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import { useBoard } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState } from '../../components/States';
import { formatDayHeading, formatStamp } from '../../i18n/format';
import { t } from '../../i18n/t';
import { describeStart, describeStop, involvementText } from '../../lib/involvement';
import { useDocumentTitle } from '../../lib/hooks';
import type { InvolvementItem } from '@projectman/shared';
import styles from './InvolvementsPage.module.css';

export function InvolvementRows({ items }: { items: readonly InvolvementItem[] }) {
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
        const day = formatDayHeading(event.createdAt);
        const heading = previousDay !== day;
        previousDay = day;
        return (
          <li key={event.id}>
            {heading ? <h3>{day}</h3> : null}
            <div className={styles.row}>
              <Avatar member={member} handle={handle} size="md" />
              <div className={styles.body}>
                <div className={styles.line}>
                  <Link to={`/p/${key}/team/${handle}`}>{member?.displayName ?? handle}</Link>
                  <Chip
                    tone={
                      event.type === 'session_started' ? 'accent' : event.data.exitCode ? 'blocked' : 'needs'
                    }
                  >
                    {description.verb}
                  </Chip>
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
                <p>
                  {event.data.cause || event.data.stop
                    ? involvementText({ ...description, verb: '' }).replace(/^ — /, '')
                    : t('involvement.unknown')}
                </p>
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
  return (
    <section>
      <h2>{t('involvement.recent')}</h2>
      {query.data ? <InvolvementRows items={query.data.items} /> : null}
      <Link to={`/p/${key}/sessions`}>{t('involvement.all')}</Link>
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
  const filtered = params.size > 0;
  return (
    <div className={styles.page}>
      <Link to={`/p/${key}/team`}>{t('nav.team')}</Link>
      <PageHeader title={t('involvement.title')} />
      <p>{t('involvement.subtitle')}</p>
      <div className={styles.filters}>
        {select(
          'period',
          t('involvement.period'),
          [
            ['today', t('involvement.today')],
            ['7', t('involvement.week')],
            ['30', t('involvement.month')],
            ['all', t('involvement.anytime')],
          ],
          period,
        )}
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
            <InvolvementRows items={items} />
          ) : (
            <EmptyState
              title={t(filtered ? 'involvement.noResults' : 'involvement.empty')}
              body={t(filtered ? 'involvement.noResultsHint' : 'involvement.emptyHint')}
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
