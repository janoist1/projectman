import clsx from 'clsx';
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isUnreadBy } from '@projectman/shared';
import type {
  ProjectManagerCorner,
  ProjectManagerRequestView,
  ProjectManagerSignal,
  TeamMessage,
  MessageAttachmentRef,
  UiLocation,
} from '@projectman/shared';
import { MessageAttachments } from '../messages/MessageAttachments';
import { Icon } from '../../components/Icon';
import { useIsMobile } from '../../lib/hooks';
import { useBoard, useConversation } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Markdown } from '../../components/Markdown';
import { ErrorState } from '../../components/States';
import { Avatar } from '../../components/Avatar';
import { formatDayHeading, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { layoutThread, threadItems } from '../messages/conversations';
import type { ThreadEntry } from '../messages/conversations';
import { STICK_PX } from '../messages/ConversationThread';
import { useReadWhenVisible } from '../messages/useReadWhenVisible';
import { ProcessingLines } from '../messages/ProcessingLines';
import { TaskChip } from '../messages/TaskChip';
import { ProjectManagerPlaces } from './ProjectManagerPlaces';
import { ProjectManagerSignalCard } from './ProjectManagerSignalCard';
import { ProjectManagerSignalList } from './ProjectManagerSignalList';
import { ProjectManagerSignalGroup } from './ProjectManagerSignalGroup';
import { ProjectManagerSteps } from './ProjectManagerSteps';
import styles from './ProjectManagerThread.module.css';

/** A message that did not go out: the text stays visible so it can be sent again. */
export interface FailedProjectManagerMessage {
  text: string;
  taskKey: string | null;
  attachments?: MessageAttachmentRef[];
  /** Where the writer was when they sent it: a retry says the same, not where they are now. */
  location?: UiLocation;
  /** The id the first attempt was sent with: a retry reuses it, so the server keeps one message (PM-1305). */
  clientRequestId?: string;
}

type ProjectManagerEntry =
  | { type: 'message'; id: string; at: string; day: string | null; entry: ThreadEntry }
  | { type: 'signals'; id: string; at: string; day: string | null; signals: ProjectManagerSignal[] };

/** Keep signal runs within a calendar day and break message runs around them. */
function projectManagerEntries(
  messages: TeamMessage[],
  signals: ProjectManagerSignal[],
): ProjectManagerEntry[] {
  const items: ProjectManagerEntry[] = [
    ...layoutThread(threadItems(messages, [], []), null).map((entry): ProjectManagerEntry => ({
      type: 'message',
      id: entry.item.id,
      at: entry.item.at,
      day: null,
      entry,
    })),
    ...signals.map((signal): ProjectManagerEntry => ({
      type: 'signals',
      id: signal.id,
      at: signal.raisedAt,
      day: null,
      signals: [signal],
    })),
  ];
  items.sort(
    (a, b) =>
      new Date(a.at).getTime() - new Date(b.at).getTime() ||
      Number(a.type === 'signals') - Number(b.type === 'signals') ||
      a.id.localeCompare(b.id),
  );
  const result: ProjectManagerEntry[] = [];
  let lastDay = '';
  for (const item of items) {
    const day = new Date(item.at).toDateString();
    const previous = result.at(-1);
    if (item.type === 'signals' && previous?.type === 'signals' && day === lastDay) {
      previous.signals.push(...item.signals);
      continue;
    }
    item.day = day !== lastDay ? formatDayHeading(item.at) : null;
    if (item.type === 'message')
      item.entry = {
        ...item.entry,
        day: item.day,
        firstOfRun: item.entry.firstOfRun || previous?.type === 'signals' || day !== lastDay,
      };
    result.push(item);
    lastDay = day;
  }
  return result;
}

/**
 * Where each request's steps go: under the Operator's last message of the request, else under the owner's message
 * that opened it, else (an answer, or a message past the page limit) at the end of the thread.
 */
function stepAnchors(
  requests: readonly ProjectManagerRequestView[],
  messages: readonly TeamMessage[],
): { byMessage: Map<string, ProjectManagerRequestView[]>; trailing: ProjectManagerRequestView[] } {
  const byMessage = new Map<string, ProjectManagerRequestView[]>();
  const trailing: ProjectManagerRequestView[] = [];
  const ids = new Set(messages.map((message) => message.id));
  for (const request of requests) {
    if (request.steps.length === 0) continue;
    const reply = messages.findLast((message) => message.operatorRequest === request.id);
    const anchor = reply?.id ?? (request.messageId && ids.has(request.messageId) ? request.messageId : null);
    if (!anchor) trailing.push(request);
    else byMessage.set(anchor, [...(byMessage.get(anchor) ?? []), request]);
  }
  return { byMessage, trailing };
}

/** The viewer's conversation with the Operator: bubbles, day separators, steps and signal cards (PM-429, PM-447). */
export function ProjectManagerThread({
  handle,
  channel,
  failed,
  retrying = false,
  onRetry,
  onExample,
}: {
  handle: string;
  channel: ProjectManagerCorner;
  failed: FailedProjectManagerMessage | null;
  /** The failed message is being sent again. */
  retrying?: boolean;
  onRetry: () => void;
  /** An example of the introduction was picked: it goes into the message box. */
  onExample: (text: string) => void;
}) {
  const { key, myHandle, projectManagerScroll } = useProject();
  const isMobile = useIsMobile();
  const { members } = useProjectIndexes(key);
  const board = useBoard(key);
  const conversation = useConversation(key, handle);
  // The project manager's replies are read when they have been on the screen (PM-1386), not when the panel opens.
  const watchUnread = useReadWhenVisible(key);
  const member = members.get(handle);
  const readOnly = channel.readOnly;

  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );
  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);
  const anchors = useMemo(() => stepAnchors(channel.requests, messages), [channel.requests, messages]);
  const signalByMessage = useMemo(() => {
    const map = new Map<string, ProjectManagerSignal[]>();
    for (const signal of channel.signals)
      if (signal.messageId) map.set(signal.messageId, [...(map.get(signal.messageId) ?? []), signal]);
    return map;
  }, [channel.signals]);
  // Only decisions made in this mounted thread retain feedback without a presenting message.
  const [dismissedHere, setDismissedHere] = useState<ReadonlySet<string>>(() => new Set());
  const unanchoredSignals = channel.signals.filter(
    (signal) =>
      (signal.state === 'open' || dismissedHere.has(signal.id)) &&
      (!signal.messageId || !messages.some((message) => message.id === signal.messageId)),
  );
  const entries = projectManagerEntries(messages, unanchoredSignals);
  const retainSignal = (id: string) =>
    setDismissedHere((previous) => (previous.has(id) ? previous : new Set([...previous, id])));

  // The thread opens at its end and follows new messages while the reader is near the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The panel is drawn again whenever it opens (a phone closes it with every page change): the place the reader
  // had scrolled to is kept above it and found again once, when the messages are there (PM-1305).
  const restored = useRef(false);
  const measureStick = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
    projectManagerScroll.current = { top: box.scrollTop, stick: stick.current };
  }, [projectManagerScroll]);
  const ready = Boolean(conversation.data);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !ready) return;
    if (!restored.current) {
      restored.current = true;
      const saved = projectManagerScroll.current;
      if (saved && !saved.stick) {
        stick.current = false;
        box.scrollTop = saved.top;
        return;
      }
    }
    if (stick.current) box.scrollTop = box.scrollHeight;
  }, [entries.length, ready, failed, channel.state, channel.requests, channel.signals, projectManagerScroll]);

  if (conversation.isPending) {
    return (
      <div className={styles.skeleton} role="status" aria-label={t('app.loading')}>
        <span className={styles.skeletonLeft} />
        <span className={styles.skeletonRight} />
        <span className={styles.skeletonLeft} />
      </div>
    );
  }
  if (conversation.isError) {
    return <ErrorState error={conversation.error} onRetry={() => void conversation.refetch()} compact />;
  }

  // Only this project's keys are cards; words like GPT-5 or SHA-256 stay plain text.
  const cardKey = (taskKey: string) =>
    taskKey.startsWith(`${key}-`) ? (
      <TaskChip projectKey={key} taskKey={taskKey} title={titles.get(taskKey)} />
    ) : (
      taskKey
    );

  const renderEntry = (entry: ThreadEntry) => {
    const { item } = entry;
    if (item.type !== 'message') return null;
    const { message } = item;
    const mine = message.from === myHandle;
    const signal = signalByMessage.get(message.id);
    const steps = anchors.byMessage.get(message.id) ?? [];
    // The label at the start of the content: the message counts as read once it has been on the screen (PM-1386).
    const unreadMark =
      message.from === handle && isUnreadBy(message, myHandle) ? (
        <span className={styles.unreadMark} ref={watchUnread(message.id)}>
          {t('messages.thread.unread')}
        </span>
      ) : null;
    return (
      <div key={message.id} className={styles.entry}>
        {entry.day ? (
          <div className={styles.day} role="separator">
            {entry.day}
          </div>
        ) : null}
        {signal && signal.length > 1 ? (
          <ProjectManagerSignalList
            signals={signal}
            message={message}
            projectManagerHandle={handle}
            readOnly={readOnly}
            unreadMark={unreadMark}
          />
        ) : signal?.[0] ? (
          <ProjectManagerSignalCard
            signal={signal[0]}
            message={message}
            projectManagerHandle={handle}
            readOnly={readOnly}
            unreadMark={unreadMark}
          />
        ) : (
          <div
            className={clsx(styles.message, mine ? styles.out : styles.in, entry.firstOfRun && styles.first)}
          >
            {mine ? null : (
              <span className={styles.avatarSlot}>
                {entry.firstOfRun ? <Avatar member={member} handle={handle} size="md" /> : null}
              </span>
            )}
            <div className={styles.col}>
              {unreadMark}
              {entry.showTask && message.taskKey ? cardKey(message.taskKey) : null}
              <div className={styles.bubble}>
                {message.body ? (
                  mine ? (
                    <Markdown text={message.body} />
                  ) : (
                    <Markdown text={message.body} cardKey={cardKey} />
                  )
                ) : null}
                <MessageAttachments files={message.attachments ?? []} from={message.from} />
              </div>
              {!mine && message.places?.length ? <ProjectManagerPlaces places={message.places} /> : null}
              <div className={styles.meta}>
                {message.relayed ? <span>{t('pm.relayed')}</span> : null}
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              </div>
              {/* The panel is the talk with this member: a forwarded message's other recipients are not shown here. */}
              {mine && message.processing?.some((item) => item.handle === handle) ? (
                <ProcessingLines
                  items={message.processing.filter((item) => item.handle === handle)}
                  members={members}
                  myHandle={myHandle}
                  className={styles.processing}
                />
              ) : null}
            </div>
          </div>
        )}
        {steps.map((request) => (
          <div key={request.id} className={styles.extra}>
            <ProjectManagerSteps request={request} titles={titles} />
          </div>
        ))}
      </div>
    );
  };

  const empty = entries.length === 0 && !failed && anchors.trailing.length === 0;
  const examples = readOnly ? (['status', 'mine'] as const) : (['status', 'why', 'writer'] as const);

  return (
    <div
      ref={scroller}
      className={styles.thread}
      role="log"
      aria-live="polite"
      aria-label={t('operator.thread.label')}
      onScroll={measureStick}
    >
      {empty ? (
        <div className={styles.intro}>
          <h3 className={styles.introTitle}>{t('operator.intro.title')}</h3>
          {readOnly ? (
            <>
              <p className={styles.introBody}>{t('operator.intro.other.lead')}</p>
              <p className={styles.introBody}>{t('operator.intro.other.readOnly')}</p>
            </>
          ) : (
            <>
              <p className={styles.introBody}>{t('operator.intro.lead')}</p>
              <ul className={styles.introPoints}>
                <li>{t('operator.intro.points.card')}</li>
                <li>{t('operator.intro.points.members')}</li>
                <li>{t('operator.intro.points.state')}</li>
              </ul>
              <p className={styles.introBody}>{t('operator.intro.approval')}</p>
            </>
          )}
          <p className={clsx(styles.introBody, styles.introAttachment)}>
            {isMobile ? (
              <>
                {t('operator.intro.attachPhone', { icon: '|' }).split('|')[0]}
                <Icon name="paperclip" size={14} />
                <span className="visually-hidden">{t('messageAttachments.add')}</span>
                {t('operator.intro.attachPhone', { icon: '|' }).split('|')[1]}
              </>
            ) : (
              t(readOnly ? 'operator.intro.other.attach' : 'operator.intro.attach')
            )}
          </p>
          <div className={styles.examples} role="group" aria-label={t('operator.intro.examplesLabel')}>
            {examples.map((example) => (
              <button
                key={example}
                type="button"
                className={styles.example}
                onClick={() => onExample(t(`operator.intro.examples.${example}`))}
              >
                {t(`operator.intro.examples.${example}`)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        entries.map((entry) =>
          entry.type === 'message' ? (
            renderEntry(entry.entry)
          ) : (
            <div key={entry.id} className={styles.entry}>
              {entry.day ? (
                <div className={styles.day} role="separator">
                  {entry.day}
                </div>
              ) : null}
              {entry.signals.length > 1 ? (
                <ProjectManagerSignalGroup
                  onResize={measureStick}
                  signals={entry.signals}
                  projectManagerHandle={handle}
                  readOnly={readOnly}
                  onDismiss={retainSignal}
                />
              ) : (
                <ProjectManagerSignalCard
                  signal={entry.signals[0]!}
                  message={null}
                  projectManagerHandle={handle}
                  readOnly={readOnly}
                  onDismiss={retainSignal}
                />
              )}
            </div>
          ),
        )
      )}
      {anchors.trailing.map((request) => (
        <div key={request.id} className={styles.extra}>
          <ProjectManagerSteps request={request} titles={titles} />
        </div>
      ))}
      {failed ? (
        <div className={clsx(styles.entry, styles.failed)}>
          <div className={clsx(styles.message, styles.out, styles.first)}>
            <div className={styles.col}>
              {failed.taskKey ? cardKey(failed.taskKey) : null}
              <div className={clsx(styles.bubble, styles.failedBubble)}>
                {failed.text ? <Markdown text={failed.text} /> : null}
                <MessageAttachments files={failed.attachments ?? []} from={myHandle ?? ''} sent={false} />
              </div>
              <div className={styles.meta}>
                <span className={styles.failedText} role="alert">
                  {t('operator.sent.failed')}
                </span>
                <Button size="sm" variant="ghost" loading={retrying} onClick={onRetry}>
                  {t(retrying ? 'operator.sent.retrying' : 'operator.sent.retry')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
