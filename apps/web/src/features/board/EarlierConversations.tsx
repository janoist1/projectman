import clsx from 'clsx';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { hasConnectedOrigin, isUnreadBy, SYSTEM_SENDER } from '@projectman/shared';
import type { TeamMessage } from '@projectman/shared';
import { useReadTeamMessages, useTaskMessages } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import { Markdown } from '../../components/Markdown';
import { ErrorState, LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { formatStamp, formatTime } from '../../i18n/format';
import { joinNames, t } from '../../i18n/t';
import { splitQuestion } from '../../lib/inbox';
import { failText } from '../../lib/errors';
import { actorByline, nameOf, namesOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { QuestionBody } from '../inbox/Question';
import { READ_AFTER_MS, useDocumentVisible } from '../messages/ConversationThread';
import { MessageAttachments } from '../messages/MessageAttachments';
import styles from './EarlierConversations.module.css';

/** How long a message reached by a link stays highlighted. */
const FLASH_MS = 2000;
/** How long the page waits for a linked message to appear (the messages and the story load after the page opens). */
const LINK_WAIT_MS = 10_000;
/** How long a linked message is kept in the middle while the content around it settles. */
const KEEP_CENTERED_MS = 4000;
/** The reader taking over the scroll ends the keeping. */
const READER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Leads the page to a linked message: waits for it to appear, then keeps it in the middle (the content above it may
 * still grow) until the reader scrolls on their own. `onReached` runs once, when the message is found. Returns the cleanup.
 */
function leadTo(find: () => HTMLElement | null, onReached: (target: HTMLElement) => void): () => void {
  const started = performance.now();
  let reachedAt: number | null = null;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of READER_INPUT) document.removeEventListener(type, stop, true);
  };
  const tick = () => {
    const now = performance.now();
    const target = find();
    if (target && reachedAt === null) {
      reachedAt = now;
      onReached(target);
    }
    if (target && reachedAt !== null) {
      if (now - reachedAt > KEEP_CENTERED_MS) return stop();
      target.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    } else if (now - started > LINK_WAIT_MS) return stop();
    frame = requestAnimationFrame(tick);
  };
  for (const type of READER_INPUT) document.addEventListener(type, stop, true);
  frame = requestAnimationFrame(tick);
  return stop;
}

/** Who wrote a message: a connected Claude's step names how it was made; the old integrator rows stay as they were. */
function senderOf(message: TeamMessage, members: MemberIndex, myHandle: string | null): string {
  if (hasConnectedOrigin(message.actor)) return actorByline(message.actor, members, myHandle);
  return message.via ? t('involvement.integratorFull') : nameOf(message.from, members, myHandle);
}

function Message({
  message,
  members,
  myHandle,
  flash,
}: {
  message: TeamMessage;
  members: MemberIndex;
  myHandle: string | null;
  flash: boolean;
}) {
  const unread = isUnreadBy(message, myHandle);
  return (
    <li
      id={`message-${message.id}`}
      className={clsx(styles.message, flash && styles.flash)}
      tabIndex={-1}
      data-message-id={message.id}
      data-flash={flash ? '' : undefined}
    >
      <p className={styles.head}>
        <span className={styles.author}>{senderOf(message, members, myHandle)}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={message.createdAt}>{formatStamp(message.createdAt)}</time>
        {unread ? <span className={styles.unreadMark}>{t('messages.thread.unread')}</span> : null}
      </p>
      {message.body.trim() ? <Markdown text={message.body} /> : null}
      <MessageAttachments files={message.attachments ?? []} from={message.from} />
      {message.to.length > 0 && message.from !== SYSTEM_SENDER ? (
        <p className={styles.to}>
          {t('task.earlier.to', { names: joinNames(namesOf(message.to, members, myHandle)) })}
        </p>
      ) : null}
    </li>
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
    <li
      id={`message-${message.id}`}
      className={clsx(styles.qa, flash && styles.flash)}
      tabIndex={-1}
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
        {message.via
          ? `${t('integratorKey.forwarded')}: ${answer.answer}`
          : message.from === myHandle
            ? t('task.thread.youAnswered', { answer: answer.answer })
            : t('task.thread.answered', {
                name: senderOf(message, members, myHandle),
                answer: answer.answer,
              })}
      </p>
    </li>
  );
}

