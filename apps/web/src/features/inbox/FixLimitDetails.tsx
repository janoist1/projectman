import { useState } from 'react';
import { remainingFixExtraRounds } from '@projectman/shared';
import type { FixLimitDecisionPayload, FixRoundHistoryEntry } from '@projectman/shared';
import { Fold } from '../../components/Fold';
import { Chip } from '../../components/Chip';
import { Button } from '../../components/Button';
import { intlLocale } from '../../i18n/format';
import { t } from '../../i18n/t';
import { actorLabel, nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import styles from './FixLimitDetails.module.css';

export function fixHistoryText(entry: FixRoundHistoryEntry, members: MemberIndex, myHandle: string | null) {
  const name = actorLabel(entry.actor, members, myHandle);
  switch (entry.kind) {
    case 'branch_moved':
      return t('inbox.fixLimit.rounds.kind.technical', {
        old: entry.pinned?.slice(0, 7) ?? '—',
        new: entry.head?.slice(0, 7) ?? '—',
      });
    case 'extra_round':
      return t(
        (entry.extraRound ?? 0) > 3
          ? 'inbox.fixLimit.rounds.kind.grantOver'
          : 'inbox.fixLimit.rounds.kind.grant',
        { i: entry.extraRound ?? '—', name },
      );
    case 'tests_failed':
      return entry.command || entry.failedFiles?.length
        ? t('inbox.fixLimit.rounds.kind.tests_failed', {
            command: entry.command ?? entry.failedFiles!.join(', '),
          })
        : t('inbox.fixLimit.rounds.kind.tests_failed_commit', { commit: entry.commit?.slice(0, 7) ?? '—' });
    case 'send_back':
      return t(
        entry.note ? 'inbox.fixLimit.rounds.kind.send_back' : 'inbox.fixLimit.rounds.kind.send_back_no_note',
        { name },
      );
    default:
      return t(`inbox.fixLimit.rounds.kind.${entry.kind}`, { name });
  }
}

export function FixLimitDetails({
  limit,
  members,
  myHandle,
}: {
  limit: FixLimitDecisionPayload;
  members: MemberIndex;
  myHandle: string | null;
}) {
  const [open, setOpen] = useState(!limit.assessment);
  const [earlier, setEarlier] = useState(false);
  const history = limit.history;
  const technical = history?.filter((entry) => entry.kind === 'branch_moved').length ?? 0;
  if (!history && limit.extraRounds === undefined && !limit.assessment) return null;
  return (
    <div className={styles.details}>
      {limit.extraRounds !== undefined ? (
        <div className={styles.extras}>
          <span className={styles.dots} aria-hidden="true">
            {[1, 2, 3].map((i) => (
              <i key={i} data-used={i <= limit.extraRounds!} />
            ))}
          </span>
          <span>
            {t(
              limit.extraRounds > 3
                ? 'inbox.fixLimit.extrasOver'
                : limit.extraRounds === 3
                  ? 'inbox.fixLimit.extrasNone'
                  : 'inbox.fixLimit.extras',
              { used: limit.extraRounds, left: remainingFixExtraRounds(limit.extraRounds) },
            )}
          </span>
        </div>
      ) : null}
      {limit.assessment ? (
        <section className={styles.verdict}>
          <h4>{t('inbox.fixLimit.verdict.title', { name: nameOf(limit.decider, members, myHandle) })}</h4>
          <dl>
            <dt>{t('inbox.fixLimit.verdict.repeat')}</dt>
            <dd>{limit.assessment.recurrence}</dd>
            <dt>{t('inbox.fixLimit.verdict.now')}</dt>
            <dd>{limit.assessment.currentState}</dd>
          </dl>
        </section>
      ) : null}
      {history ? (
        <Fold
          open={open}
          onToggle={setOpen}
          summary={
            <span>
              {t('inbox.fixLimit.rounds.summary', { count: limit.rounds })}
              {technical ? (
                <small> · {t('inbox.fixLimit.rounds.technicalCount', { count: technical })}</small>
              ) : null}
            </span>
          }
        >
          {history.length > 12 && !earlier ? (
            <Button variant="ghost" size="sm" onClick={() => setEarlier(true)}>
              {t('inbox.fixLimit.rounds.earlier', { count: history.length - 12 })}
            </Button>
          ) : null}
          <ol className={styles.rounds} aria-label={t('inbox.fixLimit.rounds.label')}>
            {(earlier ? history : history.slice(-12)).map((entry, index) => (
              <li key={`${entry.eventId}-${entry.kind}-${index}`} data-kind={entry.kind}>
                <strong>
                  {entry.kind === 'extra_round' ? `+${entry.extraRound ?? '—'}` : (entry.round ?? '–')}
                </strong>
                <time dateTime={entry.at}>
                  {new Date(entry.at).toLocaleString(intlLocale(), {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </time>
                <div>
                  <b>{fixHistoryText(entry, members, myHandle)}</b>
                  {entry.note ? <q>{entry.note.split('\n')[0]}</q> : null}
                  {entry.kind === 'branch_moved' ? (
                    <Chip tone="outline">{t('inbox.fixLimit.rounds.notCounted')}</Chip>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        </Fold>
      ) : null}
    </div>
  );
}
