import { mergeTokenUsage, tokenTotal, usageTotal } from '@projectman/shared';
import type { ModelTokens, TokenUsage } from '@projectman/shared';
import { formatTokens } from '../i18n/format';
import { t } from '../i18n/t';
import styles from './TokenUsage.module.css';

/**
 * Token usage (PM-178): the total, then one line per model, the subagents' on their own lines,
 * each with its four kinds. `rows` null means nothing was measured: "Nincs adat" (or `noData`).
 */
export function TokenUsageList({ rows, noData }: { rows: readonly TokenUsage[] | null; noData?: string }) {
  if (rows === null) return <p className={styles.muted}>{noData ?? t('tokenUsage.noData')}</p>;
  const merged = mergeTokenUsage(rows);
  if (merged.length === 0) return <p className={styles.muted}>{t('tokenUsage.none')}</p>;
  return (
    <div className={styles.usage}>
      <p className={styles.total}>
        {t('tokenUsage.total', { total: formatTokens(tokenTotal(usageTotal(merged))) })}
      </p>
      <ul className={styles.rows}>
        {merged.map((row) => (
          <li key={`${row.scope}:${row.model}`} className={styles.row} data-scope={row.scope}>
            <span className={styles.head}>
              <span className={styles.model}>{row.model}</span>
              <span className={styles.scope}>{t(`tokenUsage.${row.scope}`)}</span>
              <span className={styles.rowTotal}>{formatTokens(tokenTotal(row))}</span>
            </span>
            <span className={styles.kinds}>
              {[
                t('tokenUsage.input', { count: formatTokens(row.input) }),
                t('tokenUsage.output', { count: formatTokens(row.output) }),
                t('tokenUsage.cacheRead', { count: formatTokens(row.cacheRead) }),
                t('tokenUsage.cacheWrite', { count: formatTokens(row.cacheWrite) }),
              ].join(' · ')}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The weighted tokens (`limitTokens`, PM-222) one line per model, subagents' included: the unit the
 * cards are compared in. With `showTotal` the sum comes first.
 */
export function WeightedTokensList({
  models,
  showTotal = false,
}: {
  models: readonly ModelTokens[];
  showTotal?: boolean;
}) {
  if (models.length === 0) return <p className={styles.muted}>{t('tokenUsage.none')}</p>;
  return (
    <div className={styles.usage}>
      {showTotal ? (
        <p className={styles.total}>
          {t('tokenUsage.weightedTotal', {
            total: formatTokens(models.reduce((sum, entry) => sum + entry.tokens, 0)),
          })}
        </p>
      ) : null}
      <ul className={styles.rows}>
        {models.map((entry) => (
          <li key={entry.model} className={styles.head}>
            <span className={styles.model}>{entry.model}</span>
            <span className={styles.rowTotal}>{formatTokens(entry.tokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
