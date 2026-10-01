import { tokenTotal, usageTotal } from '@projectman/shared';
import type { Session } from '@projectman/shared';
import { TokenUsageList } from '../../components/TokenUsage';
import { formatTokens } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import drawer from './drawer.module.css';
import styles from './TaskUsage.module.css';

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
