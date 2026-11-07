import clsx from 'clsx';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { mentionPayloadOf } from '@projectman/shared';
import type { InboxItem, ResolveInboxRequest } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';
import { Button, ButtonLink } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { inboxItemDomId } from '../../lib/inbox';
import { nameOf } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';
import { TaskCommentComposer } from '../board/TaskCommentComposer';
import styles from './InboxCard.module.css';
import mentionStyles from './MentionInbox.module.css';

/** How much of the excerpt shows before "Teljes kivonat". */
const SHORT_EXCERPT = 240;

/** The short excerpt: the start of the text, or (when the mention is further in) the part around the mention. */
function shortExcerpt(text: string, handle: string | null): string {
  if (text.length <= SHORT_EXCERPT) return text;
  const at = handle ? text.toLowerCase().indexOf(`@${handle.toLowerCase()}`) : -1;
  const start = at > SHORT_EXCERPT - 80 ? Math.max(0, at - 60) : 0;
  return `${start > 0 ? '…' : ''}${text.slice(start, start + SHORT_EXCERPT).trimEnd()}…`;
}

export interface MentionInboxProps {
  item: InboxItem;
  members: MemberIndex;
  myHandle: string | null;
  /** The header row and the card row, built by the card the same way as for every other kind. */
  head: ReactNode;
  taskRow: ReactNode;
  Heading: 'h2' | 'h3';
  mobile: boolean;
  compact: boolean;
  /** "Láttam" is on its way to the server. */
  pending: boolean;
  /** Why the last "Láttam" failed; the item stays open. */
  error: string | null;
  /** The item closed while the viewer had a draft in it: it keeps its place as a notice. */
  closedWhileOpen: 'closed' | 'refused' | null;
  /** Only one reply box is open in the list. */
  replyOpen: boolean;
  onReplyOpenChange: (open: boolean) => void;
  /** The reply went out and the server closed the item. */
  onReplied: (item: InboxItem) => void;
  /** The reply is on its way to the server (true) or stopped: the list does not take the item for closed elsewhere. */
  onReplySending: (itemId: string, sending: boolean) => void;
  onResolve: (item: InboxItem, body: ResolveInboxRequest) => void;
  onDismissGone: () => void;
}

/**
 * A mention of the viewer in a card comment, reply or process note (PM-1276): who, where, the excerpt and
 * three actions: "Láttam" (closes it), "Válasz" (a reply under the comment, which closes it) and "Ugrás a
 * hozzászóláshoz" (the card, at the comment; it closes nothing).
 */
