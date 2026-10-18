import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { SuperStateChip } from '../../components/SuperStateChip';
import { formatStamp } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import type { SuperState } from '@projectman/shared';
import { useDocumentTitle } from '../../lib/hooks';
import styles from './InvolvementsPage.module.css';

export function SuperActivity() {
  const { key, isOwner, me } = useProject();
  const [params] = useSearchParams();
  const prefix = params.get('prefix') ?? '';
  const { hash } = useLocation();
  const requestedHandoff = hash.startsWith('#handoff-') ? hash.slice('#handoff-'.length) : '';
  const allowed = isOwner && !me.via;
  useDocumentTitle(t('superMode.activity'));
  const query = useInfiniteQuery({
    queryKey: ['project', key, 'super-audit', prefix],
    enabled: allowed,
    initialPageParam: '',
    queryFn: ({ pageParam }) => api.superAudit(key, prefix, pageParam),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  const handoffs = useQuery({
    queryKey: ['project', key, 'super-handoffs'],
    queryFn: () => api.superHandoffs(key),
    enabled: allowed,
  });
  const selected = useQuery({
    queryKey: ['project', key, 'super-handoffs', 'detail', requestedHandoff],
    queryFn: () => api.superHandoff(key, requestedHandoff),
    enabled: allowed && !!requestedHandoff,
  });
  useEffect(() => {
    if (!hash.startsWith('#handoff-')) return;
    const target = document.getElementById(hash.slice(1));
    target?.scrollIntoView({ block: 'center' });
    target?.focus({ preventScroll: true });
  }, [hash, handoffs.data, selected.data]);
  if (!allowed)
    return (
      <div className={styles.page}>
        <PageHeader title={t('superMode.activity')} />
        <EmptyState icon="lock" title={t('integratorKey.ownerOnly')} />
      </div>
    );
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const rows = handoffs.data?.handoffs ?? [];
  const shownHandoffs =
    selected.data && !rows.some((row) => row.id === selected.data.handoff.id)
      ? [selected.data.handoff, ...rows]
      : rows;
  return (
    <div className={styles.page}>
      <ButtonLink to={`/p/${key}/sessions`} variant="ghost" icon="chevronLeft">
        {t('involvement.title')}
      </ButtonLink>
      <PageHeader
        title={t('superMode.activity')}
        subtitle={prefix ? `${t('integratorKey.prefix')}: ${prefix}…` : undefined}
      />
      {prefix ? (
        <Link className={styles.clearFilter} to={`/p/${key}/sessions?by=super`}>
          {t('involvement.clear')}
        </Link>
      ) : null}
      {!prefix && handoffs.isError ? (
        <ErrorState error={handoffs.error} onRetry={() => void handoffs.refetch()} />
      ) : null}
      {selected.isFetching ? <LoadingState /> : null}
      {selected.isError ? (
        <ErrorState error={selected.error} onRetry={() => void selected.refetch()} />
      ) : null}
      {!prefix && shownHandoffs.length ? (
        <section className={styles.section} aria-labelledby="super-handoffs-title">
          <h2 id="super-handoffs-title">{t('superMode.handoffsTitle')}</h2>
          <ol className={styles.list}>
            {shownHandoffs.map((handoff) => (
              <li key={handoff.id} id={`handoff-${handoff.id}`} tabIndex={-1} className={styles.row}>
                <div className={styles.body}>
                  <time dateTime={handoff.createdAt}>{formatStamp(handoff.createdAt)}</time>
                  <p>
                    {t('superMode.handedOff', {
                      operation: t(`superMode.commands.${handoff.command.kind}`),
                      reason: handoff.reason,
                    })}
                  </p>
                  {handoff.operationId ? (
                    <OperationStatus id={handoff.operationId} fallback={handoff.state} />
                  ) : (
                    <SuperStateChip state={handoff.state} projectKey={key} />
                  )}
                  {handoff.taskKey ? (
                    <Link to={`/p/${key}/tasks/${handoff.taskKey}/timeline`}>{handoff.taskKey}</Link>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {query.isPending ? <LoadingState /> : null}
      {query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} /> : null}
      <section className={styles.section} aria-labelledby="super-operations-title">
        <h2 id="super-operations-title">{t('superMode.operationsTitle')}</h2>
        {query.data && !entries.length ? <p>{t(prefix ? 'superMode.empty' : 'superMode.emptyAll')}</p> : null}
        <ol className={styles.list}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.row}>
              <div className={styles.body}>
                <time dateTime={entry.createdAt}>{formatStamp(entry.createdAt)}</time>
                <p>
                  {tDynamic(
                    `superMode.operations.${entry.operation}`,
                    tDynamic(`superMode.commands.${entry.operation}`, entry.operation),
                  )}{' '}
                  · {entry.projectKey} · <code>{entry.prefix}…</code>
                </p>
                <Chip
                  tone={
                    entry.outcome === 'succeeded'
                      ? 'ok'
                      : entry.outcome === 'failed' || entry.outcome === 'refused'
                        ? 'blocked'
                        : 'needs'
                  }
                  title={entry.outcome === 'unknown' ? t('superMode.unknownHint') : undefined}
                >
                  {t(`superMode.outcomes.${entry.outcome}`)}
                </Chip>
                {entry.handoffId ? (
                  <Link to={`/p/${key}/sessions?by=super#handoff-${entry.handoffId}`}>
                    {t('superMode.handoff')}
                  </Link>
                ) : null}
                {entry.taskKey ? (
                  <Link to={`/p/${key}/tasks/${entry.taskKey}/timeline`}>{entry.taskKey}</Link>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
        {query.hasNextPage ? (
          <Button
            variant="secondary"
            loading={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {t('superMode.more')}
          </Button>
        ) : null}
      </section>
    </div>
  );
}

function OperationStatus({ id, fallback }: { id: string; fallback: SuperState }) {
  const { key } = useProject();
  const query = useQuery({
    queryKey: ['project', key, 'super-operation', id],
    queryFn: () => api.superOperation(key, id),
  });
  return query.data ? (
    <SuperStateChip
      state={query.data.operation.state}
      projectKey={key}
      questionId={query.data.operation.ownerQuestionId}
    />
  ) : (
    <SuperStateChip state={fallback} projectKey={key} />
  );
}
