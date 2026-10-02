import { InviteDialog } from './InviteDialog';
import { useState } from 'react';
import { providerModelLabel } from './providerModels';
import { Link, useNavigate, useParams } from 'react-router';
import { cheapSubagentOf, DEFAULT_AGENT_PROVIDER, mergeTokenUsage, roleBundle } from '@projectman/shared';
import type { SchedulesView, TeamMessage } from '@projectman/shared';
import {
  useBoard,
  useConfig,
  useSchedules,
  useLabels,
  useMemberMemories,
  useMemberProfile,
  useReadTeamMessage,
  useRemoveHuman,
  useRoles,
  useSessionDetail,
  useStartConversation,
  useMemberMessages,
} from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { PlanUsageMeter } from '../../app/PlanUsageMeter';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Chip } from '../../components/Chip';
import { PageHeader } from '../../components/PageHeader';
import { ProviderBadge } from '../../components/ProviderBadge';
import { Timeline } from '../../components/Timeline';
import { TokenUsageList } from '../../components/TokenUsage';
import { useToast } from '../../components/toastContext';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { formatStamp } from '../../i18n/format';
import { errorMessage } from '../../lib/errors';
import { memberStatusView } from '../../lib/members';
import { isLiveSession } from '../../lib/sessions';
import { aiRoleView, humanRoleName } from '../../lib/roles';
import { useDocumentTitle } from '../../lib/hooks';
import { describeCron } from '../../lib/schedules';
import { MessageComposer } from '../messages/MessageComposer';
import { MessageList } from '../messages/MessageList';
import { ChatView } from '../session/ChatView';
import { EditMemberDialog } from './EditMemberDialog';
import { LeaveButton } from './LeaveButton';
import { MemberMenu } from './MemberMenu';
import { RetireDialog } from './RetireDialog';
import { PermissionLevelControl } from './PermissionLevelControl';
import { MemberScheduleControl } from './ScheduledRuns';
import styles from './MemberProfilePage.module.css';

function SessionPeek({ sessionId }: { sessionId: string }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const detail = useSessionDetail(key, sessionId);
  if (detail.error) return <ErrorState compact error={detail.error} />;
  if (!detail.data) return <LoadingState compact />;
  return (
    <ChatView
      items={detail.data.chat.slice(-8)}
      members={members}
      myHandle={myHandle}
      sessionMember={detail.data.session.member}
    />
  );
}

/** The member's schedule; a member without one has no panel (the page says so in its quiet line). */
function MemberSchedule({
  handle,
  schedule,
}: {
  handle: string;
  schedule: SchedulesView['members'][number];
}) {
  return (
    <section className={styles.panel}>
      <h2 className={styles.panelTitle}>{t('schedules.form.title')}</h2>
      <p className={styles.when} title={schedule.cron}>
        {describeCron(schedule.cron)}
      </p>
      <p>{schedule.promptSummary}</p>
      <MemberScheduleControl handle={handle} />
    </section>
  );
}

