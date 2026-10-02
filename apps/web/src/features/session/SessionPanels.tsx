import { LabelChip } from '../../components/LabelChip';
import { limitTokens, usageTotal } from '@projectman/shared';
import type { LabelView, MemberView, Session, Task, TaskPullRequest } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { TokenUsageList } from '../../components/TokenUsage';
import { formatStamp, formatTokens } from '../../i18n/format';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import type { Participant } from './participants';
import { SessionPermissions } from './SessionPermissions';
import styles from './SessionPanels.module.css';

const prStates = ['open', 'merged', 'closed', 'draft'] as const;

function prStateLabel(state: string | undefined): string | null {
  if (!state) return null;
  return (prStates as readonly string[]).includes(state)
    ? t(`links.prStates.${state as (typeof prStates)[number]}`)
    : state;
}

/**
 * Where and how the session runs: its branch and working directory, the agent CLI it runs (the
 * member's for sessions from before it was recorded), the model, and the permission settings that
 * apply to it (an owner changes them here, PM-170).
 */
export function SessionDetailsPanel({
  session,
  member,
}: {
  session: Session;
  member: MemberView | undefined;
}) {
  const provider = session.provider ?? member?.provider ?? 'claude';
  const rows: Array<{ label: string; value: string; mono?: boolean }> = [
    ...(session.branch ? [{ label: t('session.details.branch'), value: session.branch, mono: true }] : []),
    { label: t('session.details.cwd'), value: session.cwd, mono: true },
    { label: t('session.details.provider'), value: t(`providers.${provider}`) },
    ...(member?.model ? [{ label: t('session.details.model'), value: member.model }] : []),
  ];
  return (
    <section className={styles.panel} aria-labelledby="session-details">
      <h2 id="session-details" className={styles.sectionTitle}>
        {t('session.details.title')}
      </h2>
      <dl className={styles.checks}>
        {rows.map(({ label, value, mono }) => (
          <div key={label} className={styles.checkRow}>
            <dt>{label}</dt>
            <dd className={mono ? styles.monoValue : undefined}>{value}</dd>
          </div>
        ))}
      </dl>
      <div className={styles.settings}>
        <SessionPermissions session={session} member={member} />
      </div>
    </section>
  );
}

