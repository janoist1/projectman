import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { isUnreadBy } from '@projectman/shared';
import type { InboxItem, ResolveInboxRequest, RoleView, TeamMessage } from '@projectman/shared';
import {
  useBoard,
  useConversation,
  useInbox,
  useReadTeamMessages,
  useResolveInbox,
  useSendTeamMessage,
} from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button, ButtonLink } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LeaveChip } from '../../components/LeaveChip';
import { Markdown } from '../../components/Markdown';
import { Popover } from '../../components/Popover';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatTime } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { optionLabel } from '../../lib/inbox';
import { nameOf, namesOf, roleLabel } from '../../lib/members';
import { useIsMobile } from '../../lib/hooks';
import { InboxCard } from '../inbox/InboxCard';
import { Composer } from '../session/Composer';
import {
  answeredQuestionsFrom,
  layoutThread,
  openQuestionsFrom,
  recentTasksOf,
  threadItems,
} from './conversations';
import type { ThreadEntry } from './conversations';
import { deliveryState, receiptsOf } from './receipts';
import { TaskChip } from './TaskChip';
import styles from './ConversationThread.module.css';

/** An opened thread marks its incoming messages read after this long, so a glance in passing does not. */
const READ_AFTER_MS = 1000;
/** The server's page of one thread (`limit` of the request); a full page means older messages are not shown. */
const PAGE_LIMIT = 500;
/** Within this distance of the bottom the thread follows new messages. */
const STICK_PX = 48;

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);
  return visible;
}

export interface ThreadComposeRequest {
  to: string[];
  task: string;
}