export function MentionInbox({
  item,
  members,
  myHandle,
  head,
  taskRow,
  Heading,
  mobile,
  compact,
  pending,
  error,
  closedWhileOpen,
  replyOpen,
  onReplyOpenChange,
  onReplied,
  onReplySending,
  onResolve,
  onDismissGone,
}: MentionInboxProps) {
  const { key, can } = useProject();
  const toast = useToast();
  const payload = mentionPayloadOf(item);
  const place = payload?.place ?? 'comment';
  const threadId = payload?.threadId ?? null;
  const open = item.state === 'open';
  const [expanded, setExpanded] = useState(false);
  const [sending, setSending] = useState(false);
  const replyButton = useRef<HTMLButtonElement>(null);
  const posted = useRef(false);
  const titleId = useId();
  const author = nameOf(item.source, members, myHandle);

  // The comment the mention stands in: a card that no longer shows it to this reader leaves only "Láttam".
  const source = useQuery({
    queryKey: [
      ...queryKeys.taskComments(item.projectKey, item.taskKey ?? ''),
      'mention-source',
      payload?.eventId,
    ],
    queryFn: () => api.taskComments(item.projectKey, item.taskKey!, { around: payload!.eventId }),
    enabled: open && place !== 'note' && !!item.taskKey && !!payload,
    retry: false,
    staleTime: 60_000,
  });
  const missing =
    source.isError &&
    isApiError(source.error) &&
    (source.error.status === 404 || source.error.status === 403);
  const canReply = can.comment && threadId !== null && !missing;
  const replying = open && replyOpen && canReply;

  const body = item.body ?? '';
  const short = shortExcerpt(body, myHandle);
  const jump =
    item.taskKey && payload
      ? `/p/${key}/tasks/${item.taskKey}#timeline-${payload.eventId}`
      : item.taskKey
        ? `/p/${key}/tasks/${item.taskKey}`
        : null;
  const size = mobile ? 'xl' : 'lg';
  const busy = pending || sending;

  const sendingChanged = useCallback(
    (value: boolean) => {
      setSending(value);
      onReplySending(item.id, value);
    },
    [item.id, onReplySending],
  );

  const closeReply = useCallback(() => {
    onReplyOpenChange(false);
    // A reply that went out leaves the item; the list moves the focus on. A cancelled one returns to its button.
    if (!posted.current) requestAnimationFrame(() => replyButton.current?.focus());
  }, [onReplyOpenChange]);

  const excerpt = body ? (
    <>
      <blockquote className={clsx(styles.preview, mentionStyles.excerpt)}>
        {expanded ? body : short}
      </blockquote>
      {short !== body ? (
        <Button
          variant="ghost"
          size="sm"
          className={mentionStyles.toggle}
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          {t(expanded ? 'inbox.mention.collapse' : 'inbox.mention.expand')}
        </Button>
      ) : null}
    </>
  ) : null;

  const composer = (hold: string | undefined) => (
    <section className={mentionStyles.reply} aria-labelledby={titleId}>
      <h3 id={titleId} className={mentionStyles.replyTitle}>
        {t('inbox.mention.replyTitle', { name: author })}
      </h3>
      <TaskCommentComposer
        key={item.id}
        taskKey={item.taskKey!}
        members={members}
        slot={item.id}
        replyTo={threadId!}
        label={t('inbox.mention.replyLabel')}
        hint={t('inbox.mention.replyHint')}
        submitLabel={t('inbox.mention.replySend')}
        failureText={t('inbox.mention.replyFailed')}
        holdReason={hold}
        autoFocus={!hold}
        onSendingChange={sendingChanged}
        onPosted={() => {
          posted.current = true;
          toast.show(t('inbox.mention.replied'), 'ok');
          onReplied(item);
        }}
        onCancel={hold ? undefined : closeReply}
      />
    </section>
  );

  const article = (children: ReactNode, gone = false) => (
    <article
      id={inboxItemDomId(item.id)}
      className={clsx(
        styles.card,
        gone && styles.gone,
        compact && styles.compact,
        mobile && [styles.mobile, mentionStyles.mobile],
      )}
      data-kind="mention"
    >
      {head}
      {taskRow}
      <Heading className={styles.title} tabIndex={-1} data-inbox-title="">
        {t(`inbox.mention.title.${place}`)}
      </Heading>
      {excerpt}
      {children}
    </article>
  );

  // Closed in another window while a draft was open: the card keeps its place and the draft, and says why.
  if (closedWhileOpen && !open) {
    const notice = t(
      item.resolution?.rule === 'mention_replied' ? 'inbox.mention.goneReplied' : 'inbox.mention.goneClosed',
    );
    return article(
      <>
        {item.taskKey && threadId !== null ? composer(notice) : <p role="status">{notice}</p>}
        <div className={styles.actions}>
          <Button variant="secondary" size={size} onClick={onDismissGone}>
            {t('inbox.closedWhileOpen.dismiss')}
          </Button>
        </div>
      </>,
      true,
    );
  }

  return article(
    <>
      {missing ? (
        <p className={mentionStyles.notice}>
          <strong>{t('inbox.mention.missing')}</strong> {t('inbox.mention.missingHint')}
        </p>
      ) : null}
      <div className={mentionStyles.actions}>
        <Button
          variant="primary"
          size={size}
          loading={pending}
          disabled={busy}
          onClick={() => onResolve(item, { optionId: 'seen' })}
        >
          {pending ? t('inbox.mention.closing') : t('inbox.mention.seen')}
        </Button>
        {canReply ? (
          <Button
            ref={replyButton}
            variant="secondary"
            size={size}
            disabled={busy}
            aria-expanded={replying}
            onClick={() => onReplyOpenChange(true)}
          >
            {t('inbox.mention.reply')}
          </Button>
        ) : null}
        {jump && !missing ? (
          <ButtonLink
            to={jump}
            variant="secondary"
            size={size}
            className={mentionStyles.jump}
            aria-disabled={busy || undefined}
            data-inbox-card-link=""
          >
            {t(place === 'note' ? 'inbox.mention.jumpNote' : 'inbox.mention.jump')}
          </ButtonLink>
        ) : null}
      </div>
      {replying ? composer(undefined) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </>,
  );
}
