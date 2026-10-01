import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { InboxItem, MemberView, RoleView } from '@projectman/shared';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Chip, StatusDot } from '../../components/Chip';
import { ProviderBadge } from '../../components/ProviderBadge';
import { t } from '../../i18n/t';
import { memberStatusView, nameOf } from '../../lib/members';
import { aiRoleView, humanRoleName, whenToAsk } from '../../lib/roles';
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

function RoleChips({ member, roles }: { member: MemberView; roles: RosterProps['roles'] }) {
  return (
    <>
      {member.kind === 'human' ? <span>{humanRoleName(member.role)}</span> : null}
      {member.roles.map((id) => {
        const view = aiRoleView(id, member.specialty, roles);
        return (
          <Chip key={id} icon={view.icon} data-tone={view.tone} className={styles.roleChip}>
            {view.name}
          </Chip>
        );
      })}
    </>
  );
}

/** Avatar, name (with AI, provider and temp chips), handle and roles. */
function MemberIdentity({
  member,
  status,
  roles,
}: {
  member: MemberView;
  status: ReturnType<typeof memberStatusView>['status'];
  roles: RosterProps['roles'];
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const ask = whenToAsk(member.roles, roles);
  return (
    <div className={styles.memberCell}>
      <Avatar member={member} isMe={member.handle === myHandle} size="lg" status={status} />
      <span className={styles.memberText}>
        <span className={styles.memberName}>
          <Link to={`/p/${key}/team/${member.handle}`}>{nameOf(member.handle, members, myHandle)}</Link>
          {member.kind === 'ai' ? (
            <>
              <Chip tone="dark">{t('common.ai')}</Chip>
              <ProviderBadge provider={member.provider} />
            </>
          ) : null}
          {member.temp ? <Chip tone="needs">{t('team.temp')}</Chip> : null}
          {member.onLeave ? <Chip tone="needs">{t('leave.onLeave')}</Chip> : null}
        </span>
        <span className={styles.handle}>
          <span className={styles.mono}>{member.handle}</span> · <RoleChips member={member} roles={roles} />
        </span>
        {ask ? (
          <span className={styles.whenToAsk}>
            {t('roleCatalogue.whenToAsk')}: {ask}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** The tasks a member carries (at most two), or what they do now. */
function MemberTasks({ member, titles }: { member: MemberView; titles: RosterProps['titles'] }) {
  const { key } = useProject();
  if (member.currentTaskKeys.length === 0)
    return <span className={styles.muted}>{member.activity ?? t('team.noTask')}</span>;
  return (
    <span className={styles.tasks}>
      {member.currentTaskKeys.slice(0, 2).map((taskKey) => (
        <Link key={taskKey} to={`/p/${key}/tasks/${taskKey}`} className={styles.taskLink}>
          <span className={styles.taskKey}>{taskKey}</span>
          <span className={styles.taskTitle}>{titles.get(taskKey) ?? ''}</span>
        </Link>
      ))}
    </span>
  );
}

/** Whose subscription runs an AI member; for humans, whether they have an account. */
function useSponsorText() {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  return (member: MemberView) => {
    if (member.kind === 'human')
      return t(member.status === 'no_account' ? 'memberStatus.no_account' : 'team.ownAccount');
    if (!member.sponsor) return t('common.dash');
    return member.sponsor === myHandle
      ? t('team.sponsorYou')
      : t('team.sponsorOther', { name: nameOf(member.sponsor, members, myHandle) });
  };
}

/** The roster as a table (desktop and tablet). */
export function RosterTable({ members, inbox, roles, titles, actions }: RosterProps) {
  const { myHandle } = useProject();
  const sponsorText = useSponsorText();
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('team.columns.member')}</th>
            <th scope="col">{t('team.columns.status')}</th>
            <th scope="col">{t('team.columns.now')}</th>
            <th scope="col" className={styles.subscriptionCol}>
              {t('team.columns.subscription')}
            </th>
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
                    {member.activity && member.currentTaskKeys.length > 0 ? (
                      <span className={styles.activity}>{member.activity}</span>
                    ) : null}
                  </span>
                </td>
                <td className={styles.nowCell}>
                  <MemberTasks member={member} titles={titles} />
                  <MemberScheduleControl handle={member.handle} />
                </td>
                <td className={`${styles.muted} ${styles.subscriptionCol}`}>{sponsorText(member)}</td>
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
  const sponsorText = useSponsorText();
  return (
    <ul className={styles.cards}>
      {members.map((member) => {
        const view = memberStatusView(member, inbox, myHandle);
        return (
          <li key={member.handle} className={styles.card}>
            <MemberIdentity member={member} status={view.status} roles={roles} />
            <span className={styles.statusLine} data-status={view.status}>
              <StatusDot status={view.status} pulse={view.status === 'working'} />
              <span className={styles.statusText}>{view.label}</span>
            </span>
            <MemberTasks member={member} titles={titles} />
            <MemberScheduleControl handle={member.handle} />
            <span className={styles.cardFoot}>
              <span className={styles.muted}>{sponsorText(member)}</span>
              {actions(member)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
