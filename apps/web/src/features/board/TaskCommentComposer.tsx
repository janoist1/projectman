import { TASK_COMMENT_MAX, addedCommentMentions } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useCreateTaskComment, useEditTaskComment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { t } from '../../i18n/t';
import { useContacts } from '../messages/useContacts';
import { MessageAttachmentTray } from '../messages/MessageAttachmentTray';
import attachmentStyles from '../messages/MessageAttachments.module.css';
import { pasteHasText, pastedImages } from '../../lib/attachmentInput';
import { codeMessage } from '../../lib/errors';
import { useIsMobile } from '../../lib/hooks';
import { distinctMembers } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import {
  MAIN_DRAFT,
  useCardCommentDraft,
  useCardDraftFocus,
  useCardDraftNotice,
} from './useCardCommentDraft';
import { useCommentAttachmentUploads } from './useCommentAttachmentUploads';
import { useFileDrop } from './useFileDrop';
import styles from './TaskCommentComposer.module.css';

export interface TaskCommentComposerProps {
  taskKey: string;
  members: MemberIndex;
  /** The draft box: the main one, or the id of the comment this box answers. */
  slot?: string;
  /** The top-level comment this box answers (PM-1290); a reply is one level only. */
  replyTo?: string;
  /** The field's label; the main box says "Hozzászólás szövege", a reply box who it answers. */
  label?: string;
  /** Focus goes into the field when the box opens (a reply box). */
  autoFocus?: boolean;
  /** A reply box can be cancelled: the Mégse button and Esc. */
  onCancel?: () => void;
  /** The comment was posted; `clientRequestId` is the one it was sent with. */
  onPosted?: (clientRequestId: string) => void;
  /** Texts a host box (the reply of a mention in Rád vár, PM-1276) says in its own words. */
  hint?: string;
  submitLabel?: string;
  failureText?: string;
  /** Sending is held back (the text and the box stay), the reason shown above the buttons; a role=status line. */
  holdReason?: string;
  /** The box is sending (true) or stopped; a host disables its other actions meanwhile. */
  onSendingChange?: (sending: boolean) => void;
  /** Files can be attached (the 📎 button, the tray, paste and drop); a host box without them says false. */
  withFiles?: boolean;
  /**
   * The box edits the text of an existing comment instead of sending one (PM-1277): it opens with that text,
   * Save replaces Send, and the files are not touched. `baseRevision` is the version the edit builds on;
   * `earlierMentions` are the mentions of every version so far (who is notified is the difference).
   */
  editing?: {
    eventId: string;
    baseRevision: string;
    text: string;
    imported: boolean;
    hasFiles: boolean;
    earlierMentions: readonly string[];
  };
}

