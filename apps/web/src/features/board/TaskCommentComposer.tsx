import { TASK_COMMENT_MAX } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useAttachments, useCreateTaskComment, useDeleteAttachment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { t } from '../../i18n/t';
import { useContacts } from '../messages/useContacts';
import { codeMessage } from '../../lib/errors';
import { distinctMembers } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { MAIN_DRAFT, useCardCommentDraft, useCardDraftNotice } from './useCardCommentDraft';
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
}: TaskCommentComposerProps) {
  const { key } = useProject();
  const mutation = useCreateTaskComment(key);
  const draft = useCardCommentDraft(key, taskKey, slot);
  const text = draft.text;
  const files = draft.attachments;
  // Files moved here from the project manager's panel (PM-1305) are named from the card's own list.
  const attachmentList = useAttachments(key, taskKey, files.length > 0);
  const deleteFile = useDeleteAttachment(key, taskKey);
  const { notice, dismiss: dismissNotice } = useCardDraftNotice(key, taskKey);
  const showNotice = slot === MAIN_DRAFT ? notice : null;
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  // One line until the reader focuses it; the hint and the Send button follow, and stay while there is a draft.
  const [focused, setFocused] = useState(false);
  const open = focused || text !== '' || files.length > 0 || replyTo !== undefined;
  const textarea = useRef<HTMLTextAreaElement>(null);
  // One id per submission: a retry of the same text reuses it, so the server keeps one comment.
  const attempt = useRef<string | null>(null);
  const listId = useId();
  const contacts = useContacts();
  const sending = mutation.isPending;
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
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus]);

  const edit = (value: string) => {
    // New words are a new submission.
    attempt.current = null;
    if (mutation.isError) mutation.reset();
    dismissNotice();
    draft.setText(value);
  };
  // A file taken off the draft is deleted from the card, too: it was only ever there for this comment.
  const removeFile = (id: string) => {
    attempt.current = null;
    draft.setAttachments(files.filter((entry) => entry !== id));
    deleteFile.mutate(id);
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
  const submit = () => {
    const body = text.trim();
    if (!body || sending) return;
    const clientRequestId = (attempt.current ??= crypto.randomUUID());
    mutation.mutate(
      {
        taskKey,
        body: {
          text: body,
          clientRequestId,
          ...(replyTo ? { replyTo } : {}),
          ...(files.length ? { attachmentIds: files } : {}),
        },
      },
      {
        onSuccess: () => {
          attempt.current = null;
          dismissNotice();
          draft.clear();
          setMention(null);
          onPosted?.(clientRequestId);
          onCancel?.();
        },
      },
    );
  };
  const failure = mutation.isError
    ? isApiError(mutation.error) && codeMessage(mutation.error.code)
      ? codeMessage(mutation.error.code)
      : t('task.comments.sendFailed')
    : null;
  return (
    <form
      className={clsx(styles.composer, !open && styles.closed, replyTo !== undefined && styles.reply)}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextAreaField
        ref={textarea}
        label={label ?? t('task.comments.label')}
        hint={
          !open
            ? undefined
            : contacts.restricted
              ? t(noContacts ? 'task.comments.contactsHintNone' : 'task.comments.contactsHint')
              : t('task.comments.hint')
        }
        rows={open ? 3 : 1}
        maxLength={TASK_COMMENT_MAX}
        value={text}
        // Read-only, not disabled, while it is sent: the focus stays where the reader typed.
        readOnly={sending}
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
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setMention(null);
          setFocused(false);
        }}
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
            } else if (onCancel) {
              event.preventDefault();
              event.stopPropagation();
              onCancel();
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
      {files.length ? (
        <ul className={styles.files}>
          {files.map((id) => {
            const name = attachmentList.data?.attachments.find((entry) => entry.id === id)?.fileName ?? id;
            return (
              <li key={id} className={styles.file}>
                <span className={styles.fileName}>{name}</span>
                <button
                  type="button"
                  className={styles.fileRemove}
                  aria-label={t('task.comments.attachRemove', { name })}
                  disabled={sending}
                  onClick={() => removeFile(id)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
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
      {failure ? (
        <div role="alert" className={styles.failure}>
          <p>{failure}</p>
          <Button type="button" size="sm" variant="secondary" onClick={submit}>
            {t('task.comments.retry')}
          </Button>
        </div>
      ) : null}
      <p className={styles.live} aria-live="polite">
        {sending ? t('task.comments.sending') : ''}
      </p>
      {open ? (
        <div className={styles.actions}>
          <Button
            type="submit"
            // aria-disabled, not disabled: a second click is ignored without the button leaving the focus order.
            aria-disabled={sending || undefined}
            disabled={!sending && !text.trim()}
            loading={sending}
          >
            {t('common.send')}
          </Button>
          {onCancel ? (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('common.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
