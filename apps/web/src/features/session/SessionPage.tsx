import clsx from 'clsx';
import { Suspense, lazy, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useParams, useSearchParams } from 'react-router';
import type { SessionDetail } from '@projectman/shared';
import {
  useBoard,
  useInbox,
  useLabels,
  useResolveInbox,
  useSchedules,
  useSendSessionMessage,
  useSessionDetail,
  useTaskDetail,
} from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { ErrorState, LoadingState } from '../../components/States';
import { Timeline } from '../../components/Timeline';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import { useDocumentTitle, useIsMobile, useMediaQuery } from '../../lib/hooks';
import { openItemIds, openItemsFor } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import { isLiveSession } from '../../lib/sessions';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import { nextStepText } from '../board/taskModel';
import { ChatView } from './ChatView';
import { Composer } from './Composer';
import { participantsFor } from './participants';
import { SessionHeader } from './SessionHeader';
import { liveState, sessionTitle } from './sessionModel';
import { ParticipantsPanel, PrPanel, SessionDetailsPanel, UsagePanel } from './SessionPanels';
import styles from './SessionPage.module.css';
import { usePendingEchoes } from './usePendingEchoes';

const TerminalView = lazy(() => import('./TerminalView'));

type Tab = 'chat' | 'terminal' | 'timeline' | 'details';

const tabLabels: Record<Tab, PlainMessageKey> = {
  chat: 'session.tabs.chat',
  terminal: 'session.tabs.terminal',
  timeline: 'session.tabs.timeline',
  details: 'session.tabs.details',
};

