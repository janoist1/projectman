import { TASK_COMMENT_MAX } from '@projectman/shared';
import clsx from 'clsx';
import { useEffect, useId, useRef, useState } from 'react';
import { isApiError } from '../../api/client';
import { useCreateTaskComment } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { t } from '../../i18n/t';
import { useContacts } from '../messages/useContacts';
import { codeMessage } from '../../lib/errors';
import { distinctMembers } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { MAIN_DRAFT, useCardCommentDraft } from './useCardCommentDraft';
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
}: TaskCommentComposerProps) {
  const { key } = useProject();
  const mutation = useCreateTaskComment(key);
  const draft = useCardCommentDraft(key, taskKey, slot);
  const text = draft.text;
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  // One line until the reader focuses it; the hint and the Send button follow, and stay while there is a draft.
  const [focused, setFocused] = useState(false);
  const open = focused || text !== '' || replyTo !== undefined;
  const textarea = useRef<HTMLTextAreaElement>(null);
  // One id per submission: a retry of the same text reuses it, so the server keeps one comment.
  const attempt = useRef<string | null>(null);
  const listId = useId();
  const contacts = useContacts();
  const sending = mutation.isPending;
  useEffect(() => onSendingChange?.(sending), [sending, onSendingChange]);
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
    draft.setText(value);
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
    if (!body || sending || holdReason) return;
    const clientRequestId = (attempt.current ??= crypto.randomUUID());
    // The promise, not the mutate callbacks: the host may drop this box while the server answers (the item the
    // box stands in can leave its list), and the callbacks of a box that is gone would never run.
    mutation
      .mutateAsync({ taskKey, body: { text: body, clientRequestId, ...(replyTo ? { replyTo } : {}) } })
      .then(
        () => {
          attempt.current = null;
          draft.clear();
          setMention(null);
          onPosted?.(clientRequestId);
          onCancel?.();
        },
        // The failure shows in the box (`mutation.isError`).
        () => undefined,
      );
  };
  const failure = mutation.isError
    ? isApiError(mutation.error) && codeMessage(mutation.error.code)
      ? codeMessage(mutation.error.code)
      : (failureText ?? t('task.comments.sendFailed'))
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
      {holdReason ? (
        <p role="status" className={styles.live}>
          {holdReason}
        </p>
      ) : null}
      {open ? (
        <div className={styles.actions}>
          <Button
            type="submit"
            // aria-disabled, not disabled: a second click is ignored without the button leaving the focus order.
            aria-disabled={sending || undefined}
            disabled={!sending && (!text.trim() || !!holdReason)}
            loading={sending}
          >
            {submitLabel ?? t('common.send')}
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
