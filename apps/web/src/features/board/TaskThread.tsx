import clsx from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { canSeeAllTeamMessages, cardThreadRecipients, isUnreadBy } from '@projectman/shared';
import type {
  InboxItem,
  LabelView,
  MemberView,
  ResolveInboxRequest,
  Task,
  TeamMessage,
} from '@projectman/shared';
import {
  useInbox,
  useReadTeamMessages,
  useResolveInbox,
  useSendTeamMessage,
  useTaskMessages,
} from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatTime } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { splitQuestion } from '../../lib/inbox';
import { nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { useDismiss, useIsMobile } from '../../lib/hooks';
import { InboxCard } from '../inbox/InboxCard';
import { QuestionBody } from '../inbox/Question';
import { PAGE_LIMIT, READ_AFTER_MS, STICK_PX, useDocumentVisible } from '../messages/ConversationThread';
import { layoutThread, threadItems } from '../messages/conversations';
import type { ThreadEntry } from '../messages/conversations';
import { DeliveryStatus } from '../messages/DeliveryStatus';
import { Composer } from '../session/Composer';
import styles from './TaskThread.module.css';

/** How long a message reached by a link stays highlighted. */
const FLASH_MS = 1800;

const BASIS_KEY = {
  workers: 'workers',
  assignee: 'assignee',
  stage_owners: 'stageOwners',
  none: 'none',
} as const;

/** The same people, whatever the order. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((handle) => b.includes(handle));
}

/** A run of messages shows its route once; another set of recipients, or a question and its answer, starts a new one. */
function breaksRun(previous: TeamMessage, message: TeamMessage): boolean {
  return Boolean(previous.answer || message.answer) || !sameSet(previous.to, message.to);
}

interface TaskThreadProps {
  task: Pick<Task, 'key' | 'assignee'>;
  /** The Thread view is the one showing; the other stays in the tree (a draft is kept) but reads and scrolls nothing. */
  active: boolean;
  /** The drawer reads the messages once: the switch counts them too. */
  query: ReturnType<typeof useTaskMessages>;
  /** The members working on the card now, in `cardWorkerSessions` order. */
  workers: readonly string[];
  stageOwners: readonly string[];
  members: MemberIndex;
  labels: readonly LabelView[] | undefined;
  /** `?message=`: the message a link leads to. */
  messageParam: string | null;
}

/**
 * The card's conversation (PM-273): every team message written about the card that the viewer may see,
 * the question an AI member asked with the answer to it, a question waiting for the viewer, and the box
 * to write in with the recipients on show.
 */
export function TaskThread({
  task,
  active,
  query,
  workers,
  stageOwners,
  members,
  labels,
  messageParam,
}: TaskThreadProps) {
  const { key, myHandle, me } = useProject();
  const inbox = useInbox(key);
  const resolve = useResolveInbox(key, myHandle);
  const readMessages = useReadTeamMessages(key);
  const send = useSendTeamMessage(key);
  const toast = useToast();
  const isMobile = useIsMobile();
  const visible = useDocumentVisible();
  const access = me.projects.find((project) => project.key === key)?.access;
  const canSeeAll = access ? canSeeAllTeamMessages({ access }) : false;
  const canSend = Boolean(myHandle && access && ['owner', 'admin', 'developer', 'client'].includes(access));

  const messages = useMemo(() => query.data?.messages ?? [], [query.data]);
  const ready = Boolean(query.data);
  const waiting = useMemo(
    () =>
      (inbox.data?.items ?? []).filter(
        (item) =>
          item.kind === 'question' &&
          item.state === 'open' &&
          item.taskKey === task.key &&
          Boolean(myHandle && item.assignees.includes(myHandle)),
      ),
    [inbox.data, task.key, myHandle],
  );

  // The "new messages" line stays where the visit started, though the messages become read at once.
  const [newFromId, setNewFromId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (newFromId !== undefined || !active || !query.data) return;
    setNewFromId(messages.find((message) => isUnreadBy(message, myHandle))?.id ?? null);
  }, [newFromId, active, query.data, messages, myHandle]);

  const entries = useMemo(
    () => layoutThread(threadItems(messages, waiting, []), newFromId ?? null, breaksRun),
    [messages, waiting, newFromId],
  );

  // Reading: the incoming unread messages of the thread in sight, one request.
  const unreadKey = messages
    .filter((message) => isUnreadBy(message, myHandle))
    .map((message) => message.id)
    .join(',');
  const { mutate: markRead } = readMessages;
  useEffect(() => {
    if (!unreadKey || !visible || !active) return;
    const timer = setTimeout(() => markRead(unreadKey.split(',')), READ_AFTER_MS);
    return () => clearTimeout(timer);
  }, [unreadKey, visible, active, markRead]);

  // Scrolling: to the linked message, else to the "new messages" line (or the end) when first shown; shown
  // again, to where it was left. New messages are followed only while the reader is at the bottom,
  // otherwise a pill offers them.
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const opened = useRef(false);
  const left = useRef(0);
  const reached = useRef<string | null>(null);
  const seen = useRef(0);
  const [pill, setPill] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !active || !ready) return;
    seen.current = entries.length;
    if (messageParam && reached.current !== messageParam) {
      reached.current = messageParam;
      const target = [...box.querySelectorAll<HTMLElement>('[data-message-id]')].find(
        (element) => element.dataset.messageId === messageParam,
      );
      if (target) {
        opened.current = true;
        box.scrollTop = Math.max(0, target.offsetTop - 60);
        stick.current = false;
        setFlash(messageParam);
        return;
      }
      // Not among the messages shown (older than the page, or not the viewer's): the usual place, no error.
    }
    if (!opened.current) {
      opened.current = true;
      const line = box.querySelector<HTMLElement>('[data-new-line]');
      box.scrollTop = line ? Math.max(0, line.offsetTop - 60) : box.scrollHeight;
      stick.current = !line;
      return;
    }
    box.scrollTop = stick.current ? box.scrollHeight : left.current;
  }, [active, ready, messageParam]);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [flash]);

  const lastEntry = entries[entries.length - 1];
  const lastIsIncoming = lastEntry?.item.type === 'message' && lastEntry.item.message.from !== myHandle;
  useLayoutEffect(() => {
    const box = scroller.current;
    if (!box || !active || !opened.current || seen.current === entries.length) return;
    seen.current = entries.length;
    if (stick.current) box.scrollTop = box.scrollHeight;
    else if (lastIsIncoming) setPill(true);
  }, [active, entries.length, lastIsIncoming]);

  const jumpToEnd = () => {
    const box = scroller.current;
    if (box) box.scrollTop = box.scrollHeight;
    stick.current = true;
    setPill(false);
  };

  // The recipients: the default follows who works on the card until the writer chooses.
  const canReceive = (handle: string) => {
    const member = members.get(handle);
    return (
      Boolean(member) &&
      member?.status !== 'retired' &&
      !(member?.kind === 'human' && member.role === 'client')
    );
  };
  const defaults = cardThreadRecipients({
    workers,
    assignee: task.assignee,
    stageOwners,
    writer: myHandle ?? '',
    canReceive,
  });
  const [chosen, setChosen] = useState<string[] | null>(null);
  const to = chosen ?? defaults.to;
  const toggle = (handle: string) =>
    setChosen((current) => {
      const base = current ?? defaults.to;
      return base.includes(handle) ? base.filter((candidate) => candidate !== handle) : [...base, handle];
    });
  const candidates = [...members.values()].filter(
    (member) => member.handle !== myHandle && canReceive(member.handle),
  );
  const working = candidates.filter((member) => workers.includes(member.handle));
  const others = candidates.filter((member) => !workers.includes(member.handle));

  const [picking, setPicking] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const dismissRefs = useMemo(() => [addButton, popover], []);
  useDismiss(picking, () => setPicking(false), dismissRefs, addButton);
  useEffect(() => {
    if (picking) popover.current?.querySelector('input')?.focus();
  }, [picking]);

  const composerBox = useRef<HTMLDivElement>(null);
  const reply = (message: TeamMessage, everyone: boolean) => {
    const people = everyone
      ? [message.from, ...message.to]
      : message.from === myHandle
        ? message.to
        : [message.from];
    setChosen([...new Set(people)].filter((handle) => handle !== myHandle && canReceive(handle)));
    composerBox.current?.querySelector('textarea')?.focus();
  };

  const answer = (item: InboxItem, body: ResolveInboxRequest) =>
    resolve.mutate({ item, body }, { onError: () => toast.show(t('inbox.resolveFailed'), 'error') });

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
          item.message.answer ? (
            <QuestionAndAnswer
              message={item.message}
              answer={item.message.answer}
              members={members}
              myHandle={myHandle}
              flash={flash === item.message.id}
            />
          ) : (
            <MessageBubble
              message={item.message}
              entry={entry}
              members={members}
              myHandle={myHandle}
              canSend={canSend}
              flash={flash === item.message.id}
              canReplyAll={
                new Set([item.message.from, ...item.message.to].filter((handle) => handle !== myHandle))
                  .size > 1
              }
              onReply={reply}
            />
          )
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
              labels={labels}
              compact
              mobile={isMobile}
              headingLevel={3}
              taskTitle={null}
              pending={resolve.isPending && resolve.variables?.item.id === item.item.id}
              onResolve={answer}
            />
          </section>
        ) : null}
      </div>
    );
  };

  const hint = chosen ? (
    <>
      {t('task.thread.edited')}{' '}
      <button type="button" className={styles.reset} onClick={() => setChosen(null)}>
        {t('task.thread.reset')}
      </button>
    </>
  ) : (
    t(`task.thread.default.${BASIS_KEY[defaults.basis]}`)
  );

  return (
    <section className={styles.panel} aria-label={t('task.thread.label')}>
      {query.isPending ? (
        <LoadingState className={styles.state} />
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <div className={styles.logWrap}>
          {canSeeAll ? null : <p className={styles.limited}>{t('task.thread.limited')}</p>}
          <div
            ref={scroller}
            className={styles.log}
            role="log"
            aria-live="polite"
            onScroll={(event) => {
              const box = event.currentTarget;
              // A hidden view reports nothing: its scroll box is reset by hiding it.
              if (!active) return;
              left.current = box.scrollTop;
              stick.current = box.scrollHeight - box.scrollTop - box.clientHeight < STICK_PX;
              if (stick.current) setPill(false);
            }}
          >
            <div className={styles.column}>
              {messages.length >= PAGE_LIMIT ? (
                <p className={styles.limit}>
                  {t('messages.thread.limit', { count: PAGE_LIMIT })}
                  {canSeeAll ? (
                    <>
                      {' '}
                      <Link to={`/p/${key}/messages/all?task=${task.key}`}>{t('messages.views.all')}</Link>
                    </>
                  ) : null}
                </p>
              ) : null}
              {entries.length === 0 ? (
                <div className={styles.empty}>
                  <h3 className={styles.emptyTitle}>
                    {t(canSeeAll ? 'task.thread.emptyTitle' : 'task.thread.emptyLimitedTitle')}
                  </h3>
                  <p className={styles.emptyBody}>
                    {t(
                      canSeeAll
                        ? 'task.thread.emptyBody'
                        : canSend
                          ? 'task.thread.emptyLimitedBody'
                          : 'task.thread.emptyViewerBody',
                    )}
                  </p>
                </div>
              ) : (
                entries.map(renderEntry)
              )}
            </div>
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

      {canSend ? (
        <div className={styles.composer} ref={composerBox}>
          <div className={styles.composerColumn}>
            {send.error ? (
              <ErrorBanner className={styles.sendError}>
                {t('messages.composer.failed')} {errorMessage(send.error)}
              </ErrorBanner>
            ) : null}
            <div className={styles.toRow}>
              <span className={styles.toLabel}>{t('task.thread.to')}</span>
              <ul className={styles.toChips} aria-label={t('task.thread.recipients')}>
                {to.map((handle) => {
                  const name = nameOf(handle, members, myHandle);
                  return (
                    <li key={handle} className={styles.toChip}>
                      <Avatar member={members.get(handle)} handle={handle} size="xs" />
                      <span className={styles.toName}>{name}</span>
                      <button
                        type="button"
                        className={styles.toRemove}
                        aria-label={t('task.thread.remove', { name })}
                        onClick={() => toggle(handle)}
                      >
                        <Icon name="close" size={12} strokeWidth={2.4} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button
                ref={addButton}
                type="button"
                className={styles.addTo}
                aria-expanded={picking}
                aria-label={t('task.thread.addTo')}
                onClick={() => setPicking((open) => !open)}
              >
                <Icon name="plus" size={12} strokeWidth={2.4} />
                <span>{t('task.thread.to')}</span>
              </button>
            </div>
            {picking ? (
              <div
                ref={popover}
                className={styles.pop}
                role="group"
                aria-label={t('task.thread.addTo')}
                data-popover-open="true"
              >
                {working.length > 0 ? (
                  <RecipientGroup
                    title={t('task.thread.working')}
                    dot
                    members={working}
                    chosen={to}
                    onToggle={toggle}
                  />
                ) : null}
                {others.length > 0 ? (
                  <RecipientGroup
                    title={t('task.thread.others')}
                    members={others}
                    chosen={to}
                    onToggle={toggle}
                  />
                ) : null}
              </div>
            ) : null}
            <p className={styles.toHint}>{hint}</p>
            <Composer
              autoFocus={false}
              label={t('task.thread.composerLabel', { key: task.key })}
              placeholder={t('task.thread.placeholder')}
              disabled={send.isPending}
              blocked={to.length === 0}
              onSend={(text) => {
                stick.current = true;
                return send.mutateAsync({ to, text, taskKey: task.key }).then(() => undefined);
              }}
            />
          </div>
        </div>
      ) : (
        <p className={styles.readOnly}>{t('messages.composer.readOnly')}</p>
      )}
    </section>
  );
}

function RecipientGroup({
  title,
  dot = false,
  members,
  chosen,
  onToggle,
}: {
  title: string;
  dot?: boolean;
  members: readonly MemberView[];
  chosen: readonly string[];
  onToggle: (handle: string) => void;
}) {
  return (
    <div className={styles.popGroup} role="group" aria-label={title}>
      <div className={styles.popTitle}>
        {dot ? <span className={styles.workingDot} aria-hidden="true" /> : null}
        {title}
      </div>
      {members.map((member) => (
        <label key={member.handle} className={styles.popItem}>
          <input
            type="checkbox"
            checked={chosen.includes(member.handle)}
            onChange={() => onToggle(member.handle)}
          />
          <Avatar member={member} handle={member.handle} size="xs" />
          <span>{member.displayName}</span>
        </label>
      ))}
    </div>
  );
}

/** "Név → Név, Név": who wrote it and to whom. */
function routeOf(message: TeamMessage, members: MemberIndex, myHandle: string | null): string {
  return t('messages.fromTo', {
    from: nameOf(message.from, members, myHandle),
    to: joinNames(namesOf(message.to, members, myHandle)),
  });
}

function MessageBubble({
  message,
  entry,
  members,
  myHandle,
  canSend,
  canReplyAll,
  flash,
  onReply,
}: {
  message: TeamMessage;
  entry: ThreadEntry;
  members: MemberIndex;
  myHandle: string | null;
  canSend: boolean;
  canReplyAll: boolean;
  flash: boolean;
  onReply: (message: TeamMessage, everyone: boolean) => void;
}) {
  const mine = message.from === myHandle;
  const unread = isUnreadBy(message, myHandle);
  return (
    <div
      id={`message-${message.id}`}
      className={clsx(
        styles.message,
        mine && styles.out,
        entry.firstOfRun && styles.first,
        unread && styles.unreadMessage,
        flash && styles.flash,
      )}
      tabIndex={canSend ? 0 : undefined}
      data-message-id={message.id}
      data-flash={flash ? '' : undefined}
    >
      {mine ? null : (
        <span className={styles.avatarSlot}>
          {entry.firstOfRun ? (
            <Avatar member={members.get(message.from)} handle={message.from} size="md" />
          ) : null}
        </span>
      )}
      <div className={styles.col}>
        {entry.firstOfRun ? (
          <span className={styles.route}>{routeOf(message, members, myHandle)}</span>
        ) : null}
        <div className={styles.bubble}>
          <Markdown text={message.body} />
        </div>
        <div className={styles.meta}>
          <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
          {unread ? <span className={styles.unreadMark}>{t('messages.thread.unread')}</span> : null}
          {mine ? <DeliveryStatus message={message} members={members} myHandle={myHandle} /> : null}
          {canSend ? (
            <span className={styles.actions}>
              <Button size="sm" variant="ghost" onClick={() => onReply(message, false)}>
                {t('messages.reply')}
              </Button>
              {canReplyAll ? (
                <Button size="sm" variant="ghost" onClick={() => onReply(message, true)}>
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

/** The question an AI member asked and the answer given to it, as one row. */
function QuestionAndAnswer({
  message,
  answer,
  members,
  myHandle,
  flash,
}: {
  message: TeamMessage;
  answer: NonNullable<TeamMessage['answer']>;
  members: MemberIndex;
  myHandle: string | null;
  flash: boolean;
}) {
  const asker = nameOf(message.to[0], members, myHandle);
  const { title, body } = splitQuestion(answer.question);
  return (
    <section
      id={`message-${message.id}`}
      className={clsx(styles.qa, flash && styles.flash)}
      role="group"
      aria-label={t('task.thread.qa')}
      data-message-id={message.id}
      data-flash={flash ? '' : undefined}
    >
      <div className={styles.qaHead}>
        <span>{t('task.thread.qa')}</span>
        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
      </div>
      <p className={styles.qaAsked}>
        {t('task.thread.asked', { name: asker })}
        {title ? (
          <>
            {' '}
            <strong>{title}</strong>
          </>
        ) : null}
      </p>
      {body ? <QuestionBody text={body} closed={Boolean(title)} /> : null}
      <p className={styles.qaAnswer}>
        {message.from === myHandle
          ? t('task.thread.youAnswered', { answer: answer.answer })
          : t('task.thread.answered', {
              name: nameOf(message.from, members, myHandle),
              answer: answer.answer,
            })}
      </p>
    </section>
  );
}