function SessionView({ detail }: { detail: SessionDetail }) {
  const { key, myHandle } = useProject();
  const labels = useLabels(key);
  const [params] = useSearchParams();
  const isMobile = useIsMobile();
  const wide = useMediaQuery('(min-width: 1200px)');
  const { session, chat } = detail;
  const task = detail.task;
  const schedules = useSchedules(key, session.workItem.type === 'schedule');
  const scheduleRun =
    session.workItem.type === 'schedule'
      ? schedules.data?.runs.find((run) => run.sessionId === session.id)
      : undefined;
  const taskDetail = useTaskDetail(key, task?.key);
  const boardTasks = useBoard(key).data?.tasks;
  const inbox = useInbox(key);
  const { members, pipeline } = useProjectIndexes(key);
  const resolve = useResolveInbox(key, myHandle);
  const send = useSendSessionMessage(key, session.id);
  const toast = useToast();
  const echoes = usePendingEchoes(chat);
  const [tab, setTab] = useState<Tab>('chat');
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const memberName = nameOf(session.member, members, myHandle);
  const title = sessionTitle(session, task, memberName, {
    scheduledFor: scheduleRun?.scheduledFor,
    timezone: schedules.data?.timezone,
  });
  useDocumentTitle(title);

  const items = inbox.data?.items;
  const sessionItems = useMemo(
    () => (items ?? []).filter((item) => item.sessionId === session.id),
    [items, session.id],
  );
  const openItems = openItemsFor(sessionItems, myHandle);
  const resolvedPermissions = sessionItems.filter(
    (item) => item.kind === 'permission' && item.state !== 'open' && item.resolution,
  );
  const openIds = useMemo(() => openItemIds(items), [items]);

  // The latest events and "what comes next" matter most: start the timeline at the bottom.
  const timelineLength = taskDetail.data?.timeline.length ?? 0;
  useLayoutEffect(() => {
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [timelineLength]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [chat.length, echoes.pending.length, openItems.length, tab]);

  const running = isLiveSession(session);
  const live = liveState(
    session,
    openItems.some((item) => item.kind === 'permission'),
  );

  const taskState =
    task && pipeline
      ? deriveTaskState(task, {
          pipeline,
          members,
          openInboxByTask: groupOpenInboxByTask(items),
          // Prerequisites are other tasks: look them up on the board.
          tasksByKey: new Map([
            ...(boardTasks ?? []).map((entry) => [entry.key, entry] as const),
            [task.key, task],
          ]),
          myHandle,
          labels,
        })
      : null;
  const timeline = taskDetail.data?.timeline ?? [];
  const participants = participantsFor(session, task, timeline, pipeline, members, myHandle, labels);

  const tabs: Tab[] = isMobile
    ? ['chat', 'terminal', 'timeline', 'details']
    : wide
      ? ['chat', 'terminal']
      : ['chat', 'terminal', 'details'];
  const activeTab = tabs.includes(tab) ? tab : 'chat';

  const sendEcho = (id: string, text: string) => {
    stickToBottom.current = true;
    send.mutate(text, { onError: () => echoes.fail(id) });
  };
  const onSend = (text: string) => sendEcho(echoes.add(text), text);
  const onRetry = (id: string) => {
    const message = echoes.pending.find((entry) => entry.id === id);
    if (!message) return;
    echoes.retry(id);
    sendEcho(id, message.text);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, current: Tab) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const index = tabs.indexOf(current);
    const next = tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]!;
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  const timelinePanel = task ? (
    <Timeline
      events={timeline}
      ctx={{ pipeline, members, labels, myHandle, openInboxIds: openIds }}
      next={pipeline ? nextStepText(task, pipeline, members, myHandle) : null}
    />
  ) : (
    <p className={styles.muted}>{t('task.timelineEmpty')}</p>
  );

  const member = members.get(session.member);
  const sidePanels = (
    <>
      <PrPanel
        task={task}
        session={session}
        pullRequests={taskDetail.data?.pullRequests ?? []}
        labels={labels}
      />
      <SessionDetailsPanel session={session} member={member} />
      <ParticipantsPanel participants={participants} members={members} myHandle={myHandle} />
      <UsagePanel session={session} provider={session.provider ?? member?.provider} />
    </>
  );

  const chatPanel = (
    <>
      <div
        className={styles.chatScroll}
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }}
      >
        <ChatView
          items={chat}
          sessionMember={session.member}
          members={members}
          myHandle={myHandle}
          pipeline={pipeline}
          openItems={openItems}
          resolvedItems={resolvedPermissions}
          pending={echoes.pending}
          onRetry={onRetry}
          awaitingPermission={session.state === 'waiting_permission'}
          resolvingId={resolve.isPending ? (resolve.variables?.item.id ?? null) : null}
          onResolve={(item, body) =>
            resolve.mutate({ item, body }, { onError: () => toast.show(t('inbox.resolveFailed'), 'error') })
          }
        />
      </div>
      <Composer onSend={onSend} autoFocus={params.get('compose') === '1'} />
    </>
  );

  return (
    <div className={styles.page}>
      <SessionHeader
        session={session}
        task={task}
        title={title}
        memberName={memberName}
        member={member}
        pipeline={pipeline}
        taskPhase={taskState?.phase ?? null}
        live={live}
      />

      <div className={styles.body}>
        {!isMobile && task ? (
          <aside className={styles.timelineAside} aria-labelledby="session-timeline">
            <h2 id="session-timeline" className={styles.asideTitle}>
              {t('timeline.label')}
            </h2>
            <div className={styles.asideScroll} ref={timelineRef}>
              {timelinePanel}
            </div>
          </aside>
        ) : null}

        <section className={styles.center} aria-label={title}>
          <div className={styles.tabs} role="tablist" aria-label={t('session.tabs.label')}>
            {tabs.map((entry) => (
              <button
                key={entry}
                ref={(element) => {
                  tabRefs.current[entry] = element;
                }}
                type="button"
                role="tab"
                id={`tab-${entry}`}
                aria-selected={activeTab === entry}
                aria-controls={`panel-${entry}`}
                tabIndex={activeTab === entry ? 0 : -1}
                className={clsx(styles.tab, activeTab === entry && styles.tabActive)}
                onClick={() => setTab(entry)}
                onKeyDown={(event) => onTabKey(event, entry)}
              >
                {t(tabLabels[entry])}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`panel-${activeTab}`}
            aria-labelledby={`tab-${activeTab}`}
            className={styles.panel}
          >
            {activeTab === 'chat' ? chatPanel : null}
            {activeTab === 'terminal' ? (
              running ? (
                <Suspense fallback={<LoadingState />}>
                  <TerminalView sessionId={session.id} />
                </Suspense>
              ) : (
                <p className={styles.notRunning}>{t('session.terminal.notRunning')}</p>
              )
            ) : null}
            {activeTab === 'timeline' ? <div className={styles.panelScroll}>{timelinePanel}</div> : null}
            {activeTab === 'details' ? (
              <div className={clsx(styles.panelScroll, styles.detailsStack)}>{sidePanels}</div>
            ) : null}
          </div>
        </section>

        {wide && !isMobile ? <aside className={styles.side}>{sidePanels}</aside> : null}
      </div>
    </div>
  );
}

/** A member's session: chat, real terminal, the task's timeline and PR. */
export function SessionPage() {
  const { sessionId = '' } = useParams();
  const { key } = useProject();
  const detail = useSessionDetail(key, sessionId);
  if (detail.isPending) return <LoadingState />;
  if (detail.isError) return <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />;
  return <SessionView detail={detail.data} />;
}
