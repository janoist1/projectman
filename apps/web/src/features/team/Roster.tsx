import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { InboxItem, MemberView, RoleView } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Chip, StatusDot } from '../../components/Chip';
import { LeaveChip } from '../../components/LeaveChip';
import { ProviderBadge } from '../../components/ProviderBadge';
import { t } from '../../i18n/t';
import { aiSponsors, memberStatusView, nameOf } from '../../lib/members';
import { aiRoleView, humanRoleName } from '../../lib/roles';
import { MemberScheduleControl } from './ScheduledRuns';
import styles from './Roster.module.css';

export interface RosterProps {
  members: readonly MemberView[];
  inbox: readonly InboxItem[] | undefined;
  roles: readonly RoleView[] | undefined;
  /** Task titles by key, for the tasks each member carries. */
  titles: ReadonlyMap<string, string>;
  /** The buttons at the end of a member's row (edit, invite, retire). */
  actions: (member: MemberView) => ReactNode;
}

/**
 * A member's roles as chips. On a phone card (`compact`) the line must not wrap: the first role and a
 * "+N" for the rest, and no access level for a human (the profile says it).
 */
function RoleChips({
  member,
  roles,
  compact = false,
}: {
  member: MemberView;
  roles: RosterProps['roles'];
  compact?: boolean;
}) {
  const shown = compact ? member.roles.slice(0, 1) : member.roles;
  const hidden = member.roles.length - shown.length;
  return (
    <>
      {member.kind === 'human' && !compact ? <span>{humanRoleName(member.role)}</span> : null}
      {shown.map((id) => {
        const view = aiRoleView(id, member.specialty, roles);
        return (
          <Chip key={id} icon={view.icon} data-tone={view.tone} className={styles.roleChip}>
            {view.name}
          </Chip>
        );
      })}
      {hidden > 0 ? (
        <Chip role="img" aria-label={t('team.moreRoles', { count: hidden })}>
          {t('team.more', { count: hidden })}
        </Chip>
      ) : null}
    </>
  );
}