/** All linked pull requests, including the latest GitHub checks and review decision. */
export function PrPanel({
  task,
  session,
  pullRequests = [],
  labels = [],
}: {
  task: Task | null;
  session: Session;
  pullRequests?: readonly TaskPullRequest[];
  /** The project's label definitions, for label names and colours. */
  labels?: readonly LabelView[];
}) {
  return (
    <section className={styles.panel} aria-labelledby="session-pr">
      <h2 id="session-pr" className={styles.sectionTitle}>
        {t('session.pr.title')}
      </h2>
      {pullRequests.length === 0 ? (
        <p className={styles.muted}>{t('session.pr.none')}</p>
      ) : (
        pullRequests.map((pr) => (
          <article key={`${pr.repo}#${pr.number}`}>
            <div className={styles.prHead}>
              <span
                className={styles.prIcon}
                data-merged={pr.state === 'merged' || undefined}
                aria-hidden="true"
              >
                <Icon name={pr.state === 'merged' ? 'prMerged' : 'prOpen'} size={18} strokeWidth={2} />
              </span>
              <h3 className={styles.prTitle}>{t('session.pr.heading', { number: pr.number })}</h3>
              <Chip tone={pr.state === 'merged' ? 'accent' : pr.state === 'closed' ? 'neutral' : 'ok'}>
                {prStateLabel(pr.state ?? undefined) ?? t('session.pr.unknown')}
              </Chip>
              <span className={styles.spacer} />
              {pr.url ? (
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={styles.external}
                  aria-label={t('session.pr.openOnGithub')}
                >
                  <Icon name="external" size={16} strokeWidth={2} />
                </a>
              ) : null}
            </div>
            <p className={styles.prName}>{pr.title ?? t('session.pr.unknown')}</p>
            <span className={styles.mono}>{[pr.repo, session.branch].filter(Boolean).join(' · ')}</span>
            <dl className={styles.checks}>
              <div className={styles.checkRow}>
                <dt>{t('session.pr.checks')}</dt>
                <dd>{pr.checks ? t(`session.pr.checkStates.${pr.checks}`) : t('session.pr.unknown')}</dd>
              </div>
              <div className={styles.checkRow}>
                <dt>{t('session.pr.reviewDecision')}</dt>
                <dd>
                  {pr.reviewDecision
                    ? t(`session.pr.reviewStates.${pr.reviewDecision}`)
                    : t('session.pr.unknown')}
                </dd>
              </div>
              <div className={styles.checkRow}>
                <dt>{t('session.pr.changes')}</dt>
                <dd>
                  +{pr.additions ?? t('session.pr.unknown')} / −{pr.deletions ?? t('session.pr.unknown')}
                </dd>
              </div>
            </dl>
          </article>
        ))
      )}
      {task && task.labels.length > 0 ? (
        <ul className={styles.labels} aria-label={t('task.labels.title')}>
          {task.labels.map((id) => (
            <li key={id}>
              <LabelChip id={id} labels={labels} />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** A measurement that started this long after the session did is only partial (a resumed old session). */
const PARTIAL_AFTER_MS = 60_000;

/**
 * The tokens the session used (PM-178), per model, its subagents' on their own lines. A session
 * from before the measurement has no data; one resumed after it says since when it is counted.
 * Codex's subagents are not measured. Below the rows: the number the warning limit is measured in
 * (`limitTokens`, PM-187), and when the session reached it.
 */
export function UsagePanel({ session, provider }: { session: Session; provider: string | undefined }) {
  const usage = session.usage;
  const partial = usage && Date.parse(usage.since) - Date.parse(session.startedAt) > PARTIAL_AFTER_MS;
  return (
    <section className={styles.panel} aria-labelledby="session-usage">
      <h2 id="session-usage" className={styles.sectionTitle}>
        {t('tokenUsage.title')}
      </h2>
      <TokenUsageList rows={usage?.rows ?? null} noData={t('tokenUsage.noDataSession')} />
      {usage && usage.rows.length > 0 ? (
        <p className={styles.muted} title={t('tokenUsage.countedHelp')}>
          {t('tokenUsage.counted', { count: formatTokens(limitTokens(usageTotal(usage.rows))) })}
        </p>
      ) : null}
      {session.usageAlert ? (
        <p role="note">
          {t('tokenUsage.alert', {
            time: formatStamp(session.usageAlert.at),
            counted: formatTokens(session.usageAlert.countedTokens),
            limit: formatTokens(session.usageAlert.limitTokens),
          })}
        </p>
      ) : null}
      {partial ? (
        <p className={styles.muted}>{t('tokenUsage.since', { time: formatStamp(usage.since) })}</p>
      ) : null}
      {usage && provider === 'codex' ? (
        <p className={styles.muted}>{t('tokenUsage.codexSubagents')}</p>
      ) : null}
    </section>
  );
}

export function ParticipantsPanel({
  participants,
  members,
  myHandle,
}: {
  participants: Participant[];
  members: MemberIndex;
  myHandle: string | null;
}) {
  return (
    <section className={styles.panel} aria-labelledby="session-participants">
      <h2 id="session-participants" className={styles.sectionTitle}>
        {t('session.participants')}
      </h2>
      <ul className={styles.people}>
        {participants.map(({ handle, what }) => (
          <li key={handle} className={styles.person}>
            <Avatar member={members.get(handle)} handle={handle} isMe={handle === myHandle} size="md" />
            <span className={styles.personText}>
              <span className={styles.personName}>{nameOf(handle, members, myHandle)}</span>
              <span className={styles.personWhat}>{what}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