/**
 * The card's earlier conversations (PM-1290), at the bottom of the Process view: the team messages written about
 * the card that the viewer may see, read-only. A new message is written on the card as a comment, so there is no
 * box and no Reply here. The block is closed until the old `?message=` link opens it at that message; with no
 * message to show it is gone (a client is told so).
 */
export function EarlierConversations({
  active,
  query,
  members,
  messageParam,
}: {
  /** The Process view is the one showing. */
  active: boolean;
  query: ReturnType<typeof useTaskMessages>;
  members: MemberIndex;
  /** `?message=`: the message a link leads to. */
  messageParam: string | null;
}) {
  const { key, myHandle, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const readMessages = useReadTeamMessages(key);
  const toast = useToast();
  const visible = useDocumentVisible();
  const messages = useMemo(
    () => [...(query.data?.messages ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [query.data],
  );
  // The old link opens the block; the reader may close it again.
  const [open, setOpen] = useState(messageParam !== null);
  const panel = useId();
  const box = useRef<HTMLUListElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const loaded = query.data !== undefined;

  // The old link: the block opens, the message is scrolled to the middle and framed for a moment.
  const reached = useRef<string | null>(null);
  useEffect(() => {
    if (!active || !messageParam || reached.current === messageParam) return;
    setOpen(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = leadTo(
      () =>
        [...(box.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(
          (element) => element.dataset.messageId === messageParam,
        ) ?? null,
      (target) => {
        reached.current = messageParam;
        target.focus({ preventScroll: true });
        setFlash(messageParam);
        timer = setTimeout(() => setFlash(null), FLASH_MS);
      },
    );
    return () => {
      stop();
      clearTimeout(timer);
      setFlash(null);
    };
    // Starts again when the messages arrive: a failed load that a retry fixed still leads to the message.
  }, [active, messageParam, loaded]);

  // After a retry the Retry button is gone: the focus goes to the block's toggle once the list is there.
  const toggle = useRef<HTMLButtonElement>(null);
  const retried = useRef(false);
  useEffect(() => {
    if (!loaded || !retried.current) return;
    retried.current = false;
    toggle.current?.focus();
  }, [loaded]);

  // Reading: the incoming unread messages of the open block, one request.
  const unreadKey = messages
    .filter((message) => isUnreadBy(message, myHandle))
    .map((message) => message.id)
    .join(',');
  const { mutate: markRead } = readMessages;
  useEffect(() => {
    if (!unreadKey || !visible || !active || !open) return;
    const timer = setTimeout(
      () =>
        markRead(unreadKey.split(','), {
          onError: (error) => toast.show(failText(error, t('messages.readFailed')), 'error'),
        }),
      READ_AFTER_MS,
    );
    return () => clearTimeout(timer);
  }, [unreadKey, visible, active, open, markRead, toast]);

  if (!query.data) {
    // A failed first load is shown, with a retry; a plain load only when a `?message=` link waits for it.
    if (query.isError)
      return query.isFetching ? (
        <LoadingState compact />
      ) : (
        <ErrorState
          compact
          error={query.error}
          message={t('task.earlier.loadFailed')}
          onRetry={() => {
            retried.current = true;
            void query.refetch();
          }}
        />
      );
    return query.isPending && messageParam !== null ? <LoadingState compact /> : null;
  }
  if (messages.length === 0)
    return access === 'client' ? <p className={styles.none}>{t('task.earlier.none')}</p> : null;
  return (
    <section className={styles.earlier} aria-label={t('task.earlier.title', { count: messages.length })}>
      <button
        ref={toggle}
        type="button"
        className={styles.toggle}
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} strokeWidth={2.4} />
        <span>{t('task.earlier.title', { count: messages.length })}</span>
      </button>
      <p className={styles.note}>{t('task.earlier.readOnly')}</p>
      <ul id={panel} ref={box} className={styles.list} hidden={!open}>
        {messages.map((message) =>
          message.answer ? (
            <QuestionAndAnswer
              key={message.id}
              message={message}
              answer={message.answer}
              members={members}
              myHandle={myHandle}
              flash={flash === message.id}
            />
          ) : (
            <Message
              key={message.id}
              message={message}
              members={members}
              myHandle={myHandle}
              flash={flash === message.id}
            />
          ),
        )}
      </ul>
    </section>
  );
}