/** Avatar, name (with AI, provider and temp chips), handle and roles. */
function MemberIdentity({
  member,
  status,
  roles,
  stretched = false,
  compact = false,
}: {
  member: MemberView;
  status: ReturnType<typeof memberStatusView>['status'];
  roles: RosterProps['roles'];
  /** The profile link covers its whole card (the card's other controls stay on top of it). */
  stretched?: boolean;
  /** The phone card: one role chip and a "+N" (see RoleChips). */
  compact?: boolean;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  return (
    <div className={styles.memberCell}>
      <Avatar member={member} isMe={member.handle === myHandle} size="lg" status={status} />
      <span className={styles.memberText}>
        <span className={styles.memberName}>
          <Link to={`/p/${key}/team/${member.handle}`} className={stretched ? styles.profileLink : undefined}>
            {nameOf(member.handle, members, myHandle)}
          </Link>
          {member.kind === 'ai' ? (
            <>
              <Chip tone="dark">{t('common.ai')}</Chip>
              <ProviderBadge provider={member.provider} />
            </>
          ) : null}
          {member.temp ? <Chip tone="needs">{t('team.temp')}</Chip> : null}
          <LeaveChip member={member} />
        </span>
        <span className={styles.handle}>
          <span className={styles.mono}>{member.handle}</span> ·{' '}
          <RoleChips member={member} roles={roles} compact={compact} />
        </span>
      </span>
    </div>
  );
}

/**
 * The tasks a member carries (at most two; the phone card shows the first and a "+N" for the rest).
 * The command a session runs is not shown here.
 */
function MemberTasks({
  member,
  titles,
  compact = false,
}: {
  member: MemberView;
  titles: RosterProps['titles'];
  compact?: boolean;
}) {
  const { key } = useProject();
  if (member.currentTaskKeys.length === 0) return <span className={styles.muted}>{t('team.noTask')}</span>;
  const limit = compact ? 1 : 2;
  const hidden = compact ? member.currentTaskKeys.length - limit : 0;
  return (
    <span className={styles.tasks}>
      {member.currentTaskKeys.slice(0, limit).map((taskKey) => (
        <Link key={taskKey} to={`/p/${key}/tasks/${taskKey}`} className={styles.taskLink}>
          <span className={styles.taskKey}>{taskKey}</span>
          <span className={styles.taskTitle}>{titles.get(taskKey) ?? ''}</span>
        </Link>
      ))}
      {hidden > 0 ? (
        <span
          role="img"
          aria-label={t('team.moreTasks', { count: hidden })}
          className={`${styles.muted} ${styles.moreTasks}`}
        >
          {t('team.more', { count: hidden })}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Whose subscription runs an AI member, shown only where it tells something: nothing while every AI
 * member runs on the same one (the page subtitle says whose), else the members that differ from the
 * usual one (the subtitle names it), or every AI member when none leads.
 */
function useSponsorNote(members: readonly MemberView[]) {
  const { key, myHandle } = useProject();
  const { members: all } = useProjectIndexes(key);
  const { mixed, usual } = aiSponsors(members);
  const text = (member: MemberView) => {
    if (member.kind === 'human')
      return t(member.status === 'no_account' ? 'memberStatus.no_account' : 'team.ownAccount');
    if (!member.sponsor) return t('common.dash');
    return member.sponsor === myHandle
      ? t('team.sponsorYou')
      : t('team.sponsorOther', { name: nameOf(member.sponsor, all, myHandle) });
  };
  return {
    /** Whether the subscription column of the table is worth its room. */
    mixed,
    text,
    /** The line on a card: the AI members that differ from the usual subscription (all, with no usual). */
    note: (member: MemberView) =>
      member.kind === 'ai' && mixed && (usual === null || (member.sponsor || '') !== usual)
        ? text(member)
        : null,
  };
}

/** The roster as a table (desktop and tablet). */
export function RosterTable({ members, inbox, roles, titles, actions }: RosterProps) {
  const { myHandle } = useProject();
  const sponsor = useSponsorNote(members);
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('team.columns.member')}</th>
            <th scope="col">{t('team.columns.status')}</th>
            <th scope="col">{t('team.columns.now')}</th>
            {sponsor.mixed ? (
              <th scope="col" className={styles.subscriptionCol}>
                {t('team.columns.subscription')}
              </th>
            ) : null}
            <th scope="col">
              <span className="visually-hidden">{t('team.columns.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const view = memberStatusView(member, inbox, myHandle);
            return (
              <tr key={member.handle}>
                <td>
                  <MemberIdentity member={member} status={view.status} roles={roles} />
                </td>
                <td>
                  <span className={styles.statusCell} data-status={view.status}>
                    <span className={styles.statusLine}>
                      <StatusDot status={view.status} pulse={view.status === 'working'} />
                      <span className={styles.statusText}>{view.label}</span>
                    </span>
                  </span>
                </td>
                <td className={styles.nowCell}>
                  <MemberTasks member={member} titles={titles} />
                  <MemberScheduleControl handle={member.handle} />
                </td>
                {sponsor.mixed ? (
                  <td className={`${styles.muted} ${styles.subscriptionCol}`}>{sponsor.text(member)}</td>
                ) : null}
                <td className={styles.actionsCell}>{actions(member)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The roster as cards (phones). */
export function RosterCards({ members, inbox, roles, titles, actions }: RosterProps) {
  const { myHandle } = useProject();
  const sponsor = useSponsorNote(members);
  return (
    <ul className={styles.cards}>
      {members.map((member) => {
        const view = memberStatusView(member, inbox, myHandle);
        const note = sponsor.note(member);
        const menu = actions(member);
        return (
          <li key={member.handle} className={styles.card}>
            <div className={styles.cardHead}>
              <MemberIdentity member={member} status={view.status} roles={roles} stretched compact />
              {menu}
            </div>
            <div className={styles.cardState}>
              <span className={styles.statusLine} data-status={view.status}>
                <StatusDot status={view.status} pulse={view.status === 'working'} />
                <span className={styles.statusText}>{view.label}</span>
              </span>
              <span aria-hidden="true" className={styles.muted}>
                ·
              </span>
              <MemberTasks member={member} titles={titles} compact />
            </div>
            <MemberScheduleControl handle={member.handle} />
            {note ? <span className={styles.muted}>{note}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
