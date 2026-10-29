import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { api } from '../../api/endpoints';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { formatStamp } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import styles from './InvolvementsPage.module.css';

export function SuperActivity() {
  const { key, isOwner, me } = useProject();
  const [params] = useSearchParams();
  const prefix = params.get('prefix') ?? '';
  const allowed = isOwner && !me.via;
  useDocumentTitle(t('superMode.activity'));
  const query = useInfiniteQuery({
    queryKey: ['project', key, 'super-audit', prefix],
    enabled: allowed,
    initialPageParam: '',
    queryFn: ({ pageParam }) => api.superAudit(key, prefix, pageParam),
    getNextPageParam: (page) => page.nextBefore ?? undefined,
  });
  if (!allowed)
    return (
      <div className={styles.page}>
        <PageHeader title={t('superMode.activity')} />
        <EmptyState icon="lock" title={t('integratorKey.ownerOnly')} />
      </div>
    );
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
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
