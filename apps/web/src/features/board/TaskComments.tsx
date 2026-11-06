import { mentionTokens, projectManagerAmong } from '@projectman/shared';
import type { TimelineEvent } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { formatDate, formatStamp, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { actorByline, isOwnActor } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { useContacts } from '../messages/useContacts';
import { TaskCommentComposer } from './TaskCommentComposer';
import type { TaskCommentsState } from './useTaskComments';
import { replyDraftSlots } from './useCardCommentDraft';
import styles from './TaskComments.module.css';

/** How long the comment a link led to stays highlighted. */
const HIGHLIGHT_MS = 2000;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The full time, with the year, for the `title` of a short time. */
const fullStamp = (value: string) => `${formatDate(value, new Date(0))} ${formatTime(value)}`;

function MentionedText({ value, members }: { value: string; members: MemberIndex }) {
  let end = 0;
  const parts = mentionTokens(value).flatMap((token) => {
    const member = members.get(token.handle);
    if (!member) return [];
    const before = value.slice(end, token.start);
    end = token.end;
    return [
      before,
      <span key={token.start} className={styles.mention} title={member.displayName}>
        {value.slice(token.start, token.end)}
      </span>,
    ];
  });
  return (
    <>
      {parts}
      {value.slice(end)}
    </>
  );
}

interface ReplyBox {
  /** The entry whose "Válasz" button opened the box (focus returns to it). */
  entryId: string;
  /** The top-level comment the answer goes under: a reply to a reply goes under the same parent. */
  parentId: string;
  name: string;
}

function CommentEntry({
  event,
  members,
  myHandle,
  posted,
  onReply,
  registerReply,
}: {
  event: TimelineEvent;
  members: MemberIndex;
  myHandle: string | null;
  /** The comment was sent from this view since it opened. */
  posted: boolean;
  onReply?: (name: string) => void;
  registerReply: (button: HTMLButtonElement | null) => void;
}) {
  const importedAuthor = text(event.data.importedAuthor);
  const importedAt = text(event.data.importedAt);
  const imported = importedAuthor !== '' || importedAt !== '';
  const at = importedAt || event.createdAt;
  const author = importedAuthor !== '' ? importedAuthor : actorByline(event.actor, members, myHandle);
  const own = isOwnActor(event.actor, myHandle);
  return (
    <div className={clsx(styles.entry, own && styles.own)}>
      <p className={styles.head}>
        <span className={styles.author}>{author}</span>
        <span aria-hidden="true"> · </span>
        <time dateTime={at} title={fullStamp(at)}>
          {formatStamp(at)}
        </time>
        {imported ? (
          <span
            className={styles.imported}
            title={t('task.comments.importedTitle', { time: fullStamp(event.createdAt) })}
          >
            {t('task.comments.imported')}
          </span>
        ) : null}
      </p>
      <p className={styles.body}>
        <MentionedText value={text(event.data.text)} members={members} />
      </p>
      {posted ? (
        <p className={styles.posted} aria-live="polite">
          {t('task.comments.posted')}
        </p>
      ) : null}
      {onReply ? (
        <button
          type="button"
          ref={registerReply}
          className={styles.replyButton}
          aria-label={t('task.comments.replyAria', { name: author })}
          onClick={() => onReply(author)}
        >
          {t('task.comments.reply')}
        </button>
      ) : null}
    </div>
  );
}

/** The Comments view (PM-1290): the card's comments in one column, a reply one level under its comment. */
export function TaskComments({
  projectKey,
  taskKey,
  members,
  state,
  active,
  target,
  canComment,
}: {
  projectKey: string;
  taskKey: string;
  members: MemberIndex;
  state: TaskCommentsState;
  active: boolean;
  /** The comment (or reply) a link points at: the view opens around it and highlights it. */
  target: string | null;
  canComment: boolean;
}) {
  const { myHandle } = useProject();
  const contacts = useContacts();
  const log = useRef<HTMLDivElement>(null);
  const replyButtons = useRef(new Map<string, HTMLButtonElement>());
  const [reply, setReply] = useState<ReplyBox | null>(null);
  // The comments sent from this view since it opened: they get the "Posted" line.
  const [posted, setPosted] = useState<ReadonlySet<string>>(new Set());
  const { threads } = state;

  // A reply box with a draft opens again after a reload or a change of the view.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || threads.length === 0) return;
    restored.current = true;
    const draftSlots = replyDraftSlots(projectKey, taskKey);
    const thread = threads.find((item) => draftSlots.includes(item.comment.id));
    if (thread)
      setReply({
        entryId: thread.comment.id,
        parentId: thread.comment.id,
        name: actorByline(thread.comment.actor, members, myHandle),
      });
  }, [threads, projectKey, taskKey, members, myHandle]);

  // The list opens at its end (the newest comment) unless a link points at one; a view shown again does too.
  const openedAtEnd = useRef(false);
  useLayoutEffect(() => {
    if (!active) {
      openedAtEnd.current = false;
      return;
    }
    const box = log.current;
    if (!box || state.isPending || (target && !state.missing) || openedAtEnd.current) return;
    openedAtEnd.current = true;
    box.scrollTop = box.scrollHeight;
  }, [active, state.isPending, state.missing, target]);

  // Older comments load above: what the reader looks at keeps its place.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const loadOlder = () => {
    const box = log.current;
    if (box) anchor.current = { height: box.scrollHeight, top: box.scrollTop };
    void state.loadOlder();
  };
  useLayoutEffect(() => {
    const box = log.current;
    if (!box || !anchor.current || state.loadingMore === 'older') return;
    box.scrollTop = anchor.current.top + (box.scrollHeight - anchor.current.height);
    anchor.current = null;
  }, [threads, state.loadingMore]);

  // The comment a link led to: scrolled to the middle, focused and framed for a moment.
  const reached = useRef<string | null>(null);
  const found =
    target !== null &&
    threads.some((item) => item.comment.id === target || item.replies.some((entry) => entry.id === target));
  useEffect(() => {
    if (!active || !target || !found || reached.current === target) return;
    const row = document.getElementById(`timeline-${target}`);
    if (!row) return;
    reached.current = target;
    row.scrollIntoView?.({
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
      block: 'center',
    });
    row.focus({ preventScroll: true });
    row.classList.add(styles.flash!);
    const timer = setTimeout(() => row.classList.remove(styles.flash!), HIGHLIGHT_MS);
    return () => {
      clearTimeout(timer);
      row.classList.remove(styles.flash!);
    };
  }, [active, target, found, threads]);

  const closeReply = () => {
    const entryId = reply?.entryId;
    setReply(null);
    // The "Válasz" button is back after the box closes: the focus goes to it.
    if (entryId) requestAnimationFrame(() => replyButtons.current.get(entryId)?.focus());
  };

  // Whom the reader is told to mention: the project manager, or for a client the contact they may write to.
  const ask = contacts.restricted
    ? (contacts.recipients.find((handle) => handle === contacts.manager) ?? contacts.recipients[0] ?? null)
    : (contacts.manager ?? projectManagerAmong(members.values())?.handle ?? null);

  const entryProps = (event: TimelineEvent, parentId: string) => ({
    event,
    members,
    myHandle,
    posted: posted.has(text(event.data.clientRequestId)),
    registerReply: (button: HTMLButtonElement | null) => {
      if (button) replyButtons.current.set(event.id, button);
      else replyButtons.current.delete(event.id);
    },
    ...(canComment
      ? {
          onReply: (name: string) => setReply({ entryId: event.id, parentId, name }),
        }
      : {}),
  });

  const body = state.isPending ? (
    <div className={styles.skeleton} role="status">
      <span className={styles.srOnly}>{t('app.loading')}</span>
      {[0, 1, 2].map((row) => (
        <span key={row} className={styles.skeletonRow} aria-hidden="true" />
      ))}
    </div>
  ) : state.isError && threads.length === 0 ? (
    <div className={styles.failure} role="alert">
      <p>{t('task.comments.loadFailed')}</p>
      <Button size="sm" onClick={state.refetch}>
        {t('task.comments.retry')}
      </Button>
    </div>
  ) : (
    <>
      {state.refreshFailed ? <p className={styles.stale}>{t('task.comments.refreshFailed')}</p> : null}
      {state.hasOlder ? (
        <div className={styles.more}>
          <Button size="sm" variant="secondary" loading={state.loadingMore === 'older'} onClick={loadOlder}>
            {t('task.comments.older')}
          </Button>
        </div>
      ) : null}
      {state.missing ? <p className={styles.notice}>{t('task.comments.unavailable')}</p> : null}
      {threads.length === 0 ? (
        <p className={styles.empty}>{t('task.comments.empty')}</p>
      ) : (
        <ol className={styles.list} aria-label={t('task.view.thread')}>
          {threads.map(({ comment, replies }) => (
            <li key={comment.id} id={`timeline-${comment.id}`} tabIndex={-1} className={styles.thread}>
              <CommentEntry {...entryProps(comment, comment.id)} />
              {replies.length > 0 || reply?.parentId === comment.id ? (
                <ol className={styles.replies}>
                  {replies.map((entry) => (
                    <li key={entry.id} id={`timeline-${entry.id}`} tabIndex={-1}>
                      <CommentEntry {...entryProps(entry, comment.id)} />
                    </li>
                  ))}
                  {reply?.parentId === comment.id ? (
                    <li className={styles.replyBox}>
                      <TaskCommentComposer
                        key={comment.id}
                        taskKey={taskKey}
                        members={members}
                        slot={comment.id}
                        replyTo={comment.id}
                        label={t('task.comments.replyingTo', { name: reply.name })}
                        autoFocus
                        onCancel={closeReply}
                        onPosted={(id) => setPosted((current) => new Set(current).add(id))}
                      />
                    </li>
                  ) : null}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {state.moreError ? (
        <p className={styles.stale} role="alert">
          {t('task.comments.loadFailed')}
        </p>
      ) : null}
      {state.hasNewer ? (
        <div className={styles.more}>
          <Button
            size="sm"
            variant="secondary"
            loading={state.loadingMore === 'newer'}
            onClick={() => void state.loadNewer()}
          >
            {t('task.comments.newer')}
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <div className={styles.panel}>
      <p className={styles.visibility}>
        {ask ? t('task.comments.visibilityAsk', { handle: ask }) : t('task.comments.visibility')}
      </p>
      <div ref={log} className={styles.log}>
        {body}
      </div>
      <div className={styles.composer}>
        {canComment && myHandle ? (
          <div className={styles.composerColumn}>
            <TaskCommentComposer
              key={`comments:${taskKey}`}
              taskKey={taskKey}
              members={members}
              onPosted={(id) => {
                setPosted((current) => new Set(current).add(id));
                // The new comment is at the end of the list: the reader's own words come into view.
                requestAnimationFrame(() => {
                  const box = log.current;
                  if (box) box.scrollTop = box.scrollHeight;
                });
              }}
            />
          </div>
        ) : (
          <p className={styles.readOnly}>{t('task.comments.readOnly')}</p>
        )}
      </div>
    </div>
  );
}
