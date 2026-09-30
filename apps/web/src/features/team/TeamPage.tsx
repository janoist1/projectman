import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { MemberView } from '@projectman/shared';
import { useBoard, useConfig, useInbox, useMembers, useRoles, useTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { memberStatusView } from '../../lib/members';
import { MessageList } from '../messages/MessageList';
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
  | { kind: 'invite'; member?: MemberView }
  | { kind: 'hire' }
  | { kind: 'edit'; member: MemberView }
  | { kind: 'retire'; member: MemberView };

const statusRank: Record<string, number> = {
  needs_you: 0,
  waiting_for_human: 1,
  working: 2,
  online: 3,
  idle: 4,
  offline: 5,
  no_account: 6,
  invited: 6,
  retired: 7,
};

/** "Csapat": one roster of humans and AI members, hiring and retiring. */
export function TeamPage() {
  const { key, myHandle, can } = useProject();
  const isMobile = useIsMobile();
  const membersQuery = useMembers(key);
  const board = useBoard(key);
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
      (statusRank[memberStatusView(a, inbox.data?.items, myHandle).status] ?? 9) -
      (statusRank[memberStatusView(b, inbox.data?.items, myHandle).status] ?? 9);
    return rank !== 0 ? rank : a.displayName.localeCompare(b.displayName);
  });
  const activeTaskKeys = new Set(members.flatMap((member) => member.currentTaskKeys));
  const limits = config.data?.config.team.limits;
  const working = ai.filter((member) => member.status === 'working').length;
  const sponsors = new Set(ai.map((member) => member.sponsor));
  const allMine = sponsors.size === 1 && myHandle !== null && sponsors.has(myHandle);

  const memberActions = (member: MemberView) =>
    can.manageTeam ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          disabled={!roles.data || (member.kind === 'ai' && !config.data)}
          onClick={() => setDialog({ kind: 'edit', member })}
          aria-label={t('memberEdit.title', { name: member.displayName })}
        >
          {t('memberEdit.edit')}
        </Button>
        {member.kind === 'human' && member.status === 'no_account' ? (
          <Button variant="ghost" size="sm" onClick={() => setDialog({ kind: 'invite', member })}>
            {t('invites.create')}
          </Button>
        ) : null}
        {member.kind === 'ai' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDialog({ kind: 'retire', member })}
            aria-label={t('team.retireMember', { name: member.displayName, handle: member.handle })}
          >
            {t('team.retire')}
          </Button>
        ) : null}
      </>
    ) : null;
  const editing = dialog?.kind === 'edit' ? dialog.member : null;
  const retiring = dialog?.kind === 'retire' ? dialog.member : null;
  const Roster = isMobile ? RosterCards : RosterTable;

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titles}>
          <h1 className={styles.title}>{t('team.title')}</h1>
          <p className={styles.subtitle}>
            {t('team.subtitle', { humans: humans.length, ai: ai.length, tasks: activeTaskKeys.size })}
            {ai.length > 0
              ? ` · ${allMine ? t('team.subscriptionYours') : t('team.subscriptionMixed')}`
              : null}
          </p>
        </div>
        {(board.data?.aiEnabled ?? limits?.aiEnabled) === false ? (
          <div role="status" className={styles.limit}>
            <span>{t('team.aiDisabled')}</span>
            {can.manageTeam ? <Link to={`/p/${key}/settings`}>{t('team.aiDisabledSettings')}</Link> : null}
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
              {t('team.aiLimitValue', { working, max: limits.maxConcurrentAi })}
            </span>
          </div>
        ) : null}
        {can.manageTeam ? (
          <Button onClick={() => setDialog({ kind: 'addHuman' })}>{t('addHuman.title')}</Button>
        ) : null}
        {can.manageTeam ? (
          <Button onClick={() => setDialog({ kind: 'invite' })}>{t('invites.title')}</Button>
        ) : null}
        {can.manageTeam ? (
          <Button variant="primary" icon="plus" onClick={() => setDialog({ kind: 'hire' })}>
            {t('team.hire')}
          </Button>
        ) : null}
      </header>

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
            <Link to={`/p/${key}/messages`} className={styles.flowAll}>
              <span>{t('team.messagesAll')}</span>
              <Icon name="arrowRight" size={14} strokeWidth={2.2} />
            </Link>
          </aside>
        )}
      </div>

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
