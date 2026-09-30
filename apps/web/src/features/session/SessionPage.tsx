import clsx from 'clsx';
import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { SessionDetail } from '@projectman/shared';
import {
  useBoard,
  useInbox,
  useLabels,
  useResolveInbox,
  useSchedules,
  useSendSessionMessage,
  useSessionDetail,
  useStopSession,
  useTaskDetail,
} from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip, StatusDot } from '../../components/Chip';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { StageProgress } from '../../components/StageProgress';
import { ErrorState, LoadingState } from '../../components/States';
import { Timeline } from '../../components/Timeline';
import { useToast } from '../../components/toastContext';
import { ProviderBadge } from '../../components/ProviderBadge';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import { useDocumentTitle, useIsMobile, useMediaQuery } from '../../lib/hooks';
import { formatScheduleTime } from '../../lib/schedules';
import { openItemIds, openItemsFor } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import { isLiveSession, sessionStatus } from '../../lib/sessions';
import { stagePosition } from '../../lib/pipeline';
import { deriveTaskState, groupOpenInboxByTask } from '../../lib/taskState';
import { prChip } from '../board/cardModel';
import { nextStepText } from '../board/taskModel';
import { ChatView } from './ChatView';
import type { PendingMessage } from './ChatView';
import { Composer } from './Composer';
import { participantsFor } from './participants';
import { ParticipantsPanel, PrPanel } from './SessionPanels';
import styles from './SessionPage.module.css';

const TerminalView = lazy(() => import('./TerminalView'));

type Tab = 'chat' | 'terminal' | 'timeline' | 'details';

const tabLabels: Record<Tab, PlainMessageKey> = {
  chat: 'session.tabs.chat',
  terminal: 'session.tabs.terminal',
  timeline: 'session.tabs.timeline',
  details: 'session.tabs.details',
};

function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

let pendingSeq = 0;

