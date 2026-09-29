import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import type { MemberView } from '@projectman/shared';
import { useBoard, useConfig, useInbox, useMembers, useTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Icon } from '../../components/Icon';
import { SegmentedControl } from '../../components/SegmentedControl';
import { EmptyState, ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { useDocumentTitle, useIsMobile } from '../../lib/hooks';
import { memberStatusView, nameOf, roleLabel } from '../../lib/members';
import { MessageList } from '../messages/MessageList';
import { HireDialog } from './HireDialog';
import { RetireDialog } from './RetireDialog';
import styles from './TeamPage.module.css';

type MemberFilter = 'all' | 'humans' | 'ai';

const statusRank: Record<string, number> = {
  needs_you: 0,
  waiting_for_human: 1,
  working: 2,
  online: 3,
  idle: 4,
  offline: 5,
  invited: 6,
  retired: 7,
};

/** "Csapat": one roster of humans and AI members, hiring and retiring. */
export function TeamPage() {
  const { key, myHandle } = useProject();
  const isMobile = useIsMobile();
  const membersQuery = useMembers(key);
  const board = useBoard(key);
  const inbox = useInbox(key);
  const config = useConfig(key);
  const messages = useTeamMessages(key);
  const indexes = useProjectIndexes(key);
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [hireOpen, setHireOpen] = useState(false);
  const [retiring, setRetiring] = useState<MemberView | null>(null);
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

  const sponsorText = (member: MemberView) => {
    if (member.kind === 'human') return t('team.ownAccount');
    if (!member.sponsor) return t('common.dash');
    return member.sponsor === myHandle
      ? t('team.sponsorYou')
      : t('team.sponsorOther', { name: nameOf(member.sponsor, indexes.members, myHandle) });
  };

  const taskLinks = (member: MemberView) =>
    member.currentTaskKeys.length === 0 ? (
      <span className={styles.muted}>{member.activity ?? t('team.noTask')}</span>
    ) : (
      <span className={styles.tasks}>
        {member.currentTaskKeys.slice(0, 2).map((taskKey) => (
          <Link key={taskKey} to={`/p/${key}/tasks/${taskKey}`} className={styles.taskLink}>
            <span className={styles.taskKey}>{taskKey}</span>
            <span className={styles.taskTitle}>{titles.get(taskKey) ?? ''}</span>
          </Link>
        ))}
      </span>
    );

  const retireButton = (member: MemberView) =>
    member.kind === 'ai' ? (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setRetiring(member)}
        aria-label={t('team.retireMember', { name: member.displayName, handle: member.handle })}
      >
        {t('team.retire')}
      </Button>
    ) : null;

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
        <Button variant="primary" icon="plus" onClick={() => setHireOpen(true)}>
          {t('team.hire')}
        </Button>
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
          {isMobile ? (
            <ul className={styles.cards}>
              {sorted.map((member) => {
                const view = memberStatusView(member, inbox.data?.items, myHandle);
                return (
                  <li key={member.handle} className={styles.card}>
                    <div className={styles.memberCell}>
                      <Avatar
                        member={member}
                        isMe={member.handle === myHandle}
                        size="lg"
                        status={view.status}
                      />
                      <span className={styles.memberText}>
                        <span className={styles.memberName}>
                          {nameOf(member.handle, indexes.members, myHandle)}
                          {member.kind === 'ai' ? <Chip tone="dark">{t('common.ai')}</Chip> : null}
                          {member.temp ? <Chip tone="needs">{t('team.temp')}</Chip> : null}
                        </span>
                        <span className={styles.handle}>
                          <span className={styles.mono}>{member.handle}</span> · {roleLabel(member)}
                        </span>
                      </span>
                    </div>
                    <span className={styles.statusLine} data-status={view.status}>
                      <StatusDot status={view.status} pulse={view.status === 'working'} />
                      <span className={styles.statusText}>{view.label}</span>
                    </span>
                    {taskLinks(member)}
                    <span className={styles.cardFoot}>
                      <span className={styles.muted}>{sponsorText(member)}</span>
                      {retireButton(member)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
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
                  {sorted.map((member) => {
                    const view = memberStatusView(member, inbox.data?.items, myHandle);
                    return (
                      <tr key={member.handle}>
                        <td>
                          <div className={styles.memberCell}>
                            <Avatar
                              member={member}
                              isMe={member.handle === myHandle}
                              size="lg"
                              status={view.status}
                            />
                            <span className={styles.memberText}>
                              <span className={styles.memberName}>
                                {nameOf(member.handle, indexes.members, myHandle)}
                                {member.kind === 'ai' ? <Chip tone="dark">{t('common.ai')}</Chip> : null}
                                {member.temp ? <Chip tone="needs">{t('team.temp')}</Chip> : null}
                              </span>
                              <span className={styles.handle}>
                                <span className={styles.mono}>{member.handle}</span> · {roleLabel(member)}
                              </span>
                            </span>
                          </div>
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
                        <td className={styles.nowCell}>{taskLinks(member)}</td>
                        <td className={`${styles.muted} ${styles.subscriptionCol}`}>{sponsorText(member)}</td>
                        <td className={styles.actionsCell}>{retireButton(member)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
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

      <HireDialog open={hireOpen} onClose={() => setHireOpen(false)} config={config.data?.config} />
      <RetireDialog
        member={retiring}
        candidates={ai.filter((member) => member.handle !== retiring?.handle)}
        onClose={() => setRetiring(null)}
      />
    </div>
  );
}
