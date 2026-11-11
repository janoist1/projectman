import { canDeleteAttachment, canEditComment, mentionTokens, projectManagerAmong } from '@projectman/shared';
import type {
  CommentAttachmentRef,
  CommentRevision,
  TimelineEvent,
  TimelineEventData,
} from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useDeleteAttachment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { formatDate, formatStamp, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';
import { commentFiles } from '../../lib/commentFiles';
import { readStorage, writeStorage } from '../../lib/hooks';
import { actorByline, isOwnActor } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { AttachmentFiles } from '../messages/AttachmentFiles';
import { ProcessingLines } from '../messages/ProcessingLines';
import { useContacts } from '../messages/useContacts';
import { TaskCommentComposer } from './TaskCommentComposer';
import type { TaskCommentsState } from './useTaskComments';
import {
  editDraftSlot,
  editDraftSlots,
  replyDraftSlots,
  useCardCommentDraft,
  useCardDraftNotice,
} from './useCardCommentDraft';
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

/** A comment's files, under its text; deleting one is the uploader's (or an owner's or admin's) and leaves a "deleted" tile. */
function CommentFiles({
  event,
  taskKey,
  files,
}: {
  event: TimelineEvent;
  taskKey: string;
  files: readonly CommentAttachmentRef[];
}) {
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const remove = useDeleteAttachment(key, taskKey);
  return (
    <AttachmentFiles
      files={files.map((file) => ({ ...file, gone: Boolean(file.gone) }))}
      projectKey={key}
      taskKey={taskKey}
      canDelete={Boolean(
        access && myHandle && canDeleteAttachment({ access, handle: myHandle }, { uploadedBy: event.actor }),
      )}
      onDelete={(id) => remove.mutateAsync(id)}
      deleteConfirmKey="messageAttachments.commentDeleteConfirm"
      focusFallback={() => document.querySelector<HTMLElement>('[data-comment-composer] textarea')}
    />
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

/**
 * The "edited" mark in the header (PM-1277), for everyone. Whoever may read the earlier versions (the server
 * sent `revisions`) gets a button that opens them under the text; the others a plain word.
 */
function EditedMark({
  event,
  members,
  myHandle,
  imported,
  open,
  historyId,
  onToggle,
}: {
  event: TimelineEvent;
  members: MemberIndex;
  myHandle: string | null;
  imported: boolean;
  open: boolean;
  historyId: string;
  onToggle: () => void;
}) {
  const edited = event.data.edited as TimelineEventData['task_note']['edited'];
  if (!edited) return null;
  // Not the author who edited (an imported comment, edited by an owner or an admin): the editor is named.
  const byAuthor = !imported && edited.actor.handle === event.actor.handle;
  const label = byAuthor
    ? t('task.comments.edited')
    : isOwnActor(edited.actor, myHandle)
      ? t('task.comments.editedByMe')
      : t('task.comments.editedBy', { name: actorByline(edited.actor, members, myHandle) });
  const title = t('task.comments.editedTitle', { time: fullStamp(edited.at) });
  return event.data.revisions ? (
    <button
      type="button"
      className={styles.editedButton}
      title={title}
      aria-label={t('task.comments.editedAria', { label })}
      aria-expanded={open}
      aria-controls={historyId}
      onClick={onToggle}
    >
      {label}
    </button>
  ) : (
    <span className={styles.edited} title={title}>
      {label}
    </span>
  );
}

/** The earlier versions of a comment, newest first, the original last; only what the server sent. */
function CommentHistory({
  event,
  members,
  myHandle,
  id,
}: {
  event: TimelineEvent;
  members: MemberIndex;
  myHandle: string | null;
  id: string;
}) {
  const revisions = (event.data.revisions ?? []) as CommentRevision[];
  return (
    <div id={id} className={styles.history}>
      <p className={styles.historyTitle}>{t('task.comments.history')}</p>
      <ol className={styles.revisions}>
        {revisions.map((revision) => (
          <li key={revision.id}>
            <span className={styles.revisionMeta}>
              {revision.original ? `${t('task.comments.original')} · ` : null}
              <time dateTime={revision.at} title={fullStamp(revision.at)}>
                {formatStamp(revision.at)}
              </time>
              {!revision.original && revision.actor.handle !== event.actor.handle
                ? ` · ${actorByline(revision.actor, members, myHandle)}`
                : null}
            </span>
            <p className={styles.revisionText}>
              <MentionedText value={revision.text} members={members} />
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function CommentEntry({
  event,
  taskKey,
  members,
  myHandle,
  posted,
  saved,
  editing,
  onEdit,
  onCloseEdit,
  onSaved,
  registerEdit,
  onReply,
  registerReply,
  status,
}: {
  event: TimelineEvent;
  taskKey: string;
  members: MemberIndex;
  myHandle: string | null;
  /** The comment was sent from this view since it opened. */
  posted: boolean;
  /** The comment was edited from this view since it opened (the "Mentve" line). */
  saved: boolean;
  /** The comment's text is being edited here: the box takes the place of the text. */
  editing: boolean;
  /** The "Szerkesztés" button's action; missing when the viewer may not edit, or another edit is open. */
  onEdit?: () => void;
  onCloseEdit: () => void;
  onSaved: () => void;
  registerEdit: (button: HTMLButtonElement | null) => void;
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
  const files = commentFiles(event);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = `history-${event.id}`;
  // The box opened (also after a reload) comes whole into view, as a reply box does.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (editing) box.current?.scrollIntoView?.({ block: 'nearest' });
  }, [editing]);
  const revisions = (event.data.revisions ?? []) as CommentRevision[];
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
        <EditedMark
          event={event}
          members={members}
          myHandle={myHandle}
          imported={imported}
          open={historyOpen}
          historyId={historyId}
          onToggle={() => setHistoryOpen((open) => !open)}
        />
      </p>
      {editing ? (
        <div ref={box}>
          <TaskCommentComposer
            taskKey={taskKey}
            members={members}
            slot={editDraftSlot(event.id)}
            label={own ? t('task.comments.editLabel') : t('task.comments.editLabelOther')}
            autoFocus
            withFiles={false}
            onCancel={onCloseEdit}
            onPosted={onSaved}
            editing={{
              eventId: event.id,
              baseRevision:
                (event.data.edited as TimelineEventData['task_note']['edited'])?.revisionId ?? event.id,
              text: text(event.data.text),
              imported,
              hasFiles: files.some((file) => !file.gone),
              earlierMentions: [
                ...((event.data.mentions as string[] | undefined) ?? []),
                ...revisions.flatMap((revision) => revision.mentions),
              ],
            }}
          />
        </div>
      ) : text(event.data.text) !== '' ? (
        <p className={styles.body}>
          <MentionedText value={text(event.data.text)} members={members} />
        </p>
      ) : null}
      {historyOpen && revisions.length ? (
        <CommentHistory event={event} members={members} myHandle={myHandle} id={historyId} />
      ) : null}
      {files.length ? (
        <div className={styles.files}>
          <CommentFiles event={event} taskKey={taskKey} files={files} />
        </div>
      ) : null}
      {posted ? (
        <p className={styles.posted} aria-live="polite">
          {t('task.comments.posted')}
        </p>
      ) : null}
      {saved && !editing ? (
        <p className={styles.posted} aria-live="polite">
          {t('task.comments.saved')}
        </p>
      ) : null}
      {status}
      {onReply && !editing ? (
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
      {onEdit && !editing ? (
        <button
          type="button"
          ref={registerEdit}
          className={styles.replyButton}
          aria-label={own ? t('task.comments.editAria') : t('task.comments.editAriaOther', { name: author })}
          onClick={onEdit}
        >
          {t('task.comments.edit')}
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
  const { key, me, myHandle } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const contacts = useContacts();
  const log = useRef<HTMLDivElement>(null);
  const replyButtons = useRef(new Map<string, HTMLButtonElement>());
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const [reply, setReply] = useState<ReplyBox | null>(null);
  // The comment whose text is being edited: one at a time (PM-1277).
  const [editing, setEditing] = useState<string | null>(null);
  // The comments sent from this view since it opened: they get the "Posted" line; the edited ones "Saved".
  const [posted, setPosted] = useState<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = useState<ReadonlySet<string>>(new Set());
  const { threads } = state;
  const canEdit = (event: TimelineEvent) =>
    Boolean(access && myHandle && canEditComment({ access, handle: myHandle }, event));

  // A reply or an edit box with a draft opens again after a reload or a change of the view.
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
    const editSlots = editDraftSlots(projectKey, taskKey);
    const entry = threads
      .flatMap((item) => [item.comment, ...item.replies])
      .find((event) => editSlots.includes(event.id) && canEdit(event));
    if (entry) setEditing(entry.id);
    // `canEdit` reads the same inputs as the dependencies below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threads, projectKey, taskKey, members, myHandle, access]);

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

  const closeEdit = () => {
    const entryId = editing;
    setEditing(null);
    // The "Szerkesztés" button is back after the box closes: the focus goes to it, after a save or a cancel.
    if (entryId) requestAnimationFrame(() => editButtons.current.get(entryId)?.focus());
  };

  // Whom the reader is told to mention: the project manager, or for a client the contact they may write to.
  const ask = contacts.restricted
    ? (contacts.recipients.find((handle) => handle === contacts.manager) ?? contacts.recipients[0] ?? null)
    : (contacts.manager ?? projectManagerAmong(members.values())?.handle ?? null);

  const entryProps = (event: TimelineEvent, parentId: string) => ({
    event,
    taskKey,
    members,
    myHandle,
    posted: posted.has(text(event.data.clientRequestId)),
    saved: saved.has(event.id),
    editing: editing === event.id,
    onCloseEdit: closeEdit,
    onSaved: () => setSaved((current) => new Set(current).add(event.id)),
    registerEdit: (button: HTMLButtonElement | null) => {
      if (button) editButtons.current.set(event.id, button);
      else editButtons.current.delete(event.id);
    },
    registerReply: (button: HTMLButtonElement | null) => {
      if (button) replyButtons.current.set(event.id, button);
      else replyButtons.current.delete(event.id);
    },
    // Only one box is edited at a time: while it is open the other "Szerkesztés" buttons are gone.
    ...(editing === null && canEdit(event)
      ? {
          onEdit: () => {
            setSaved((current) => {
              const next = new Set(current);
              next.delete(event.id);
              return next;
            });
            setEditing(event.id);
          },
        }
      : {}),
    // The comment being edited has no "Válasz" meanwhile.
    ...(canComment && editing !== event.id
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
