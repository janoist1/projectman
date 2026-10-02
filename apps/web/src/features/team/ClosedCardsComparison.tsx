import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { DEFAULT_CLOSED_CARDS_DAYS, sortClosedCards } from '@projectman/shared';
import type { ClosedCardsSort } from '@projectman/shared';
import { useClosedCardsMeasure } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Fold } from '../../components/Fold';
import { SegmentedControl } from '../../components/SegmentedControl';
import { ErrorState, LoadingState } from '../../components/States';
import { WeightedTokensList } from '../../components/TokenUsage';
import { formatDate, formatTokens } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import styles from './ClosedCardsComparison.module.css';

const PERIODS = [7, DEFAULT_CLOSED_CARDS_DAYS, 30] as const;

/**
 * The cards closed lately side by side (PM-222): who carried them with which model, what they
 * cost in weighted tokens (per model too) and how many review rounds and send-backs they took.
 * It shows what a cheaper model brings: more rounds, or not. Not for clients, who see no usage.
 */
export function ClosedCardsComparison() {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const allowed = access !== undefined && access !== 'client';
  const [days, setDays] = useState<number>(DEFAULT_CLOSED_CARDS_DAYS);
  const [sort, setSort] = useState<ClosedCardsSort>('closedAt');
  const query = useClosedCardsMeasure(key, days, allowed);
  const { members } = useProjectIndexes(key);
  const cards = useMemo(() => sortClosedCards(query.data?.cards ?? [], sort), [query.data, sort]);
  if (!allowed) return null;

  const unmeasuredCards = cards.filter((card) => card.unmeasuredSessions > 0);
  const unmeasuredSessions = unmeasuredCards.reduce((sum, card) => sum + card.unmeasuredSessions, 0);

  return (
    <section className={styles.section} aria-labelledby="closed-cards">
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
        <ErrorState compact error={query.error} onRetry={() => void query.refetch()} />
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
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">{t('cardMeasure.columns.card')}</th>
                  <th scope="col">{t('cardMeasure.columns.implementer')}</th>
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
                    <td className={styles.number}>{card.rounds.sendBacks}</td>
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
