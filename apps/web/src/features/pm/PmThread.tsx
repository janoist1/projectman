import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { isUnreadBy } from '@projectman/shared';
import type { ProjectManagerChannel, TeamMessage } from '@projectman/shared';
import { useBoard, useConversation, useReadTeamMessages } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Markdown } from '../../components/Markdown';
import { ErrorState } from '../../components/States';
import { Avatar } from '../../components/Avatar';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { layoutThread, threadItems } from '../messages/conversations';
import type { ThreadEntry } from '../messages/conversations';
import { READ_AFTER_MS, STICK_PX, useDocumentVisible } from '../messages/ConversationThread';
import { receiptsOf } from '../messages/receipts';
import { TaskChip } from '../messages/TaskChip';
import { pmSentText, pmWaitOf } from './pmChannel';
import styles from './PmThread.module.css';

/** A message that did not go out: the text stays visible so it can be sent again. */
export interface FailedPmMessage {
  text: string;
  taskKey: string | null;
}

/** The owner's conversation with the project manager: bubbles, day separators, card links (PM-429). */
export function PmThread({
  handle,
  channel,
  failed,
  onRetry,
}: {
  handle: string;
  channel: ProjectManagerChannel;
  failed: FailedPmMessage | null;
  onRetry: () => void;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const board = useBoard(key);
  const conversation = useConversation(key, handle);
  const readMessages = useReadTeamMessages(key);
  const visible = useDocumentVisible();
  const member = members.get(handle);

  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );
  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);
  const entries = useMemo(() => layoutThread(threadItems(messages, [], []), null), [messages]);
  const wait = pmWaitOf(channel);

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
  const ready = Boolean(conversation.data);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box && ready && stick.current) box.scrollTop = box.scrollHeight;
  }, [entries.length, ready, failed, channel.state]);

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

  const cardKey = (taskKey: string) => (
    <TaskChip projectKey={key} taskKey={taskKey} title={titles.get(taskKey)} />
  );

  const renderEntry = (entry: ThreadEntry) => {
    const { item } = entry;
    if (item.type !== 'message') return null;
    const { message } = item;
    const mine = message.from === myHandle;
    return (
      <div key={message.id} className={styles.entry}>
        {entry.day ? (
          <div className={styles.day} role="separator">
            {entry.day}
          </div>
        ) : null}
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
              {mine ? <Markdown text={message.body} /> : <Markdown text={message.body} cardKey={cardKey} />}
            </div>
            <div className={styles.meta}>
              <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
              {mine ? <span className={styles.sent}>{sentLine(message, handle, wait, members)}</span> : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      ref={scroller}
      className={styles.thread}
      role="log"
      aria-live="polite"
      aria-label={t('pm.thread.label')}
      onScroll={(event) => {
        const box = event.currentTarget;
        stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
      }}
    >
      {entries.length === 0 && !failed ? (
        <div className={styles.intro}>
          <h3 className={styles.introTitle}>{t('pm.intro.title')}</h3>
          <p className={styles.introBody}>{t('pm.intro.body')}</p>
        </div>
      ) : (
        entries.map(renderEntry)
      )}
      {failed ? (
        <div className={clsx(styles.entry, styles.failed)}>
          <div className={clsx(styles.message, styles.out, styles.first)}>
            <div className={styles.col}>
              {failed.taskKey ? cardKey(failed.taskKey) : null}
              <div className={clsx(styles.bubble, styles.failedBubble)}>
                <Markdown text={failed.text} />
              </div>
              <div className={styles.meta}>
                <span className={styles.failedText} role="alert">
                  {t('pm.sent.failed')}
                </span>
                <Button size="sm" variant="ghost" onClick={onRetry}>
                  {t('pm.sent.retry')}
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "Elküldve", or what the message still waits for while the project manager has not taken it. */
function sentLine(
  message: TeamMessage,
  handle: string,
  wait: ReturnType<typeof pmWaitOf>,
  members: ReturnType<typeof useProjectIndexes>['members'],
): string {
  const receipt = receiptsOf(message, members).find((r) => r.handle === handle);
  if (receipt?.deliveredAt) return t('pm.sent.plain');
  return pmSentText(wait ?? 'queued');
}