export function MemberProfilePage() {
  const { handle = '' } = useParams();
  const { key, myHandle, can, me } = useProject();
  const navigate = useNavigate();
  const profile = useMemberProfile(key, handle);
  const board = useBoard(key);
  const indexes = useProjectIndexes(key);
  const labels = useLabels(key);
  const roles = useRoles(key);
  const config = useConfig(key, can.manageTeam);
  const messages = useMemberMessages(key, handle, myHandle);
  const start = useStartConversation(key);
  const remove = useRemoveHuman(key);
  const read = useReadTeamMessage(key);
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reply, setReply] = useState<TeamMessage | null>(null);
  const access = me.projects.find((p) => p.key === key)?.access;
  const internal = access !== 'client';
  const canSend = access !== undefined && ['owner', 'admin', 'developer', 'client'].includes(access);
  const memory = useMemberMemories(key, handle, internal && profile.data?.member.kind === 'ai');
  const schedules = useSchedules(key, internal && profile.data?.member.kind === 'ai');
  useDocumentTitle(profile.data?.member.displayName ?? t('profile.title'), board.data?.project.name);
  if (profile.error) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  if (!profile.data) return <LoadingState />;
  const data = profile.data;
  const member = data.member;
  const ai = member.kind === 'ai';
  const cheapSubagent = cheapSubagentOf(member);
  const ownConfig = config.data?.config.team.members.find((entry) => entry.handle === handle);
  const status = memberStatusView(member, data.inbox, myHandle);
  const live = data.sessions.filter(isLiveSession);
  const pastSessions = data.sessions.filter((s) => !live.includes(s)).slice(0, 10);
  const schedule = schedules.data?.members.find((entry) => entry.member === handle);
  const usageEmpty =
    data.usage?.lastDay != null &&
    data.usage.lastWeek != null &&
    mergeTokenUsage(data.usage.lastDay).length === 0 &&
    mergeTokenUsage(data.usage.lastWeek).length === 0;
  // What there is nothing of is one quiet line, not a box each.
  const nothingYet = [
    data.tasks.length === 0 ? t('profile.noTasks') : null,
    !ai && data.inbox.length === 0 ? t('profile.noWaiting') : null,
    ai && internal && schedules.data && !schedule ? t('profile.noSchedule') : null,
    ai && internal && live.length === 0 && pastSessions.length === 0 ? t('profile.noSessions') : null,
    ai && internal && usageEmpty ? t('tokenUsage.none') : null,
    ai && internal && memory.data?.memory === '' ? t('profile.memoryEmpty') : null,
  ].filter((text): text is string => text !== null);
  const titles = new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title]));
  const thread = (messages.data?.messages ?? []).filter((m) =>
    handle === myHandle
      ? m.from === handle || m.to.includes(handle)
      : (m.from === myHandle && m.to.includes(handle)) ||
        (m.from === handle && myHandle !== null && m.to.includes(myHandle)),
  );
  return (
    <div className={styles.page}>
      <Link to={`/p/${key}/team`}>{t('team.title')}</Link>
      <PageHeader
        className={styles.header}
        leading={<Avatar member={member} size="lg" status={status.status} />}
        title={member.displayName}
        subtitle={
          <>
            <code>{member.handle}</code> · <span>{status.label}</span>
          </>
        }
      >
        <div className={styles.actions}>
          {ai && member.onLeave && can.manageTeam ? <LeaveButton member={member} variant="primary" /> : null}
          {ai && !member.onLeave && can.workInSessions ? (
            <Button
              variant="primary"
              loading={start.isPending}
              onClick={() =>
                start.mutate(handle, {
                  onSuccess: (session) => {
                    void navigate(`/p/${key}/sessions/${session.id}`);
                  },
                })
              }
            >
              {t('profile.conversation')}
            </Button>
          ) : null}
          {can.manageTeam ? (
            <MemberMenu
              member={member}
              editDisabled={!roles.data || (ai && !config.data)}
              onEdit={() => setEditing(true)}
              onInvite={() => setInviting(true)}
              onRetire={() => setRetiring(true)}
              onRemove={
                member.handle === myHandle
                  ? undefined
                  : () => {
                      remove.reset();
                      setRemoving(true);
                    }
              }
            />
          ) : null}
        </div>
      </PageHeader>
      {member.onLeave ? (
        <p role="status" className={styles.leaveNote}>
          {t('leave.status')}
        </p>
      ) : null}
      {start.error ? <ErrorBanner>{errorMessage(start.error)}</ErrorBanner> : null}
      <section className={styles.panel}>
        {!ai ? (
          <p>
            {t('invites.access')}: {humanRoleName(member.role)}
          </p>
        ) : null}
        {member.roles.map((role) => {
          const view = aiRoleView(role, member.specialty, roles.data?.roles);
          return (
            <div key={role} className={styles.role} aria-label={view.name}>
              <h2 className={styles.panelTitle}>{view.name}</h2>
              {view.summary ? <p>{view.summary}</p> : null}
              {view.notTheirJob ? (
                <p>
                  {t('roleCatalogue.notTheirJob')}: {view.notTheirJob}
                </p>
              ) : null}
              {view.whenToAsk ? (
                <p>
                  {t('roleCatalogue.whenToAsk')}: {view.whenToAsk}
                </p>
              ) : null}
            </div>
          );
        })}
        {data.duties.length ? (
          <div className={styles.role}>
            <h2 className={styles.panelTitle}>{t('profile.duties')}</h2>
            <ul className={styles.chips}>
              {data.duties.map((duty) => (
                <li key={duty}>
                  <Chip>{t(`dutyNames.${duty}`)}</Chip>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {data.email ? (
          <p>
            {t('profile.email')}: <a href={`mailto:${data.email}`}>{data.email}</a>
          </p>
        ) : null}
        {ai && ownConfig?.kind === 'ai' && config.data ? (
          <Fold summary={t('profile.instructions')}>
            <div className={styles.instructions}>
              <h3>
                {t('profile.roleInstructions', {
                  role: aiRoleView(member.role, member.specialty, roles.data?.roles).name,
                })}
              </h3>
              <pre className={styles.memory}>
                {roleBundle(config.data.config, member.role).instructions.trim() ||
                  t('profile.noInstructions')}
              </pre>
              <p>
                <Link to={`/p/${key}/settings`}>{t('profile.roleInstructionsEdit')}</Link>
              </p>
              <h3>{t('profile.ownInstructions')}</h3>
              <pre className={styles.memory}>
                {ownConfig.instructions.trim() || t('profile.noInstructions')}
              </pre>
            </div>
          </Fold>
        ) : null}
      </section>
      <div className={styles.grid}>
        {data.tasks.length ? (
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>{t('profile.tasks')}</h2>
            <ul className={styles.list}>
              {data.tasks.map((task) => (
                <li key={task.key}>
                  <Link to={`/p/${key}/tasks/${task.key}`}>
                    {task.key} · {task.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {!ai && data.inbox.length ? (
          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>{t('profile.waiting')}</h2>
            <ul className={styles.list}>
              {data.inbox.map((item) => (
                <li key={item.id}>
                  <Link to={`/p/${key}/inbox`}>{item.title}</Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {ai && internal && schedule ? <MemberSchedule handle={handle} schedule={schedule} /> : null}
        {ai && internal && schedules.error ? <ErrorState compact error={schedules.error} /> : null}
      </div>
      {nothingYet.length ? <p className={styles.quiet}>{nothingYet.join(' ')}</p> : null}
      {ai ? (
        <details className={styles.fold} open={settingsOpen}>
          <summary
            className={styles.foldSummary}
            aria-expanded={settingsOpen}
            onClick={(event) => {
              event.preventDefault();
              setSettingsOpen(!settingsOpen);
            }}
          >
            <Icon name="chevronRight" size={14} strokeWidth={2.4} className={styles.chevron} />
            <h2 className={styles.panelTitle}>{t('profile.settings')}</h2>
          </summary>
          <div className={styles.settings}>
            <div className={styles.modelLine}>
              <ProviderBadge provider={member.provider} />
              <span>
                {member.model
                  ? providerModelLabel(member.provider ?? DEFAULT_AGENT_PROVIDER, member.model)
                  : t('common.dash')}{' '}
                ·{' '}
                {member.effort
                  ? t(`providerSettings.efforts.${member.effort}`)
                  : member.provider === 'codex'
                    ? t('providerSettings.efforts.medium')
                    : t('providerSettings.defaultEffort')}
              </span>
            </div>
            {cheapSubagent ? (
              <p>
                {t('providerSettings.cheapSubagentProfile', {
                  model: t(`providerSettings.cheapSubagentModels.${cheapSubagent}`),
                })}
              </p>
            ) : null}
            <p>{t('profile.capacity', { used: data.capacityUsed, max: data.capacity ?? 0 })}</p>
            <PermissionLevelControl member={member} />
            <PlanUsageMeter
              provider={member.provider ?? DEFAULT_AGENT_PROVIDER}
              usage={board.data?.planUsageByProvider[member.provider ?? DEFAULT_AGENT_PROVIDER]}
              pauseAbove={config.data?.config.team.limits.pauseAbovePlanUsagePercent}
            />
          </div>
        </details>
      ) : null}
      {ai && internal ? (
        <>
          {live.length || pastSessions.length ? (
            <section className={styles.panel}>
              {live.length ? <h2 className={styles.panelTitle}>{t('profile.live')}</h2> : null}
              {live.map((session) => (
                <div key={session.id}>
                  <Link to={`/p/${key}/sessions/${session.id}`}>
                    {t('profile.openSession')} ·{' '}
                    {session.workItem.type === 'task' ? session.workItem.taskKey : t('profile.general')}
                  </Link>
                  <SessionPeek sessionId={session.id} />
                </div>
              ))}
              {pastSessions.length ? (
                <>
                  <h2 className={styles.panelTitle}>{t('profile.sessions')}</h2>
                  <ul className={styles.list}>
                    {pastSessions.map((session) => (
                      <li key={session.id}>
                        <Link to={`/p/${key}/sessions/${session.id}`}>
                          {session.workItem.type === 'task' ? session.workItem.taskKey : t('profile.general')}{' '}
                          · {formatStamp(session.startedAt)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
          {usageEmpty ? null : (
            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t('tokenUsage.title')}</h2>
              <h3 className={styles.usageWindow}>{t('tokenUsage.lastDay')}</h3>
              <TokenUsageList rows={data.usage?.lastDay ?? null} />
              <h3 className={styles.usageWindow}>{t('tokenUsage.lastWeek')}</h3>
              <TokenUsageList rows={data.usage?.lastWeek ?? null} />
            </section>
          )}
          {memory.error || memory.isPending || memory.data.memory ? (
            <section className={styles.panel}>
              <h2 className={styles.panelTitle}>{t('profile.memory')}</h2>
              {memory.error ? (
                <ErrorState compact error={memory.error} />
              ) : memory.isPending ? (
                <LoadingState compact />
              ) : (
                <pre className={styles.memory}>{memory.data.memory}</pre>
              )}
            </section>
          ) : null}
        </>
      ) : null}
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>{t('profile.activity')}</h2>
        <Timeline
          events={data.timeline}
          ctx={{ ...indexes, labels, myHandle, openInboxIds: new Set(data.inbox.map((i) => i.id)) }}
        />
      </section>
      <section className={styles.panel}>
        <h2 className={styles.panelTitle}>{t('profile.thread')}</h2>
        {messages.error ? (
          <ErrorState compact error={messages.error} />
        ) : messages.isPending ? (
          <LoadingState compact />
        ) : (
          <MessageList
            messages={thread}
            members={indexes.members}
            myHandle={myHandle}
            projectKey={key}
            taskTitles={titles}
            onReply={canSend ? setReply : undefined}
            onRead={(id) => read.mutate(id)}
            readPending={read.isPending}
          />
        )}
        {read.error ? <ErrorBanner>{errorMessage(read.error)}</ErrorBanner> : null}
        <MessageComposer
          key={`${handle}:${reply?.id ?? ''}`}
          initialTo={reply ? [...new Set([reply.from, ...reply.to])].filter((h) => h !== myHandle) : [handle]}
          initialTask={reply?.taskKey ?? ''}
          onSent={() => setReply(null)}
        />
      </section>
      <InviteDialog open={inviting} member={member} onClose={() => setInviting(false)} />
      <EditMemberDialog
        member={editing ? member : null}
        config={config.data?.config}
        roles={roles.data?.roles ?? []}
        onClose={() => setEditing(false)}
      />
      <RetireDialog
        member={retiring ? member : null}
        candidates={(board.data?.members ?? []).filter((m) => m.kind === 'ai' && m.handle !== handle)}
        onClose={() => setRetiring(false)}
      />
      <Dialog
        open={removing}
        title={t('profile.remove')}
        onClose={() => setRemoving(false)}
        size="sm"
        error={remove.error ? <ErrorBanner>{errorMessage(remove.error)}</ErrorBanner> : null}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setRemoving(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              size="md"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(handle, {
                  onSuccess: () => {
                    toast.show(t('profile.removed', { name: member.displayName }));
                    void navigate(`/p/${key}/team`);
                  },
                })
              }
            >
              {t('profile.remove')}
            </Button>
          </>
        }
      >
        <p>{t('profile.removeConfirm', { name: member.displayName })}</p>
      </Dialog>
    </div>
  );
}
