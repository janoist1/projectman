import { CheckName, CheckState } from '@projectman/shared';
import type { Session, Task } from '@projectman/shared';
import { Avatar } from '../../components/Avatar';
import { Chip } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { t } from '../../i18n/t';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { githubUrl, pullRequestLink } from '../board/cardModel';
import type { Participant } from './participants';
import styles from './SessionPanels.module.css';

const prStates = ['open', 'merged', 'closed', 'draft'] as const;

function prStateLabel(state: string | undefined): string | null {
  if (!state) return null;
  return (prStates as readonly string[]).includes(state)
    ? t(`links.prStates.${state as (typeof prStates)[number]}`)
    : state;
}

/** Pull request of the task, with the recorded checks. */
export function PrPanel({ task, session }: { task: Task | null; session: Session }) {
  const link = task ? pullRequestLink(task) : undefined;
  const checks = task
    ? CheckName.options.flatMap((name) => {
        const state = task.checks[name];
        return state ? [{ name, state }] : [];
      })
    : [];
  return (
    <section className={styles.panel} aria-labelledby="session-pr">
      {link ? (
        <>
          <div className={styles.prHead}>
            <span
              className={styles.prIcon}
              data-merged={link.state === 'merged' || undefined}
              aria-hidden="true"
            >
              <Icon name={link.state === 'merged' ? 'prMerged' : 'prOpen'} size={18} strokeWidth={2} />
            </span>
            <h2 id="session-pr" className={styles.prTitle}>
              {t('session.pr.heading', { number: link.ref })}
            </h2>
            {link.state ? (
              <Chip tone={link.state === 'merged' ? 'accent' : link.state === 'closed' ? 'neutral' : 'ok'}>
                {prStateLabel(link.state)}
              </Chip>
            ) : null}
            <span className={styles.spacer} />
            {githubUrl(link) ? (
              <a
                href={githubUrl(link) ?? undefined}
                target="_blank"
                rel="noreferrer noopener"
                className={styles.external}
                aria-label={t('session.pr.openOnGithub')}
                title={t('session.pr.openOnGithub')}
              >
                <Icon name="external" size={16} strokeWidth={2} />
              </a>
            ) : null}
          </div>
          {link.title ? <p className={styles.prName}>{link.title}</p> : null}
          <span className={styles.mono}>{[link.repo, session.branch].filter(Boolean).join(' · ')}</span>
        </>
      ) : (
        <>
          <h2 id="session-pr" className={styles.sectionTitle}>
            {t('session.pr.title')}
          </h2>
          <p className={styles.muted}>{t('session.pr.none')}</p>
        </>
      )}
      {checks.length > 0 ? (
        <dl className={styles.checks}>
          {checks.map(({ name, state }) => (
            <div key={name} className={styles.checkRow}>
              <dt>{t(`checks.names.${name}`)}</dt>
              <dd data-state={state}>
                {CheckState.safeParse(state).success ? t(`checks.states.${state}`) : state}
              </dd>
            </div>
          ))}
        </dl>
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