/** How far the server's transcript clock may lag behind the browser's. */
const ECHO_SKEW_MS = 2 * 60_000;

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
  const stop = useStopSession(key);
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('chat');
  const [pending, setPending] = useState<Array<PendingMessage & { sentAt: string }>>([]);
  const [confirmStop, setConfirmStop] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

  const memberName = nameOf(session.member, members, myHandle);
  const title = task
    ? task.title
    : session.workItem.type === 'schedule'
      ? t('schedules.session', {
          time: formatScheduleTime(
            scheduleRun?.scheduledFor ?? session.startedAt,
            schedules.data?.timezone ?? 'UTC',
          ),
        })
      : session.workItem.type === 'general'
        ? t('session.general', { member: memberName })
        : t('session.meeting', { member: memberName });
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

  // Drop local echoes once the transcript shows the message (allowing for clock skew).
  useEffect(() => {
    setPending((list) =>
      list.filter(
        (message) =>
          !chat.some(
            (item) =>
              item.kind === 'user_text' &&
              item.origin === 'human' &&
              item.text.trim() === message.text.trim() &&
              Date.parse(item.ts) >= Date.parse(message.sentAt) - ECHO_SKEW_MS,
          ),
      ),
    );
  }, [chat]);

  // The latest events and "what comes next" matter most: start the timeline at the bottom.
  const timelineLength = taskDetail.data?.timeline.length ?? 0;
  useLayoutEffect(() => {
    const element = timelineRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [timelineLength]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [chat.length, pending.length, openItems.length, tab]);

  const memberConfig = members.get(session.member);
  const running = isLiveSession(session);
  const needsMe = openItems.some((item) => item.kind === 'permission');
  const liveStatus = sessionStatus(session, needsMe);
  const liveLabel = needsMe ? t('sessionState.needsYou') : t(`sessionState.${session.state}`);

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
  const stage = task && pipeline ? pipeline.stageById.get(task.stageId) : undefined;
  const column = task && pipeline ? pipeline.columnOfStage.get(task.stageId) : undefined;
  const pr = task ? prChip(task) : null;
  const timeline = taskDetail.data?.timeline ?? [];
  const participants = participantsFor(session, task, timeline, pipeline, members, myHandle, labels);

  const tabs: Tab[] = isMobile
    ? ['chat', 'terminal', 'timeline', 'details']
    : wide
      ? ['chat', 'terminal']
      : ['chat', 'terminal', 'details'];
  const activeTab = tabs.includes(tab) ? tab : 'chat';

  const onSend = (text: string) => {
    const entry = { id: `local-${(pendingSeq += 1)}`, text, failed: false, sentAt: new Date().toISOString() };
    setPending((list) => [...list, entry]);
    stickToBottom.current = true;
    send.mutate(text, {
      onError: () =>
        setPending((list) =>
          list.map((message) => (message.id === entry.id ? { ...message, failed: true } : message)),
        ),
    });
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

  const sidePanels = (
    <>
      <PrPanel
        task={task}
        session={session}
        pullRequests={taskDetail.data?.pullRequests ?? []}
        labels={labels}
      />
      <ParticipantsPanel participants={participants} members={members} myHandle={myHandle} />
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
          pending={pending}
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
      <div className={styles.header}>
        <div className={styles.crumbRow}>
          <nav aria-label={t('session.breadcrumb')} className={styles.crumbs}>
            <Link to={`/p/${key}`} className={styles.crumbLink}>
              {t('nav.board')}
            </Link>
            <Icon name="chevronRight" size={14} strokeWidth={2} />
            {task ? (
              <Link to={`/p/${key}/tasks/${task.key}`} className={styles.crumbLink}>
                {column?.name ?? task.key}
              </Link>
            ) : (
              <span>{memberName}</span>
            )}
          </nav>
          <span className={styles.spacer} />
          <span className={styles.live} data-status={liveStatus} role="status">
            <StatusDot status={liveStatus} pulse={liveStatus === 'working'} size={9} />
            <span>{liveLabel}</span>
          </span>
          {running ? (
            <Button variant="ghost" size="sm" icon="stop" onClick={() => setConfirmStop(true)}>
              {t('session.stop')}
            </Button>
          ) : null}
        </div>
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.chips}>
          {task && pipeline && taskState ? (
            <span className={styles.stageChip}>
              <StageProgress
                pipeline={pipeline}
                stageId={task.stageId}
                phase={taskState.phase}
                variant="chip"
              />
              <span>
                {t('task.stageChip', {
                  stage: stage?.name ?? task.stageId,
                  index: stagePosition(pipeline, task.stageId).index,
                  total: stagePosition(pipeline, task.stageId).total,
                })}
              </span>
            </span>
          ) : null}
          {pr ? (
            <Chip tone="outline" size="md" icon={pr.merged ? 'prMerged' : 'prOpen'} className={styles.prChip}>
              {pr.label}
            </Chip>
          ) : null}
          {session.branch ? (
            <Chip tone="outline" size="md" mono title={t('session.chips.branch', { branch: session.branch })}>
              {session.branch}
            </Chip>
          ) : null}
          <Chip tone="outline" size="md" mono title={t('session.chips.cwd', { cwd: session.cwd })}>
            {shortPath(session.cwd)}
          </Chip>
          <ProviderBadge provider={memberConfig?.provider} />
          {memberConfig?.model ? (
            <Chip size="md">{t('session.chips.model', { model: memberConfig.model })}</Chip>
          ) : null}
          {memberConfig?.permissionMode ? (
            <Chip size="md">
              {t('session.chips.permissions', { mode: t(`permissionModes.${memberConfig.permissionMode}`) })}
            </Chip>
          ) : null}
        </div>
      </div>

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

      <Dialog
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title={t('session.stopTitle')}
        description={t('session.stopBody')}
        size="sm"
        footer={
          <>
            <Button
              variant="dangerSolid"
              icon="stop"
              loading={stop.isPending}
              onClick={() =>
                stop.mutate(session.id, {
                  onSuccess: () => {
                    toast.show(t('session.stopped'));
                    setConfirmStop(false);
                  },
                  onError: () => toast.show(t('errors.generic'), 'error'),
                })
              }
            >
              {t('session.stop')}
            </Button>
            <Button variant="secondary" onClick={() => setConfirmStop(false)}>
              {t('common.cancel')}
            </Button>
          </>
        }
      />
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
