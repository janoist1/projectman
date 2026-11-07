import { mentionTokens, projectManagerAmong } from '@projectman/shared';
import type { TimelineEvent } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { formatDate, formatStamp, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { readStorage, writeStorage } from '../../lib/hooks';
import { actorByline, isOwnActor } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { ProcessingLines } from '../messages/ProcessingLines';
import { useContacts } from '../messages/useContacts';
import { TaskCommentComposer } from './TaskCommentComposer';
import type { TaskCommentsState } from './useTaskComments';
import { replyDraftSlots, useCardCommentDraft, useCardDraftNotice } from './useCardCommentDraft';
import styles from './TaskComments.module.css';

/** How long the comment a link led to stays highlighted. */
const HIGHLIGHT_MS = 2000;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** The full time, with the year, for the `title` of a short time. */
const fullStamp = (value: string) => `${formatDate(value, new Date(0))} ${formatTime(value)}`;

/** Who wrote a comment: the original author of an imported one, otherwise the actor; `own` only for the latter. */
function commentAuthor(event: TimelineEvent, members: MemberIndex, myHandle: string | null) {
  const importedAuthor = text(event.data.importedAuthor);
  if (importedAuthor !== '') return { name: importedAuthor, own: false };
  return { name: actorByline(event.actor, members, myHandle), own: isOwnActor(event.actor, myHandle) };
}

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
  /** The comment answered is the viewer's own: the box does not name them. */
  own: boolean;
}

function CommentEntry({
  event,
  members,
  myHandle,
  posted,
  onReply,
  registerReply,
  status,
}: {
  event: TimelineEvent;
  members: MemberIndex;
  myHandle: string | null;
  /** The comment was sent from this view since it opened. */
  posted: boolean;
  onReply?: (name: string, own: boolean) => void;
  registerReply: (button: HTMLButtonElement | null) => void;
  /** The recipients' processing status lines (PM-1305), under the text. */
  status?: ReactNode;
}) {
  const importedAuthor = text(event.data.importedAuthor);
  const importedAt = text(event.data.importedAt);
  const imported = importedAuthor !== '' || importedAt !== '';
  const at = importedAt || event.createdAt;
  const { name: author, own } = commentAuthor(event, members, myHandle);
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
      {status}
      {onReply ? (
        <button
          type="button"
          ref={registerReply}
          className={styles.replyButton}
          aria-label={own ? t('task.comments.replyAriaOwn') : t('task.comments.replyAria', { name: author })}
          onClick={() => onReply(author, own)}
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
  eventHref,
}: {
  projectKey: string;
  taskKey: string;
  members: MemberIndex;
  state: TaskCommentsState;
  active: boolean;
  /** The comment (or reply) a link points at: the view opens around it and highlights it. */
  target: string | null;
  canComment: boolean;
  /** Where a link to one comment of the card leads (the `around` jump of the view). */
  eventHref?: ((eventId: string) => string) | null;
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
        ...commentAuthor(thread.comment, members, myHandle),
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
  const framed = useRef<{ row: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);
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
    framed.current = { row, timer: setTimeout(() => row.classList.remove(styles.flash!), HIGHLIGHT_MS) };
  }, [active, target, found, threads]);
  // The frame outlives the list updates that follow the jump; it ends with its time or with the link.
  useEffect(
    () => () => {
      if (!framed.current) return;
      clearTimeout(framed.current.timer);
      framed.current.row.classList.remove(styles.flash!);
      framed.current = null;
    },
    [target],
  );

  // A box the reader opened comes whole into view (the list ends above the pinned box): the buttons included.
  const replyBox = useRef<HTMLLIElement>(null);
  const revealReply = useRef(false);
  useEffect(() => {
    if (!reply || !revealReply.current) return;
    revealReply.current = false;
    replyBox.current?.scrollIntoView?.({ block: 'nearest' });
  }, [reply]);

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
          onReply: (name: string, own: boolean) => {
            revealReply.current = true;
            setReply({ entryId: event.id, parentId, name, own });
          },
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
          {threads.map(({ comment, replies, processing }) => (
            <li key={comment.id} id={`timeline-${comment.id}`} tabIndex={-1} className={styles.thread}>
              <CommentEntry
                {...entryProps(comment, comment.id)}
                status={
                  processing && processing.length > 0 ? (
                    <ProcessingLines
                      items={processing}
                      members={members}
                      myHandle={myHandle}
                      className={styles.status}
                      reply={(view, handle) =>
                        'eventId' in view ? (
                          eventHref ? (
                            <Link className={styles.replyLink} to={eventHref(view.eventId)}>
                              {t('processing.openReply')}
                            </Link>
                          ) : null
                        ) : isOwnActor(comment.actor, myHandle) ? (
                          // A direct answer is a message to the author: their conversation with the recipient.
                          <Link className={styles.replyLink} to={`/p/${projectKey}/messages/with/${handle}`}>
                            {t('processing.openReply')}
                          </Link>
                        ) : (
                          <span>{t('processing.replyUnavailable')}</span>
                        )
                      }
                    />
                  ) : undefined
                }
              />
              {replies.length > 0 || reply?.parentId === comment.id ? (
                <ol className={styles.replies}>
                  {replies.map((entry) => (
                    <li key={entry.id} id={`timeline-${entry.id}`} tabIndex={-1}>
                      <CommentEntry {...entryProps(entry, comment.id)} />
                    </li>
                  ))}
                  {reply?.parentId === comment.id ? (
                    <li ref={replyBox} className={styles.replyBox}>
                      <TaskCommentComposer
                        key={comment.id}
                        taskKey={taskKey}
                        members={members}
                        slot={comment.id}
                        replyTo={comment.id}
                        label={
                          reply.own
                            ? t('task.comments.replyingToOwn')
                            : t('task.comments.replyingTo', { name: reply.name })
                        }
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

  // The first-use tip at the box is dismissed once per account.
  const tipKey = `commentTip.dismissed.${myHandle ?? ''}`;
  const [tipDismissed, setTipDismissed] = useState(() => readStorage(tipKey) === '1');
  // It shows only over a box nobody has touched: not with text, a file or a moved-draft notice in it (the CSS
  // hides it while the box has focus), so a phone keeps its room for the comments.
  const mainDraft = useCardCommentDraft(projectKey, taskKey);
  const { notice: draftNotice } = useCardDraftNotice(projectKey, taskKey);
  const boxUntouched = mainDraft.text === '' && mainDraft.attachments.length === 0 && !draftNotice;

  return (
    <div className={styles.panel}>
      <p className={styles.visibility}>{t('task.comments.visibility')}</p>
      <div ref={log} className={styles.log}>
        {body}
      </div>
      <div className={styles.composer}>
        {canComment && myHandle ? (
          <div className={styles.composerColumn}>
            {ask && !tipDismissed && boxUntouched ? (
              <p className={styles.tip}>
                <span>{t('task.comments.tip', { handle: ask })}</span>
                <button
                  type="button"
                  className={styles.tipDismiss}
                  aria-label={t('task.comments.tipDismiss')}
                  title={t('task.comments.tipDismiss')}
                  onClick={() => {
                    writeStorage(tipKey, '1');
                    setTipDismissed(true);
                  }}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </p>
            ) : null}
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