/** The conversation with one member: the messages, the questions they asked, and the box to answer in. */
export function ConversationThread({
  peer,
  roles,
  onCompose,
}: {
  peer: string;
  roles: readonly RoleView[] | undefined;
  /** Opens the new-message dialog (the reply to everyone). */
  onCompose: (request: ThreadComposeRequest) => void;
}) {
  const { key, myHandle, me } = useProject();
  const { members } = useProjectIndexes(key);
  const board = useBoard(key);
  const inbox = useInbox(key);
  const conversation = useConversation(key, peer);
  const resolve = useResolveInbox(key, myHandle);
  const readMessages = useReadTeamMessages(key);
  const send = useSendTeamMessage(key);
  const toast = useToast();
  const isMobile = useIsMobile();
  const visible = useDocumentVisible();
  const member = members.get(peer);
  const access = me.projects.find((p) => p.key === key)?.access;
  const canSend = Boolean(access && ['owner', 'admin', 'developer', 'client'].includes(access));

  const titles = useMemo(
    () => new Map((board.data?.tasks ?? []).map((task) => [task.key, task.title])),
    [board.data],
  );
  const messages = useMemo(() => conversation.data?.messages ?? [], [conversation.data]);
  const open = useMemo(
    () => openQuestionsFrom(inbox.data?.items, peer, myHandle),
    [inbox.data, peer, myHandle],
  );
  const answered = useMemo(
    () => answeredQuestionsFrom(inbox.data?.items, peer, myHandle),
    [inbox.data, peer, myHandle],
  );

  // The "new messages" line stays where the visit started, though the messages become read at once.
  const [newFromId, setNewFromId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (newFromId !== undefined || !conversation.data) return;
    setNewFromId(messages.find((m) => m.from === peer && isUnreadBy(m, myHandle))?.id ?? null);
  }, [newFromId, conversation.data, messages, peer, myHandle]);

  const entries = useMemo(
    () => layoutThread(threadItems(messages, open, answered), newFromId ?? null),
    [messages, open, answered, newFromId],
  );

  // Opening is reading: the incoming unread messages of a visible thread, one request.
  const unreadIds = messages.filter((m) => m.from === peer && isUnreadBy(m, myHandle)).map((m) => m.id);
  const unreadKey = unreadIds.join(',');
  const { mutate: markRead } = readMessages;
  useEffect(() => {
    if (!unreadKey || !visible) return;
    const timer = setTimeout(() => markRead(unreadKey.split(',')), READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreadKey, visible, markRead]);

  // Scrolling: to the "new messages" line (or the end) when opened; then follow new messages only
  // while the reader is at the bottom, otherwise offer a pill.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opened = useRef(false);
  const [pill, setPill] = useState(false);
  const lastEntry = entries[entries.length - 1];
  const lastIsIncoming = lastEntry?.item.type === 'message' && lastEntry.item.message.from !== myHandle;
  const ready = Boolean(conversation.data);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !ready) return;
    if (!opened.current) {
      opened.current = true;
      const line = box.querySelector<HTMLElement>('[data-new-line]');
      box.scrollTop = line ? Math.max(0, line.offsetTop - 60) : box.scrollHeight;
      stick.current = !line;
      return;
    }
    if (stick.current) box.scrollTop = box.scrollHeight;
    else if (lastIsIncoming) setPill(true);
  }, [entries.length, ready, lastIsIncoming]);

  const jumpToEnd = () => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
    stick.current = true;
    setPill(false);
  };

  // The composer's task: the thread's latest unless chosen.
  const recentTasks = useMemo(() => recentTasksOf(messages), [messages]);
  const [taskChoice, setTaskChoice] = useState<string | null>(null);
  const task = taskChoice ?? recentTasks[0] ?? '';
  const otherTasks = (board.data?.tasks ?? []).filter((candidate) => !recentTasks.includes(candidate.key));
  const composerBox = useRef<HTMLDivElement>(null);
  const otherTaskOptions = otherTasks.map((candidate) => (
    <option key={candidate.key} value={candidate.key}>
      {candidate.key} · {candidate.title}
    </option>
  ));

  const reply = (message: TeamMessage) => {
    setTaskChoice(message.taskKey ?? '');
    composerBox.current?.querySelector('textarea')?.focus();
  };
  const replyAll = (message: TeamMessage) =>
    onCompose({
      to: [...new Set([message.from, ...message.to])].filter((handle) => handle !== myHandle),
      task: message.taskKey ?? '',
    });

  const answer = (item: InboxItem, body: ResolveInboxRequest) =>
    resolve.mutate({ item, body }, { onError: () => toast.show(t('inbox.resolveFailed'), 'error') });

  const name = nameOf(peer, members, myHandle);
  const back = `/p/${key}/messages`;
  // The team list has only current members: a handle not in it with a past conversation is a former
  // member (read-only thread); one with nothing at all is a mistyped address.
  const gone = Boolean(board.data) && !member;
  const unknown = gone && conversation.isSuccess && entries.length === 0;
  const retired = member?.status === 'retired' || gone;
  const headName = useRef<HTMLDivElement>(null);
  // On a phone the thread is a page of its own: the focus goes to its title.
  useEffect(() => {
    if (isMobile) headName.current?.focus();
  }, [isMobile]);

  const renderEntry = (entry: ThreadEntry) => {
    const { item } = entry;
    return (
      <div key={`${item.type}-${item.id}`} className={styles.entry}>
        {entry.day ? (
          <div className={styles.day} role="separator">
            {entry.day}
          </div>
        ) : null}
        {entry.newLine ? (
          <div className={styles.newLine} role="separator" data-new-line>
            {t('messages.thread.newMessages')}
          </div>
        ) : null}
        {item.type === 'message' ? (
          <MessageBubble
            message={item.message}
            entry={entry}
            peer={peer}
            members={members}
            myHandle={myHandle}
            projectKey={key}
            titles={titles}
            canSend={canSend}
            onReply={reply}
            onReplyAll={replyAll}
          />
        ) : item.type === 'question' ? (
          <section className={styles.question} aria-label={t('messages.question.heading')}>
            <div className={styles.questionHead}>
              <span aria-hidden="true">●</span>
              <span>{t('messages.question.heading')}</span>
            </div>
            <InboxCard
              item={item.item}
              members={members}
              myHandle={myHandle}
              labels={board.data?.labels}
              compact
              mobile={isMobile}
              headingLevel={3}
              taskTitle={item.item.taskKey ? (titles.get(item.item.taskKey) ?? item.item.taskKey) : null}
              pending={resolve.isPending && resolve.variables?.item.id === item.item.id}
              onResolve={answer}
            />
          </section>
        ) : (
          <p className={styles.answered}>
            {t('messages.question.answered', {
              title: item.item.title,
              answer: answeredText(item.item),
            })}
          </p>
        )}
      </div>
    );
  };

  if (unknown) {
    return (
      <section className={styles.thread} aria-label={t('messages.thread.unknownMember')}>
        <div className={styles.empty}>
          <h2 className={styles.emptyTitle}>{t('messages.thread.unknownMember')}</h2>
          <ButtonLink to={back} variant="secondary" size="md">
            {t('messages.thread.back')}
          </ButtonLink>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.thread} aria-label={t('messages.thread.label', { name })}>
      <header className={styles.head}>
        {isMobile ? (
          <ButtonLink
            to={back}
            variant="ghost"
            size="lg"
            iconOnly
            icon="chevronLeft"
            aria-label={t('messages.thread.back')}
          />
        ) : null}
        <Avatar member={member} handle={peer} size="lg" />
        <div className={styles.who}>
          <div className={styles.name} ref={headName} tabIndex={-1}>
            <span className={styles.nameText}>{name}</span>
            <LeaveChip member={member} />
          </div>
          <div className={styles.role}>{roleLabel(member, roles)}</div>
        </div>
        {member ? (
          <ButtonLink to={`/p/${key}/team/${peer}`} variant="ghost" size="sm">
            {t('messages.thread.profile')}
          </ButtonLink>
        ) : null}
      </header>

      {conversation.isPending ? (
        <LoadingState className={styles.state} />
      ) : conversation.isError ? (
        <ErrorState error={conversation.error} onRetry={() => void conversation.refetch()} />
      ) : (
        <div className={styles.scrollWrap}>
          <div
            ref={scroller}
            className={styles.messages}
            role="log"
            aria-live="polite"
            onScroll={(event) => {
              const box = event.currentTarget;
              stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
              if (stick.current) setPill(false);
            }}
          >
            {messages.length >= PAGE_LIMIT ? (
              <p className={styles.limit}>{t('messages.thread.limit', { count: PAGE_LIMIT })}</p>
            ) : null}
            {entries.length === 0 ? (
              <div className={styles.empty}>
                <h2 className={styles.emptyTitle}>{t('messages.thread.emptyTitle')}</h2>
                <p className={styles.emptyBody}>
                  {member?.kind === 'human'
                    ? t('messages.thread.emptyHuman')
                    : t('messages.thread.emptyBody')}
                </p>
              </div>
            ) : (
              entries.map(renderEntry)
            )}
          </div>
          {pill ? (
            <Button
              className={styles.pill}
              variant="primary"
              size="sm"
              iconRight="chevronDown"
              onClick={jumpToEnd}
            >
              {t('messages.thread.newPill')}
            </Button>
          ) : null}
        </div>
      )}

      {retired ? (
        <p className={styles.readOnly}>{t('messages.thread.retiredMember')}</p>
      ) : canSend ? (
        <div className={styles.composer} ref={composerBox}>
          {send.error ? (
            <ErrorBanner className={styles.sendError}>
              {t('messages.composer.failed')} {errorMessage(send.error)}
            </ErrorBanner>
          ) : null}
          <div className={styles.taskRow}>
            <label htmlFor={`task-${peer}`}>{t('messages.composer.task')}</label>
            <select
              id={`task-${peer}`}
              className={styles.taskSelect}
              value={task}
              onChange={(event) => setTaskChoice(event.target.value)}
            >
              <option value="">{t('messages.composer.noTask')}</option>
              {recentTasks.length ? (
                <optgroup label={t('messages.composer.recent')}>
                  {recentTasks.map((taskKey) => (
                    <option key={taskKey} value={taskKey}>
                      {taskKey} · {titles.get(taskKey) ?? ''}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              {recentTasks.length ? (
                <optgroup label={t('messages.composer.otherTasks')}>{otherTaskOptions}</optgroup>
              ) : (
                otherTaskOptions
              )}
            </select>
            {!task && member?.kind === 'ai' ? (
              <span className={styles.hint}>{t('messages.composer.generalHint')}</span>
            ) : null}
          </div>
          <Composer
            autoFocus={!isMobile && ready && entries.length === 0}
            label={t('messages.composer.label', { name })}
            placeholder={t('messages.composer.placeholder')}
            disabled={send.isPending}
            onSend={(text) =>
              send.mutateAsync({ to: [peer], text, ...(task ? { taskKey: task } : {}) }).then(() => undefined)
            }
          />
        </div>
      ) : (
        <p className={styles.readOnly}>{t('messages.composer.readOnly')}</p>
      )}
    </section>
  );
}

/** What I answered: the free text, or the option I chose. */
function answeredText(item: InboxItem): string {
  const resolution = item.resolution;
  if (!resolution) return '';
  const note = resolution.note?.trim();
  if (note) return note;
  const option = item.options.find((candidate) => candidate.id === resolution.optionId);
  return option ? optionLabel(option) : resolution.optionId;
}

function MessageBubble({
  message,
  entry,
  peer,
  members,
  myHandle,
  projectKey,
  titles,
  canSend,
  onReply,
  onReplyAll,
}: {
  message: TeamMessage;
  entry: ThreadEntry;
  peer: string;
  members: ReturnType<typeof useProjectIndexes>['members'];
  myHandle: string | null;
  projectKey: string;
  titles: ReadonlyMap<string, string>;
  canSend: boolean;
  onReply: (message: TeamMessage) => void;
  onReplyAll: (message: TeamMessage) => void;
}) {
  const mine = message.from === myHandle;
  const unread = !mine && isUnreadBy(message, myHandle);
  // Who else got it: a group message is in every recipient's thread, marked with the others.
  const also = message.to.filter((handle) => handle !== myHandle && handle !== peer);
  const receipts = receiptsOf(message, members);
  const state = deliveryState(receipts);
  return (
    <div
      className={clsx(
        styles.message,
        mine ? styles.out : styles.in,
        entry.firstOfRun && styles.first,
        unread && styles.unreadMessage,
      )}
      tabIndex={canSend ? 0 : undefined}
      data-message-id={message.id}
    >
      {mine ? null : (
        <span className={styles.avatarSlot}>
          {entry.firstOfRun ? <Avatar member={members.get(peer)} handle={peer} size="md" /> : null}
        </span>
      )}
      <div className={styles.col}>
        {!mine && entry.firstOfRun ? (
          <span className={styles.sender}>{nameOf(message.from, members, myHandle)}</span>
        ) : null}
        {entry.showTask && message.taskKey ? (
          <TaskChip projectKey={projectKey} taskKey={message.taskKey} title={titles.get(message.taskKey)} />
        ) : null}
        <div className={styles.bubble}>
          <Markdown text={message.body} />
        </div>
        <div className={styles.meta}>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          {unread ? <span className={styles.unreadMark}>{t('messages.thread.unread')}</span> : null}
          {also.length ? (
            <span className={styles.also}>
              {t('messages.thread.also', { names: joinNames(namesOf(also, members, myHandle)) })}
            </span>
          ) : null}
          {mine ? (
            <Popover
              label={t(`messages.status.${state}`)}
              variant="ghost"
              size="sm"
              className={clsx(styles.status, state === 'queued' && styles.statusWait)}
            >
              {() => (
                <ul className={styles.receipts} aria-label={t('messages.status.details')}>
                  {receipts.map((receipt) => (
                    <li key={receipt.handle}>
                      <strong>{nameOf(receipt.handle, members, myHandle)}</strong> ·{' '}
                      {receipt.kind === 'ai'
                        ? receipt.deliveredAt
                          ? t('messages.status.aiTyped')
                          : t('messages.status.aiQueued')
                        : receipt.readAt
                          ? t('messages.status.humanRead')
                          : t('messages.status.humanUnread')}
                      {receipt.route?.type === 'general' ? ` · ${t('messages.routeGeneral')}` : null}
                      {receipt.route?.type === 'task'
                        ? ` · ${t('messages.routeTask', { taskKey: receipt.route.taskKey })}`
                        : null}
                    </li>
                  ))}
                </ul>
              )}
            </Popover>
          ) : null}
          {canSend ? (
            <span className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => onReply(message)}>
                {t('messages.reply')}
              </Button>
              {also.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => onReplyAll(message)}>
                  {t('messages.thread.replyAll')}
                </Button>
              ) : null}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
