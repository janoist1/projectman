import clsx from 'clsx';
import { useMemo } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { useBoard, useFeedbackList, useFeedbackSummary } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { SelectField } from '../../components/Field';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState } from '../../components/States';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { filtersFor, matchesFilter, matchesSource, parseFilter, sourceOptions } from './feedbackModel';
import type { FeedbackFilter } from './feedbackModel';
import { LaunchButton } from './LaunchButton';
import { MarkDetail } from './MarkDetail';
import { MarkList } from './MarkList';
import { ownerNameOf } from './MarkStatusChip';
import styles from './FeedbackPage.module.css';

function Skeleton() {
  return (
    <div className={styles.skeleton} aria-hidden="true">
      {[0, 1, 2, 3].map((row) => (
        <div key={row} className={styles.skeletonRow}>
          <span className={styles.skeletonAvatar} />
          <span className={styles.skeletonLines}>
            <span className={styles.skeletonLine} />
            <span className={clsx(styles.skeletonLine, styles.skeletonShort)} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * The marks people made on the product's pages (PM-506): the list on the left, the picked mark on
 * the right. Everyone in the project reads it, a client too; the processor works the marks here.
 * Routes: /feedback and /feedback/:markId; the filters stay in the address.
 */
export function FeedbackPage() {
  const { key, myHandle, can } = useProject();
  const { markId } = useParams();
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const isMobile = useIsMobile();
  const board = useBoard(key);
  const { members } = useProjectIndexes(key);
  const list = useFeedbackList(key);
  const summary = useFeedbackSummary(key);
  useDocumentTitle(t('feedback.title'), board.data?.project.name);

  const data = list.data;
  const canProcess = data?.canProcess ?? false;
  const filter = parseFilter(params.get('f'), canProcess);
  const source = params.get('source') ?? '';
  const marker = params.get('by') ?? '';
  const ownerName = ownerNameOf(members);

  const marks = useMemo(() => data?.marks ?? [], [data]);
  const sources = useMemo(() => sourceOptions(marks), [marks]);
  const markers = data?.markers ?? [];
  const scoped = useMemo(
    () =>
      marks.filter((mark) => matchesSource(mark, source) && (marker === '' || mark.author.handle === marker)),
    [marks, source, marker],
  );
  const visible = useMemo(
    () => scoped.filter((mark) => matchesFilter(mark, filter, myHandle)),
    [scoped, filter, myHandle],
  );
  const counts = (candidate: FeedbackFilter) =>
    scoped.filter((mark) => matchesFilter(mark, candidate, myHandle)).length;

  const setParam = (name: string, value: string, fallback = '') => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(name);
    else next.set(name, value);
    setParams(next, { replace: true });
  };
  const clearFilters = () => {
    const next = new URLSearchParams();
    next.set('f', 'all');
    setParams(next, { replace: true });
  };

  const inDetail = isMobile && markId !== undefined;
  const surfaces = data?.surfaces ?? [];

  const subtitle = data
    ? canProcess
      ? t('feedback.summary.processor', {
          fresh: marks.filter((mark) => mark.status === 'new').length,
          waiting: marks.filter((mark) => mark.status === 'waiting_owner').length,
        })
      : t('feedback.summary.member', {
          open: marks.filter((mark) => mark.status !== 'closed').length,
          replies: summary.data?.unreadReplies ?? 0,
        })
    : undefined;

  const header = (
    <PageHeader title={t('feedback.title')} subtitle={subtitle} hideTitleOnPhone className={styles.header}>
      {data?.canMark ? <LaunchButton surfaces={surfaces} /> : null}
    </PageHeader>
  );

  let body;
  if (list.isPending) {
    body = (
      <div className={styles.panel}>
        <Skeleton />
      </div>
    );
  } else if (list.isError) {
    body = (
      <div className={styles.errorBox}>
        <ErrorBanner>{t('feedback.loadFailed')}</ErrorBanner>
        <p className={styles.errorDetail}>{errorMessage(list.error)}</p>
        <Button variant="secondary" size="md" icon="undo" onClick={() => void list.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  } else if (surfaces.length === 0 && marks.length === 0) {
    body = (
      <div className={styles.panel}>
        <EmptyState
          icon="pin"
          titleAs="h2"
          title={can.manageTeam ? t('feedback.notConfigured.ownerTitle') : t('feedback.notConfigured.title')}
          body={can.manageTeam ? t('feedback.notConfigured.ownerBody') : t('feedback.notConfigured.body')}
          action={
            can.manageTeam ? (
              <ButtonLink to={`/p/${key}/settings/feedback`} variant="primary" size="md">
                {t('feedback.notConfigured.setUp')}
              </ButtonLink>
            ) : undefined
          }
        />
      </div>
    );
  } else if (marks.length === 0) {
    body = (
      <div className={styles.panel}>
        <EmptyState
          icon="pin"
          titleAs="h2"
          title={t('feedback.empty.title')}
          body={canProcess ? t('feedback.empty.processorBody') : t('feedback.empty.body')}
          action={data?.canMark ? <LaunchButton surfaces={surfaces} /> : undefined}
        />
      </div>
    );
  } else {
    const filterOptions = filtersFor(canProcess).map((value) => ({
      value,
      label: t(`feedback.filters.${value}`),
      count: counts(value),
    }));
    const filters = (
      <div className={styles.filters}>
        <SegmentedControl<FeedbackFilter>
          label={t('feedback.filters.label')}
          options={filterOptions}
          value={filter}
          onChange={(next) => setParam('f', next, filtersFor(canProcess)[0])}
          className={styles.segments}
        />
        {sources.length > 1 ? (
          <SelectField
            hideLabel
            label={t('feedback.filters.source')}
            fieldClassName={styles.select}
            value={source}
            onChange={(event) => setParam('source', event.target.value)}
          >
            <option value="">{t('feedback.filters.allSources')}</option>
            {sources.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SelectField>
        ) : null}
        {markers.length > 1 ? (
          <SelectField
            hideLabel
            label={t('feedback.filters.marker')}
            fieldClassName={styles.select}
            value={marker}
            onChange={(event) => setParam('by', event.target.value)}
          >
            <option value="">{t('feedback.filters.allMarkers')}</option>
            {markers.map((option) => (
              <option key={option.handle} value={option.handle}>
                {option.name}
              </option>
            ))}
          </SelectField>
        ) : null}
      </div>
    );
    const listPane =
      visible.length === 0 ? (
        <div className={styles.listEmpty}>
          <EmptyState icon="filter" title={t('feedback.filters.empty')} />
          <Button variant="secondary" size="md" onClick={clearFilters}>
            {t('feedback.filters.clear')}
          </Button>
        </div>
      ) : (
        <MarkList
          projectKey={key}
          marks={visible}
          selectedId={markId ?? null}
          search={search}
          canProcess={canProcess}
          members={members}
          ownerName={ownerName}
        />
      );
    body = (
      <>
        {inDetail ? null : filters}
        <div className={clsx(styles.split, inDetail && styles.splitDetail)}>
          {inDetail ? null : <div className={styles.listPane}>{listPane}</div>}
          {isMobile && !inDetail ? null : markId ? (
            <MarkDetail
              key={markId}
              markId={markId}
              search={search}
              surfaces={surfaces}
              canMark={data?.canMark ?? false}
              members={members}
              ownerName={ownerName}
              isMobile={isMobile}
            />
          ) : (
            <div className={styles.pick}>
              <EmptyState icon="pin" title={t('feedback.pick')} />
            </div>
          )}
        </div>
      </>
    );
  }

  return (
    <div className={clsx(styles.page, inDetail && styles.detailPage)}>
      {inDetail ? null : header}
      {body}
    </div>
  );
}