export function TaskCommentComposer({
  taskKey,
  members,
  slot = MAIN_DRAFT,
  replyTo,
  label,
  autoFocus,
  onCancel,
  onPosted,
  hint,
  submitLabel,
  failureText,
  holdReason,
  onSendingChange,
  withFiles = true,
  editing,
}: TaskCommentComposerProps) {
  const { key, myHandle } = useProject();
  const mutation = useCreateTaskComment(key);
  const editMutation = useEditTaskComment(key);
  const draft = useCardCommentDraft(key, taskKey, slot);
  const uploads = useCommentAttachmentUploads(key, taskKey, slot, draft);
  const files = uploads.items;
  // An edit box starts from the draft that outlived a reload, else from the comment's own text; the draft holds
  // only what differs from it. The version it builds on is the one it opened on, until a conflict names a newer.
  const [editText, setEditText] = useState(() => (draft.text !== '' ? draft.text : (editing?.text ?? '')));
  const [base, setBase] = useState(editing?.baseRevision ?? '');
  const text = editing ? editText : draft.text;
  const { notice, dismiss: dismissNotice } = useCardDraftNotice(key, taskKey);
  const showNotice = slot === MAIN_DRAFT ? notice : null;
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  // One line until the reader focuses it; the hint and the Send button follow, and stay while there is a draft.
  const [focused, setFocused] = useState(false);
  const open = focused || text !== '' || replyTo !== undefined || files.length > 0 || editing !== undefined;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  // One id per submission: a retry of the same text and files reuses it, so the server keeps one comment.
  const attempt = useRef<string | null>(null);
  const listId = useId();
  const contacts = useContacts();
  const sending = mutation.isPending || editMutation.isPending;
  useEffect(() => onSendingChange?.(sending), [sending, onSendingChange]);
  const isMobile = useIsMobile();
  const fileDrop = useFileDrop({
    allowed: !sending && !isMobile && withFiles,
    onFiles: (dropped) => addFiles(dropped),
    isolate: true,
  });
  const hasContent = text.trim() !== '' || files.length > 0;
  // A member who writes only to the contacts mentions only them (PM-985); the others get no notice anyway.
  const mentionable = distinctMembers(members).filter((member) => contacts.canWriteTo(member.handle));
  const noContacts = contacts.restricted && contacts.ready && mentionable.length === 0;
  const options = mention
    ? mentionable.filter(
        (member) =>
          member.handle.toLowerCase().includes(mention.query) ||
          member.displayName.toLowerCase().includes(mention.query),
      )
    : [];
  const active = Math.min(selected, Math.max(0, options.length - 1));

  useEffect(() => {
    const field = textarea.current;
    if (!autoFocus || !field) return;
    field.focus();
    // An edit box puts the cursor after the text it opens with.
    if (editing) field.setSelectionRange(field.value.length, field.value.length);
    // Only on opening: a later change of the comment must not move the cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus]);

  // A draft just moved here from the project manager's panel: the box takes the focus (nothing is sent).
  const { wanted: focusWanted, done: focusDone } = useCardDraftFocus(key, taskKey);
  useEffect(() => {
    if (slot !== MAIN_DRAFT || !focusWanted) return;
    textarea.current?.focus();
    focusDone();
  }, [slot, focusWanted, focusDone]);

  const edit = (value: string) => {
    // New words are a new submission.
    attempt.current = null;
    if (mutation.isError) mutation.reset();
    dismissNotice();
    if (!editing) return draft.setText(value);
    setEditText(value);
    if (value === editing.text) draft.clear();
    else draft.setText(value);
  };
  // The edit draft goes with the box, whether it is saved or given up (a reply draft stays on Cancel).
  const cancel = () => {
    if (editing) draft.clear();
    onCancel?.();
  };
  // New or removed files are a new submission too, as new words are.
  const changed = () => {
    attempt.current = null;
    if (mutation.isError) mutation.reset();
    dismissNotice();
  };
  const addFiles = (added: readonly File[]) => {
    if (sending || !added.length) return;
    changed();
    uploads.add(added);
  };
  const removeFile = async (id: number) => {
    const removed = await uploads.remove(id);
    if (removed) changed();
    return removed;
  };
  const updateMention = (value: string, caret: number) => {
    const match = /(?:^|[^\p{L}\p{N}_@.+-])@([\p{L}\p{N}-]*)$/u.exec(value.slice(0, caret));
    setMention(
      match ? { start: caret - match[1]!.length - 1, end: caret, query: match[1]!.toLowerCase() } : null,
    );
    setSelected(0);
  };
  const choose = (handle: string) => {
    if (!mention) return;
    const insertion = `@${handle} `;
    // Replace the rest of a token too when editing a mention in the middle of the text.
    const suffix = /^[a-z0-9-]*/i.exec(text.slice(mention.end))![0].length;
    const next = text.slice(0, mention.start) + insertion + text.slice(mention.end + suffix);
    if (next.length > TASK_COMMENT_MAX) return;
    edit(next);
    setMention(null);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(mention.start + insertion.length, mention.start + insertion.length);
    });
  };
  const saveEdit = () => {
    if (!editing || sending || saveBlocked) return;
    editMutation
      .mutateAsync({ taskKey, eventId: editing.eventId, body: { text: text.trim(), baseRevision: base } })
      .then(
        () => {
          draft.clear();
          setMention(null);
          onPosted?.(editing.eventId);
          onCancel?.();
        },
        (error: unknown) => {
          // The next Save builds on the version that won; the text stays as written.
          if (isApiError(error) && error.code === 'comment_edit_conflict') {
            const current = (error.details as { currentRevision?: unknown } | undefined)?.currentRevision;
            if (typeof current === 'string') setBase(current);
          }
          textarea.current?.focus();
        },
      );
  };
  const submit = () => {
    if (editing) return saveEdit();
    const body = text.trim();
    if (!hasContent || uploads.blockedReason || sending || holdReason) return;
    const attachmentIds = files.flatMap((item) => (item.attachment ? [item.attachment.id] : []));
    const clientRequestId = (attempt.current ??= crypto.randomUUID());
    // The promise, not the mutate callbacks: the host may drop this box while the server answers (the item the
    // box stands in can leave its list), and the callbacks of a box that is gone would never run.
    mutation
      .mutateAsync({
        taskKey,
        body: {
          text: body,
          clientRequestId,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(replyTo ? { replyTo } : {}),
        },
      })
      .then(
        () => {
          attempt.current = null;
          dismissNotice();
          uploads.clear();
          draft.clear();
          setMention(null);
          onPosted?.(clientRequestId);
          onCancel?.();
        },
        // The failure shows in the box (`mutation.isError`). A file the server no longer has is marked here: the
        // text and the other files stay.
        (error: unknown) => {
          if (isApiError(error) && error.code === 'comment_attachment_unavailable') {
            const id = (error.details as { id?: unknown } | undefined)?.id;
            if (typeof id === 'string') uploads.markGone(id);
          }
        },
      );
  };
  const failure = mutation.isError
    ? isApiError(mutation.error) && codeMessage(mutation.error.code)
      ? codeMessage(mutation.error.code)
      : (failureText ?? t(files.length ? 'task.comments.sendFailedFiles' : 'task.comments.sendFailed'))
    : null;
  // The tray row of the missing file says it, so the bar above (and its Retry, which would fail again) stays out.
  const fileGone =
    mutation.isError &&
    isApiError(mutation.error) &&
    mutation.error.code === 'comment_attachment_unavailable';
  // The host's hold and the files' block reason each stop Send.
  const sendBlocked = sending ? false : !hasContent || Boolean(uploads.blockedReason) || Boolean(holdReason);
  // Save waits while the text is the comment's own, or empty with no file left to carry the comment.
  const saveBlocked = sending
    ? false
    : text.trim() === (editing?.text ?? '').trim() || (text.trim() === '' && !editing?.hasFiles);
  const editFailure = editMutation.isError
    ? !isApiError(editMutation.error)
      ? 'saveFailed'
      : editMutation.error.code === 'comment_edit_conflict'
        ? 'editConflict'
        : editMutation.error.code === 'insufficient_access'
          ? 'editForbidden'
          : 'saveFailed'
    : null;
  // The editor lost the right to edit: the text stays readable (and copyable), nothing can be saved.
  const locked = editFailure === 'editForbidden';
  // Who a Save would newly notify (never for an imported comment): the shared rule, against every earlier version.
  const added =
    editing && !editing.imported
      ? addedCommentMentions({
          text,
          handles: mentionable.map((member) => member.handle),
          editor: myHandle,
          earlier: [editing.earlierMentions],
        })
      : [];
  return (
    <form
      className={clsx(
        styles.composer,
        !open && styles.closed,
        (replyTo !== undefined || editing) && styles.reply,
      )}
      data-comment-composer
      {...fileDrop.props}
      // The box stays open while the focus is anywhere in it (the field, then the 📎 button).
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
      onPaste={(event) => {
        // Pictures pasted into the box (its field or its buttons) are its files; pasted text stays text.
        if (!withFiles || pasteHasText(event.clipboardData)) return;
        const images = pastedImages(event.clipboardData);
        if (!images.length) return;
        event.preventDefault();
        event.stopPropagation();
        addFiles(images);
      }}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {fileDrop.state && !isMobile ? (
        <div className={attachmentStyles.drop} role="status">
          {t('attachments.dropActive')}
        </div>
      ) : null}
      <TextAreaField
        ref={textarea}
        label={label ?? t('task.comments.label')}
        hint={
          !open || editing
            ? undefined
            : hint
              ? hint
              : contacts.restricted
                ? t(noContacts ? 'task.comments.contactsHintNone' : 'task.comments.contactsHint')
                : t('task.comments.hint')
        }
        rows={open ? 3 : 1}
        maxLength={TASK_COMMENT_MAX}
        value={text}
        // Read-only, not disabled, while it is sent: the focus stays where the reader typed.
        readOnly={sending || locked}
        aria-autocomplete="list"
        aria-controls={options.length ? listId : undefined}
        aria-activedescendant={options.length ? `${listId}-${active}` : undefined}
        onChange={(event) => {
          edit(event.target.value);
          updateMention(event.target.value, event.target.selectionStart);
        }}
        onSelect={(event) => {
          if (document.activeElement === event.currentTarget)
            updateMention(event.currentTarget.value, event.currentTarget.selectionStart);
        }}
        onBlur={() => setMention(null)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !options.length) {
            event.preventDefault();
            submit();
            return;
          }
          if (event.key === 'Escape') {
            if (mention) {
              event.preventDefault();
              event.stopPropagation();
              setMention(null);
            } else if (onCancel && !(editing && sending)) {
              event.preventDefault();
              event.stopPropagation();
              cancel();
            }
            return;
          }
          if (!mention || !options.length) return;
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const index = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            setSelected(index);
            document.getElementById(`${listId}-${index}`)?.scrollIntoView?.({ block: 'nearest' });
          }
          if (event.key === 'Enter') {
            event.preventDefault();
            choose(options[active]!.handle);
          }
        }}
      />
      {showNotice ? (
        <p className={styles.notice} role="status">
          {t(showNotice === 'merged' ? 'task.comments.draftMerged' : 'task.comments.draftMoved')}
        </p>
      ) : null}
      {options.length ? (
        <ul id={listId} role="listbox" aria-label={t('task.comments.members')} className={styles.options}>
          {options.map((member, index) => (
            <li key={member.handle} id={`${listId}-${index}`} role="option" aria-selected={active === index}>
              <button
                type="button"
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(member.handle)}
              >
                {member.displayName} <span>@{member.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {added.length ? (
        <p className={styles.live} role="status">
          {t('task.comments.editMentions', { handles: added.map((handle) => `@${handle}`).join(', ') })}
        </p>
      ) : null}
      {editFailure ? (
        <p className={styles.failure} role="alert">
          {t(`task.comments.${editFailure}`)}
        </p>
      ) : null}
      {failure && !fileGone ? (
        <div role="alert" className={styles.failure}>
          <p>{failure}</p>
          <Button type="button" size="sm" variant="secondary" onClick={submit}>
            {t('task.comments.retry')}
          </Button>
        </div>
      ) : null}
      {withFiles ? (
        <MessageAttachmentTray
          comment
          label={t('task.comments.trayLabel')}
          items={files}
          onRemove={removeFile}
          onRetry={uploads.retry}
          focusInput={() => textarea.current?.focus()}
          disabled={sending}
        />
      ) : null}
      {files.length ? <p className={styles.fileNote}>{t('task.comments.fileVisibility')}</p> : null}
      {uploads.error ? (
        <p className={styles.fileNote} role="alert">
          {uploads.error}
        </p>
      ) : null}
      <p className={styles.live} aria-live="polite">
        {sending && !editing ? t('task.comments.sending') : ''}
      </p>
      {withFiles ? (
        <input
          type="file"
          multiple
          hidden
          ref={picker}
          aria-label={t('task.comments.inputLabel')}
          onChange={(event) => {
            addFiles(Array.from(event.target.files ?? []));
            event.target.value = '';
          }}
        />
      ) : null}
      {holdReason ? (
        <p role="status" className={styles.live}>
          {holdReason}
        </p>
      ) : null}
      {open ? (
        <div className={styles.actions}>
          {withFiles ? (
            <Button
              type="button"
              variant="secondary"
              icon="paperclip"
              className={styles.attach}
              aria-disabled={sending || undefined}
              title={t('task.comments.attachTitle')}
              aria-label={t('task.comments.attachLabel')}
              // A mouse press keeps the focus in the field, so the buttons do not vanish before the click lands.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                if (!sending) picker.current?.click();
              }}
            >
              <span className={styles.attachText}>{t('messageAttachments.add')}</span>
            </Button>
          ) : null}
          {/* Why Send waits sits between the buttons, in reach of the eye, not above the field. */}
          {uploads.blockedReason ? <p className={styles.status}>{uploads.blockedReason}</p> : null}
          {locked ? null : (
            <Button
              type="submit"
              // aria-disabled, not disabled: a second click is ignored without the button leaving the focus order.
              aria-disabled={sending || undefined}
              disabled={editing ? saveBlocked : sendBlocked}
              loading={sending}
            >
              {editing
                ? t(sending ? 'task.comments.saving' : 'task.comments.save')
                : (submitLabel ?? t('common.send'))}
            </Button>
          )}
          {onCancel ? (
            <Button
              type="button"
              variant={editing ? 'secondary' : 'ghost'}
              disabled={editing ? sending : undefined}
              onClick={cancel}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
