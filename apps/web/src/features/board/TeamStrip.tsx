import { Link } from 'react-router';
import type { InboxItem, MemberView } from '@projectman/shared';
import { useProject } from '../../app/contexts';
import { Avatar, AvatarStack } from '../../components/Avatar';
import { t } from '../../i18n/t';
import { isStandingRole, memberStatusView } from '../../lib/members';
import styles from './TeamStrip.module.css';

interface TeamStripProps {
  members: readonly MemberView[];
  inbox: readonly InboxItem[] | undefined;
  activeTaskCount: number;
}

/** Standing roles with their status, plus the whole mixed team at a glance. */
export function TeamStrip({ members, inbox, activeTaskCount }: TeamStripProps) {
  const { key, myHandle } = useProject();
  const standing = members.filter(isStandingRole);
  const active = members.filter((member) => member.status !== 'retired');
  const humans = active.filter((member) => member.kind === 'human');
  const ai = active.filter((member) => member.kind === 'ai');
  const ordered = [...humans.filter((member) => member.handle === myHandle), ...humans.filter((member) => member.handle !== myHandle), ...ai];

  return (
    <section aria-label={t('board.teamStrip')} className={styles.strip}>
      {standing.map((member) => {
        const view = memberStatusView(member, inbox, myHandle);
        return (
          <Link key={member.handle} to={`/p/${key}/team`} className={styles.role}>
            <Avatar member={member} size="lg" status={view.status} />
            <span className={styles.text}>
              <span className={styles.top}>
                <span className={styles.name}>{member.displayName}</span>
                <span className={styles.status} data-status={view.status}>
                  {view.label}
                </span>
              </span>
              <span className={styles.activity}>{member.activity ?? t('team.noTask')}</span>
            </span>
          </Link>
        );
      })}
      <Link to={`/p/${key}/team`} className={styles.summary}>
        <AvatarStack
          size="md"
          max={6}
          label={t('board.teamSummaryDetail', { humans: humans.length, ai: ai.length })}
          members={ordered.map((member) => ({ member, handle: member.handle, isMe: member.handle === myHandle }))}
        />
        <span className={styles.text}>
          <span className={styles.name}>
            {t('board.teamSummary', { members: active.length, tasks: activeTaskCount })}
          </span>
          <span className={styles.activity}>{t('board.teamSummaryDetail', { humans: humans.length, ai: ai.length })}</span>
        </span>
      </Link>
    </section>
  );
}
