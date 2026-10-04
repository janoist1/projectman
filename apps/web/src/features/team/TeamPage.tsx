import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { canSeeAllTeamMessages } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import { useBoard, useConfig, useInbox, useMembers, useRoles, useTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { PageHeader } from '../../components/PageHeader';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { aiSponsors, memberStatusView, nameOf } from '../../lib/members';
import { MessageList } from '../messages/MessageList';
import { usePausedRows } from '../pause/usePause';
import { ClosedCardsComparison } from './ClosedCardsComparison';
import { MemberMenu } from './MemberMenu';
import { RecentScheduleRuns } from './ScheduledRuns';
import { EditMemberDialog } from './EditMemberDialog';
import { RosterCards, RosterTable } from './Roster';
import { RoleSection } from './RoleSection';
import { AddHumanDialog } from './AddHumanDialog';
import { InviteDialog } from './InviteDialog';
import { PendingInvites } from './PendingInvites';
import { HireDialog } from './HireDialog';
import { RetireDialog } from './RetireDialog';
import styles from './TeamPage.module.css';

type MemberFilter = 'all' | 'humans' | 'ai';

/** The one team dialog open at a time. */
type TeamDialog =
  | { kind: 'addHuman' }
  | { kind: 'invite'; member: MemberView }
  | { kind: 'hire' }
  | { kind: 'edit'; member: MemberView }
  | { kind: 'retire'; member: MemberView };

const statusRank: Record<string, number> = {
  needs_you: 0,
  waiting_for_human: 1,
  working: 2,
  paused: 2,
  online: 3,
  idle: 4,
  offline: 5,
  no_account: 6,
  invited: 6,
  retired: 7,
};

/** "Csapat": one roster of humans and AI members, hiring and retiring. */
export function TeamPage() {
  const { key, myHandle, can, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const seesAllMessages = access ? canSeeAllTeamMessages({ access }) : false;
  const isMobile = useIsMobile();
  const membersQuery = useMembers(key);
  const board = useBoard(key);
  const pausedRows = usePausedRows();
  const inbox = useInbox(key);
  const config = useConfig(key, can.manageTeam);
  const roles = useRoles(key);
  const messages = useTeamMessages(key);
  const indexes = useProjectIndexes(key);
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [dialog, setDialog] = useState<TeamDialog | null>(null);
  const close = () => setDialog(null);
  useDocumentTitle(t('team.title'), board.data?.project.name);

  const list = membersQuery.data ?? board.data?.members;
  const members = useMemo(() => (list ?? []).filter((member) => member.status !== 'retired'), [list]);
  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );

  if (!list) {
    if (membersQuery.isError && board.isError)
      return <ErrorState error={membersQuery.error} onRetry={() => void membersQuery.refetch()} />;
    return <LoadingState />;
  }

  const humans = members.filter((member) => member.kind === 'human');
  const ai = members.filter((member) => member.kind === 'ai');
  const shown = filter === 'humans' ? humans : filter === 'ai' ? ai : members;
  const sorted = [...shown].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1;
    if (a.handle === myHandle || b.handle === myHandle) return a.handle === myHandle ? -1 : 1;
    const rank =
      (statusRank[memberStatusView(a, inbox.data?.items, myHandle, pausedRows).status] ?? 9) -
      (statusRank[memberStatusView(b, inbox.data?.items, myHandle, pausedRows).status] ?? 9);
    return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
  });
  const activeTaskKeys = new Set(members.flatMap((member) => member.currentTaskKeys));
  const limits = config.data?.config.team.limits;
  const working = ai.filter((member) => member.status === 'working').length;
  // Members whose approver is the AI while no AI member can decide for them any more.
  const lostDecider = ai.filter((member) => member.approver === 'ai' && member.aiApproverBlocker);
  const sponsors = aiSponsors(members);
  const sponsorName = (handle: string) => nameOf(handle, indexes.members, myHandle);
  const subscriptionNote = sponsors.mixed
    ? sponsors.usual === null
      ? t('team.subscriptionMixed')
      : sponsors.usual === myHandle
        ? t('team.subscriptionMajorityYours')
        : t('team.subscriptionMajority', { name: sponsorName(sponsors.usual) })
    : sponsors.only === null
      ? null
      : sponsors.only === myHandle
        ? t('team.subscriptionYours')
        : t('team.subscriptionOther', { name: sponsorName(sponsors.only) });

  const memberActions = (member: MemberView) =>
    can.manageTeam ? (
      <MemberMenu
        member={member}
        editDisabled={!roles.data || (member.kind === 'ai' && !config.data)}
        onEdit={() => setDialog({ kind: 'edit', member })}
        onInvite={() => setDialog({ kind: 'invite', member })}
        onRetire={() => setDialog({ kind: 'retire', member })}
      />
    ) : null;
  const editing = dialog?.kind === 'edit' ? dialog.member : null;
  const retiring = dialog?.kind === 'retire' ? dialog.member : null;
  const Roster = isMobile ? RosterCards : RosterTable;

  return (
    <div className={styles.page}>
      <PageHeader
        className={styles.header}
        hideTitleOnPhone
        title={t('team.title')}
        subtitle={
          <>
            {t('team.subtitle', { humans: humans.length, ai: ai.length, tasks: activeTaskKeys.size })}
            {subscriptionNote ? ` · ${subscriptionNote}` : null}
          </>
        }
      >
        {(board.data?.aiEnabled ?? limits?.aiEnabled) === false ? (
          <div role="status" className={styles.limit}>
            <span>{t('team.aiDisabled')}</span>
            {can.manageTeam ? (
              <Link to={`/p/${key}/settings/limits`}>{t('team.aiDisabledSettings')}</Link>
            ) : null}
          </div>
        ) : null}
        {limits ? (
          <div className={styles.limit}>
            <span className={styles.limitText}>
              <span className={styles.limitTitle}>{t('team.aiLimit')}</span>
              <span className={styles.limitHint}>
                {t('team.aiLimitHint', { percent: limits.pauseAbovePlanUsagePercent })}
              </span>
            </span>
            <span className={styles.limitValue}>
              {limits.maxConcurrentAi === undefined
                ? t('team.aiNoLimitValue', { working })
                : t('team.aiLimitValue', { working, max: limits.maxConcurrentAi })}
            </span>
          </div>
        ) : null}
        {can.manageTeam ? (
          <Button
            className={styles.hire}
            variant="primary"
            icon="plus"
            onClick={() => setDialog({ kind: 'hire' })}
          >
            {t('team.hire')}
          </Button>
        ) : null}
        {can.manageTeam ? (
          <Button variant="secondary" onClick={() => setDialog({ kind: 'addHuman' })}>
            {t('addHuman.title')}
          </Button>
        ) : null}
      </PageHeader>

      {lostDecider.length > 0 ? (
        <div role="status" className={styles.limit} aria-label={t('permissionControls.lostApproverLabel')}>
          <span>
            {t('permissionControls.lostApprover', {
              names: lostDecider.map((m) => m.displayName).join(', '),
            })}
          </span>
        </div>
      ) : null}

      <div className={styles.content}>
        <section className={styles.roster} aria-labelledby="team-roster">
          <div className={styles.rosterHead}>
            <h2 id="team-roster" className={styles.sectionTitle}>
              {t('team.roster')}
            </h2>
            <SegmentedControl<MemberFilter>
              label={t('team.filtersLabel')}
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: t('team.filters.all'), count: members.length },
                { value: 'humans', label: t('team.filters.humans'), count: humans.length },
                { value: 'ai', label: t('team.filters.ai'), count: ai.length },
              ]}
            />
          </div>
          {sorted.length === 0 ? <EmptyState icon="team" title={t('team.empty')} /> : null}
          <Roster
            members={sorted}
            inbox={inbox.data?.items}
            roles={roles.data?.roles}
            titles={titles}
            actions={memberActions}
          />
        </section>

        {isMobile ? null : (
          <aside className={styles.flow} aria-labelledby="team-flow">
            <div className={styles.flowHead}>
              <h2 id="team-flow" className={styles.flowTitle}>
                {t('team.messagesTitle')}
              </h2>
              <span className={styles.muted}>{t('team.messagesHint')}</span>
            </div>
            {messages.data ? (
              <MessageList
                messages={[...messages.data.messages]
                  .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                  .slice(0, 8)}
                members={indexes.members}
                myHandle={myHandle}
                projectKey={key}
                taskTitles={titles}
                compact
              />
            ) : messages.isError ? (
              <ErrorState compact error={messages.error} />
            ) : (
              <LoadingState compact />
            )}
            <Link to={`/p/${key}/messages${seesAllMessages ? '/all' : ''}`} className={styles.flowAll}>
              <span>{t('team.messagesAll')}</span>
              <Icon name="arrowRight" size={14} strokeWidth={2.2} />
            </Link>
          </aside>
        )}
      </div>

      <ClosedCardsComparison />
      <RecentScheduleRuns />
      <PendingInvites />
      <AddHumanDialog open={dialog?.kind === 'addHuman'} onClose={close} />
      <InviteDialog
        open={dialog?.kind === 'invite'}
        member={dialog?.kind === 'invite' ? dialog.member : undefined}
        onClose={close}
      />
      <RoleSection config={config.data?.config} />
      <EditMemberDialog
        member={editing}
        config={config.data?.config}
        roles={roles.data?.roles ?? []}
        onClose={close}
      />
      <HireDialog open={dialog?.kind === 'hire'} onClose={close} config={config.data?.config} />
      <RetireDialog
        member={retiring}
        candidates={ai.filter((member) => member.handle !== retiring?.handle)}
        onClose={close}
      />
    </div>
  );
}
