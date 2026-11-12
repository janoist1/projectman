import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { DEFAULT_CLOSED_CARDS_DAYS, failedChecksByReviewer, sortClosedCards } from '@projectman/shared';
import type { ClosedCardsSort } from '@projectman/shared';
import { useClosedCardsMeasure } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Fold } from '../../components/Fold';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ErrorState, LoadingState } from '../../components/States';
import { WeightedTokensList } from '../../components/TokenUsage';
import { formatDate, formatTokens, numberFormat } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import styles from './ClosedCardsComparison.module.css';

const PERIODS = [7, DEFAULT_CLOSED_CARDS_DAYS, 30] as const;

/**
 * The cards closed lately side by side (PM-222): who carried them with which model, what they
 * cost in weighted tokens (per model too) and how many review rounds, send-backs and failed
 * merges (PM-1341) they took.
 * It shows what a cheaper model brings: more rounds, or not.
 */
export function ClosedCardsComparison() {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const allowed = access !== undefined;
  const [days, setDays] = useState<number>(DEFAULT_CLOSED_CARDS_DAYS);
  const [sort, setSort] = useState<ClosedCardsSort>('closedAt');
  const query = useClosedCardsMeasure(key, days, allowed);
  const sectionRef = useRef<HTMLElement>(null);
  const retryFocus = useRef(false);
  useEffect(() => {
    if (!query.isError && retryFocus.current) {
      retryFocus.current = false;
      sectionRef.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    }
  }, [query.isError]);
  const { members } = useProjectIndexes(key);
  const cards = useMemo(() => sortClosedCards(query.data?.cards ?? [], sort), [query.data, sort]);
  const reviewers = useMemo(() => failedChecksByReviewer(query.data?.cards ?? []), [query.data]);
  if (!allowed) return null;

  const unmeasuredCards = cards.filter((card) => card.unmeasuredSessions > 0);
  const unmeasuredSessions = unmeasuredCards.reduce((sum, card) => sum + card.unmeasuredSessions, 0);

  return (
    <section ref={sectionRef} className={styles.section} aria-labelledby="closed-cards">
      <div className={styles.head}>
        <h2 id="closed-cards">{t('cardMeasure.title')}</h2>
        <SegmentedControl<string>
          label={t('cardMeasure.periodLabel')}
          size="sm"
          value={String(days)}
          onChange={(value) => setDays(Number(value))}
          options={PERIODS.map((period) => ({
            value: String(period),
            label: t('cardMeasure.periodDays', { days: period }),
          }))}
        />
      </div>
      {query.isError ? (
        <ErrorState
          compact
          error={query.error}
          onRetry={() => {
            retryFocus.current = true;
            void query.refetch();
          }}
        />
      ) : !query.data ? (
        <LoadingState compact />
      ) : cards.length === 0 ? (
        <p className={styles.hint}>{t('cardMeasure.empty')}</p>
      ) : (
        <>
          {/* The explanation belongs to the table: it shows only where there is one. */}
          <p className={styles.hint}>{t('cardMeasure.hint')}</p>
          <Fold summary={t('cardMeasure.weightedHintSummary')}>
            <p className={styles.hint}>{t('cardMeasure.weightedHint')}</p>
          </Fold>
          {reviewers.length >= 2 ? (
            <p className={styles.reviewerSummary}>
              <strong>{t('cardMeasure.failedByReviewer')}</strong>{' '}
              {reviewers.map(({ reviewer, failed, total }) => (
                <span key={reviewer} className={styles.reviewerGroup}>
                  {t('cardMeasure.reviewerRatio', {
                    name: nameOf(reviewer, members, myHandle),
                    failed,
                    total,
                    percent: numberFormat({ style: 'percent', maximumFractionDigits: 0 }).format(
                      failed / total,
                    ),
                  })}
                </span>
              ))}
            </p>
          ) : null}
          <div className={styles.tableWrap} tabIndex={0} role="region" aria-label={t('cardMeasure.title')}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('cardMeasure.columns.card')}</th>
                  <th scope="col">{t('cardMeasure.columns.implementer')}</th>
                  <th scope="col">{t('cardMeasure.columns.reviewer')}</th>
                  <SortHeader
                    sort="tokens"
                    label={t('cardMeasure.columns.tokens')}
                    active={sort}
                    onSort={setSort}
                  />
                  <SortHeader
                    sort="reviewRounds"
                    label={t('cardMeasure.columns.reviewRounds')}
                    active={sort}
                    onSort={setSort}
                  />
                  <th scope="col">{t('cardMeasure.columns.sendBacks')}</th>
                  <th scope="col">{t('cardMeasure.columns.mergeConflicts')}</th>
                  <th scope="col">{t('cardMeasure.columns.mergeChecksFailed')}</th>
                  <SortHeader
                    sort="closedAt"
                    label={t('cardMeasure.columns.closedAt')}
                    active={sort}
                    onSort={setSort}
                  />
                </tr>
              </thead>
              <tbody>
                {cards.map((card) => (
                  <tr key={card.taskKey}>
                    <td>
                      <Link to={`/p/${key}/tasks/${card.taskKey}`} className={styles.cardLink}>
                        <span className={styles.mono}>{card.taskKey}</span> {card.title}
                      </Link>
                    </td>
                    <td>
                      <span className={styles.implementer}>
                        {card.implementer
                          ? nameOf(card.implementer, members, myHandle)
                          : t('cardMeasure.noImplementer')}
                      </span>
                      {card.implementerModels.length > 0 ? (
                        <span className={styles.models}>{card.implementerModels.join(', ')}</span>
                      ) : null}
                    </td>
                    <td>
                      {card.reviewer ? (
                        nameOf(card.reviewer, members, myHandle)
                      ) : (
                        <span aria-label={t('cardMeasure.reviewerUnknown')}>–</span>
                      )}
                    </td>
                    <td>
                      <span className={styles.tokens}>{formatTokens(card.tokens)}</span>
                      <WeightedTokensList models={card.byModel} />
                      {card.unmeasuredSessions > 0 ? (
                        <span className={styles.models}>
                          {t('cardMeasure.sessionsWithoutData', { count: card.unmeasuredSessions })}
                        </span>
                      ) : null}
                    </td>
                    <td className={styles.number}>
                      {card.rounds.reviewRounds}
                      {card.rounds.changeRequests > 0 ? (
                        <span className={styles.models}>
                          {t('cardMeasure.changeRequestsOf', { count: card.rounds.changeRequests })}
                        </span>
                      ) : null}
                    </td>
                    <td className={styles.number}>
                      {card.rounds.sendBacks}
                      {card.rounds.testsFailed > 0 ? (
                        <span className={styles.models}>
                          {t('cardMeasure.reviewTestsFailedOf', { count: card.rounds.testsFailed })}
                        </span>
                      ) : null}
                    </td>
                    <td className={styles.number}>{card.rounds.mergeConflicts}</td>
                    <td className={styles.number}>{card.rounds.mergeChecksFailed}</td>
                    <td>{formatDate(card.closedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {unmeasuredSessions > 0 ? (
        <p className={styles.hint}>
          {t('cardMeasure.unmeasured', { cards: unmeasuredCards.length, sessions: unmeasuredSessions })}
        </p>
      ) : null}
    </section>
  );
}

function SortHeader({
  sort,
  label,
  active,
  onSort,
}: {
  sort: ClosedCardsSort;
  label: string;
  active: ClosedCardsSort;
  onSort: (sort: ClosedCardsSort) => void;
}) {
  return (
    <th scope="col" aria-sort={active === sort ? 'descending' : 'none'}>
      <button
        type="button"
        className={styles.sortButton}
        data-active={active === sort}
        aria-label={t('cardMeasure.sortBy', { column: label })}
        onClick={() => onSort(sort)}
      >
        {label}
        {active === sort ? ' ↓' : ''}
      </button>
    </th>
  );
}
