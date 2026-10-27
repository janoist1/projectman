import clsx from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { OPERATOR_ROLE, isUnreadBy } from '@projectman/shared';
import type {
  ProjectManagerCorner,
  OperatorRequestView,
  OperatorSignal,
  TeamMessage,
  MessageAttachmentRef,
  UiLocation,
} from '@projectman/shared';
import { MessageAttachments } from '../messages/MessageAttachments';
import { Icon } from '../../components/Icon';
import { useIsMobile } from '../../lib/hooks';
import { useBoard, useConversation, useReadTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Markdown } from '../../components/Markdown';
import { ErrorState } from '../../components/States';
import { Avatar } from '../../components/Avatar';
import { formatDayHeading, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { layoutThread, threadItems } from '../messages/conversations';
import type { ThreadEntry } from '../messages/conversations';
import { READ_AFTER_MS, STICK_PX, useDocumentVisible } from '../messages/ConversationThread';
import { receiptsOf } from '../messages/receipts';
import { TaskChip } from '../messages/TaskChip';
import { operatorSentText, operatorWaitOf } from './operatorChannel';
import { OperatorPlaces } from './OperatorPlaces';
import { OperatorSignalCard } from './OperatorSignalCard';
import { OperatorSignalList } from './OperatorSignalList';
import { OperatorSignalGroup } from './OperatorSignalGroup';
import { OperatorSteps } from './OperatorSteps';
import styles from './OperatorThread.module.css';

/** A message that did not go out: the text stays visible so it can be sent again. */
export interface FailedOperatorMessage {
  text: string;
  taskKey: string | null;
  attachments?: MessageAttachmentRef[];
  /** Where the writer was when they sent it: a retry says the same, not where they are now. */
  location?: UiLocation;
}

type OperatorEntry =
  | { type: 'message'; id: string; at: string; day: string | null; entry: ThreadEntry }
  | { type: 'signals'; id: string; at: string; day: string | null; signals: OperatorSignal[] };

/** Keep signal runs within a calendar day and break message runs around them. */
function operatorEntries(messages: TeamMessage[], signals: OperatorSignal[]): OperatorEntry[] {
  const items: OperatorEntry[] = [
    ...layoutThread(threadItems(messages, [], []), null).map((entry): OperatorEntry => ({
      type: 'message',
      id: entry.item.id,
      at: entry.item.at,
      day: null,
      entry,
    })),
    ...signals.map((signal): OperatorEntry => ({
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
  const result: OperatorEntry[] = [];
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
  requests: readonly OperatorRequestView[],
  messages: readonly TeamMessage[],
): { byMessage: Map<string, OperatorRequestView[]>; trailing: OperatorRequestView[] } {
  const byMessage = new Map<string, OperatorRequestView[]>();
  const trailing: OperatorRequestView[] = [];
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
export function OperatorThread({
  handle,
  channel,
  failed,
  onRetry,
  onExample,
}: {
  handle: string;
  channel: ProjectManagerCorner;
  failed: FailedOperatorMessage | null;
  onRetry: () => void;
  /** An example of the introduction was picked: it goes into the message box. */
  onExample: (text: string) => void;
}) {
  const { key, myHandle, isOwner } = useProject();
  const isMobile = useIsMobile();
  const { members } = useProjectIndexes(key);
  const board = useBoard(key);
  const conversation = useConversation(key, handle);
  const readMessages = useReadTeamMessages(key);
  const visible = useDocumentVisible();
  const member = members.get(handle);
  const readOnly = channel.readOnly;

  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );
  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);
  const wait = operatorWaitOf(channel);
  const anchors = useMemo(() => stepAnchors(channel.requests, messages), [channel.requests, messages]);
  const signalByMessage = useMemo(() => {
    const map = new Map<string, OperatorSignal[]>();
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
  const entries = operatorEntries(messages, unanchoredSignals);
  const retainSignal = (id: string) =>
    setDismissedHere((previous) => (previous.has(id) ? previous : new Set([...previous, id])));
  // The earlier conversation with the Operator stays in the Messages (PM-1042); until it leaves the app (PM-1045).
  const operatorHandle = [...members.values()].find(
    (m) => m.kind === 'ai' && m.role === OPERATOR_ROLE,
  )?.handle;

  // Opening is reading: the project manager's unread replies, while the panel is visible.
  const unreadKey = messages
    .filter((m) => m.from === handle && isUnreadBy(m, myHandle))
    .map((m) => m.id)
    .join(',');
  const { mutate: markRead } = readMessages;
  useEffect(() => {
    if (!unreadKey || !visible) return;
    const timer = setTimeout(() => markRead(unreadKey.split(',')), READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreadKey, visible, markRead]);

  // The thread opens at its end and follows new messages while the reader is near the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const measureStick = useCallback(() => {
    const box = scroller.current;
    if (box) stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
  }, []);
  const ready = Boolean(conversation.data);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && ready && stick.current) box.scrollTop = box.scrollHeight;
  }, [entries.length, ready, failed, channel.state, channel.requests, channel.signals]);

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
    return (
      <div key={message.id} className={styles.entry}>
        {entry.day ? (
          <div className={styles.day} role="separator">
            {entry.day}
          </div>
        ) : null}
        {signal && signal.length > 1 ? (
          <OperatorSignalList
            signals={signal}
            message={message}
            operatorHandle={handle}
            readOnly={readOnly}
          />
        ) : signal?.[0] ? (
          <OperatorSignalCard
            signal={signal[0]}
            message={message}
            operatorHandle={handle}
            readOnly={readOnly}
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
              {!mine && message.places?.length ? <OperatorPlaces places={message.places} /> : null}
              <div className={styles.meta}>
                {message.relayed ? <span>{t('pm.relayed')}</span> : null}
                <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                {mine ? (
                  <span className={styles.sent}>{sentLine(message, handle, wait, members)}</span>
                ) : null}
              </div>
            </div>
          </div>
        )}
        {steps.map((request) => (
          <div key={request.id} className={styles.extra}>
            <OperatorSteps request={request} titles={titles} />
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
          {isOwner && operatorHandle ? (
            <p className={clsx(styles.introBody, styles.transition)}>
              {t('operator.intro.earlier')}{' '}
              <Link to={`/p/${key}/messages/with/${operatorHandle}`} className={styles.transitionLink}>
                {t('operator.intro.earlierLink')} →
              </Link>
            </p>
          ) : null}
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
                <OperatorSignalGroup
                  onResize={measureStick}
                  signals={entry.signals}
                  operatorHandle={handle}
                  readOnly={readOnly}
                  onDismiss={retainSignal}
                />
              ) : (
                <OperatorSignalCard
                  signal={entry.signals[0]!}
                  message={null}
                  operatorHandle={handle}
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
          <OperatorSteps request={request} titles={titles} />
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
                <Button size="sm" variant="ghost" onClick={onRetry}>
                  {t('operator.sent.retry')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "Elküldve", or what the message still waits for while the Operator has not taken it. */
function sentLine(
  message: TeamMessage,
  handle: string,
  wait: ReturnType<typeof operatorWaitOf>,
  members: ReturnType<typeof useProjectIndexes>['members'],
): string {
  const receipt = receiptsOf(message, members).find((r) => r.handle === handle);
  if (receipt?.deliveredAt) return t('operator.sent.plain');
  return operatorSentText(wait ?? 'queued');
}
