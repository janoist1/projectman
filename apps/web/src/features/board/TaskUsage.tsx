import { tokenTotal, usageTotal, weightedTokensByModel } from '@projectman/shared';
import type { CardRounds, Session } from '@projectman/shared';
import { TokenUsageList, WeightedTokensList } from '../../components/TokenUsage';
import { formatTokens } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import drawer from './drawer.module.css';
import styles from './TaskUsage.module.css';

/**
 * What the card took (PM-222): its review rounds, the reviews that asked for changes and the
 * send-backs, then the weighted tokens per model (as the session warning limit counts them), the
 * unit the closed cards are compared in. Without the server's counts (a client) nothing shows.
 */
export function TaskRounds({
  rounds,
  fixRounds,
  sessions,
}: {
  rounds: CardRounds | undefined;
  /** The fix rounds since the count began against the limit (PM-262); absent without the server's counts. */
  fixRounds?: { rounds: number; limit: number };
  sessions: readonly Session[];
}) {
  if (!rounds) return null;
  const models = weightedTokensByModel(sessions.flatMap((session) => session.usage?.rows ?? []));
  const counts: Array<[string, number | string]> = [
    [t('tokenUsage.reviewRounds'), rounds.reviewRounds],
    [t('tokenUsage.changeRequests'), rounds.changeRequests],
    [t('tokenUsage.designChangeRequests'), rounds.designChangeRequests],
    [t('tokenUsage.sendBacks'), rounds.sendBacks],
  ];
  return (
    <section className={drawer.section} aria-labelledby="task-rounds">
      <h3 id="task-rounds" className={drawer.sectionTitle}>
        {t('tokenUsage.roundsTitle')}
      </h3>
      <dl className={styles.rounds}>
        {fixRounds ? (
          <div
            className={`${styles.round} ${styles.fixRound} ${fixRounds.rounds >= fixRounds.limit ? styles.atLimit : ''}`}
          >
            <dt>{t('tokenUsage.fixRounds')}</dt>
            <dd className={styles.count}>{t('tokenUsage.fixRoundsValue', fixRounds)}</dd>
          </div>
        ) : null}
        {counts.map(([label, count]) => (
          <div key={label} className={styles.round}>
            <dt>{label}</dt>
            <dd className={styles.count}>{count}</dd>
          </div>
        ))}
      </dl>
      {models.length > 0 ? (
        <div className={styles.members}>
          <span className={styles.label} title={t('tokenUsage.countedHelp')}>
            {t('tokenUsage.weighted')}
          </span>
          <WeightedTokensList models={models} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * The tokens the card's sessions used together (PM-178): per model, the subagents' on their own
 * lines, then per member. Sessions from before the measurement are left out and counted in a note.
 */
export function TaskUsage({
  sessions,
  members,
  myHandle,
}: {
  sessions: readonly Session[];
  members: MemberIndex;
  myHandle: string | null;
}) {
  if (sessions.length === 0) return null;
  const measured = sessions.filter((session) => session.usage);
  const unmeasured = sessions.length - measured.length;
  const perMember = new Map<string, number>();
  for (const session of measured) {
    const total = tokenTotal(usageTotal(session.usage!.rows));
    perMember.set(session.member, (perMember.get(session.member) ?? 0) + total);
  }
  const codex = measured.some(
    (session) => (session.provider ?? members.get(session.member)?.provider) === 'codex',
  );
  return (
    <section className={drawer.section} aria-labelledby="task-usage">
      <h3 id="task-usage" className={drawer.sectionTitle}>
        {t('tokenUsage.title')}
      </h3>
      <TokenUsageList
        rows={measured.length > 0 ? measured.flatMap((session) => session.usage!.rows) : null}
      />
      {perMember.size > 1 ? (
        <div className={styles.members}>
          <span className={styles.label}>{t('tokenUsage.byMember')}</span>
          <ul className={styles.list}>
            {[...perMember]
              .sort(([, a], [, b]) => b - a)
              .map(([handle, total]) => (
                <li key={handle} className={styles.member}>
                  <span>{nameOf(handle, members, myHandle)}</span>
                  <span className={styles.count}>{formatTokens(total)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {unmeasured > 0 && measured.length > 0 ? (
        <p className={styles.note}>{t('tokenUsage.sessionsWithoutData', { count: unmeasured })}</p>
      ) : null}
      {codex ? <p className={styles.note}>{t('tokenUsage.codexSubagents')}</p> : null}
    </section>
  );
}
