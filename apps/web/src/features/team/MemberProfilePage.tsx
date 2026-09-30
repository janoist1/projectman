import { InviteDialog } from './InviteDialog';
import { useState } from 'react';
import { providerModelLabel } from './providerModels';
import { Link, useNavigate, useParams } from 'react-router';
import type { TeamMessage } from '@projectman/shared';
import {
  useBoard,
  useConfig,
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
import { useSchedules } from '../../api/schedules';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { PlanUsageMeter } from '../../app/PlanUsageMeter';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ProviderBadge } from '../../components/ProviderBadge';
import { Timeline } from '../../components/Timeline';
import { ErrorState, LoadingState } from '../../components/States';
import { t } from '../../i18n/t';
import { formatStamp } from '../../i18n/format';
import { errorMessage } from '../../lib/errors';
import { memberStatusView } from '../../lib/members';
import { aiRoleView, humanRoleName } from '../../lib/roles';
import { useDocumentTitle } from '../../lib/hooks';
import { MessageComposer } from '../messages/MessageComposer';
import { MessageList } from '../messages/MessageList';
import { ChatView } from '../session/ChatView';
import { EditMemberDialog } from './EditMemberDialog';
import { RetireDialog } from './RetireDialog';
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

function MemberSchedule({ handle }: { handle: string }) {
  const { key } = useProject();
  const schedules = useSchedules(key);
  const schedule = schedules.data?.members.find((m) => m.member === handle);
  if (schedules.error) return <ErrorState compact error={schedules.error} />;
  return (
    <section className={styles.panel}>
      <h2>{t('schedule.title')}</h2>
      {schedule ? (
        <>
          <code>{schedule.cron}</code>
          <p>{schedule.promptSummary}</p>
        </>
      ) : (
        <p>{t('schedules.noNext')}</p>
      )}
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
  const [inviting, setInviting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [retiring, setRetiring] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [reply, setReply] = useState<TeamMessage | null>(null);
  const access = me.projects.find((p) => p.key === key)?.access;
  const internal = access !== 'client';
  const canSend = access !== undefined && ['owner', 'admin', 'developer', 'client'].includes(access);
  const memory = useMemberMemories(key, handle, internal && profile.data?.member.kind === 'ai');
  useDocumentTitle(profile.data?.member.displayName ?? t('profile.title'), board.data?.project.name);
  if (profile.error) return <ErrorState error={profile.error} onRetry={() => void profile.refetch()} />;
  if (!profile.data) return <LoadingState />;
  const data = profile.data;
  const member = data.member;
  const ai = member.kind === 'ai';
  const status = memberStatusView(member, data.inbox, myHandle);
  const live = data.sessions.filter((s) => !['exited', 'failed'].includes(s.state));
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
      <header className={styles.header}>
        <Avatar member={member} size="lg" status={status.status} />
        <div>
          <h1>{member.displayName}</h1>
          <code>{member.handle}</code>
          <p>
            {status.label}
            {member.activity ? ` · ${member.activity}` : ''}
          </p>
        </div>
        <div className={styles.actions}>
          {can.manageTeam ? (
            <Button disabled={!roles.data || (ai && !config.data)} onClick={() => setEditing(true)}>
              {t('memberEdit.edit')}
            </Button>
          ) : null}
          {!ai && can.manageTeam && member.status === 'no_account' ? (
            <Button onClick={() => setInviting(true)}>{t('invites.create')}</Button>
          ) : null}
          {ai && can.manageTeam ? (
            <Button onClick={() => setRetiring(true)}>{t('team.retire')}</Button>
          ) : null}
          {!ai && can.manageTeam && member.handle !== myHandle ? (
            <Button variant="danger" onClick={() => setRemoving(true)}>
              {t('profile.remove')}
            </Button>
          ) : null}
          {ai && can.workInSessions ? (
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
        </div>
      </header>
      {start.error ? <p role="alert">{errorMessage(start.error)}</p> : null}
      <section className={styles.panel}>
        {!ai ? (
          <p>
            {t('invites.access')}: {humanRoleName(member.role)}
          </p>
        ) : (
          <>
            <ProviderBadge provider={member.provider} />
            <p>
              {member.model
                ? providerModelLabel(member.provider ?? 'claude', member.model)
                : t('common.dash')}{' '}
              ·{' '}
              {member.effort
                ? t(`providerSettings.efforts.${member.effort}`)
                : member.provider === 'codex'
                  ? t('providerSettings.efforts.medium')
                  : t('providerSettings.defaultEffort')}
            </p>
            <p>{t('profile.capacity', { used: data.capacityUsed, max: data.capacity ?? 0 })}</p>
            <PlanUsageMeter
              provider={member.provider ?? 'claude'}
              usage={board.data?.planUsageByProvider[member.provider ?? 'claude']}
              pauseAbove={config.data?.config.team.limits.pauseAbovePlanUsagePercent}
            />
          </>
        )}
        <p>
          {member.roles.map((role) => aiRoleView(role, member.specialty, roles.data?.roles).name).join(' · ')}
        </p>
        <h2>{t('profile.duties')}</h2>
        <ul>
          {data.duties.map((duty) => (
            <li key={duty}>{t(`dutyNames.${duty}`)}</li>
          ))}
        </ul>
        {data.email ? (
          <p>
            {t('profile.email')}: <a href={`mailto:${data.email}`}>{data.email}</a>
          </p>
        ) : null}
      </section>
      <div className={styles.grid}>
        <section className={styles.panel}>
          <h2>{t('profile.tasks')}</h2>
          {data.tasks.length ? (
            <ul>
              {data.tasks.map((task) => (
                <li key={task.key}>
                  <Link to={`/p/${key}/tasks/${task.key}`}>
                    {task.key} · {task.title}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p>{t('profile.noTasks')}</p>
          )}
        </section>
        {!ai ? (
          <section className={styles.panel}>
            <h2>{t('profile.waiting')}</h2>
            {data.inbox.length ? (
              <ul>
                {data.inbox.map((item) => (
                  <li key={item.id}>
                    <Link to={`/p/${key}/inbox`}>{item.title}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p>{t('profile.noWaiting')}</p>
            )}
          </section>
        ) : null}
        {ai && internal ? <MemberSchedule handle={handle} /> : null}
      </div>
      {ai && internal ? (
        <>
          <section className={styles.panel}>
            <h2>{t('profile.live')}</h2>
            {live.map((session) => (
              <div key={session.id}>
                <Link to={`/p/${key}/sessions/${session.id}`}>
                  {t('profile.openSession')} ·{' '}
                  {session.workItem.type === 'task' ? session.workItem.taskKey : t('profile.general')}
                </Link>
                <SessionPeek sessionId={session.id} />
              </div>
            ))}
            {!live.length ? <p>{t('profile.noSessions')}</p> : null}
            <h2>{t('profile.sessions')}</h2>
            <ul>
              {data.sessions
                .filter((s) => !live.includes(s))
                .slice(0, 10)
                .map((session) => (
                  <li key={session.id}>
                    <Link to={`/p/${key}/sessions/${session.id}`}>
                      {session.workItem.type === 'task' ? session.workItem.taskKey : t('profile.general')} ·{' '}
                      {formatStamp(session.startedAt)}
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
          <section className={styles.panel}>
            <h2>{t('profile.memory')}</h2>
            {memory.error ? (
              <ErrorState compact error={memory.error} />
            ) : memory.isPending ? (
              <LoadingState compact />
            ) : (
              <pre className={styles.memory}>{memory.data.memory || t('profile.memoryEmpty')}</pre>
            )}
          </section>
        </>
      ) : null}
      <section className={styles.panel}>
        <h2>{t('profile.activity')}</h2>
        <Timeline
          events={data.timeline}
          ctx={{ ...indexes, labels, myHandle, openInboxIds: new Set(data.inbox.map((i) => i.id)) }}
        />
      </section>
      <section className={styles.panel}>
        <h2>{t('profile.thread')}</h2>
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
        {read.error ? <p role="alert">{errorMessage(read.error)}</p> : null}
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
      <Dialog open={removing} title={t('profile.remove')} onClose={() => setRemoving(false)}>
        <p>{t('profile.removeConfirm', { name: member.displayName })}</p>
        {remove.error ? <p role="alert">{errorMessage(remove.error)}</p> : null}
        <Button
          variant="danger"
          loading={remove.isPending}
          onClick={() =>
            remove.mutate(handle, {
              onSuccess: () => {
                void navigate(`/p/${key}/team`);
              },
            })
          }
        >
          {t('profile.remove')}
        </Button>
      </Dialog>
    </div>
  );
}
