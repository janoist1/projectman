import { useEffect, useRef, useState } from 'preact/hooks';
import type { FeedbackCardRef, FeedbackMarkView, FeedbackThreadEntry } from '@projectman/shared';
import { MAX_BODY } from '../controller';
import type { Controller, State } from '../controller';
import { t } from '../i18n';
import { messageTime, relativeTime } from '../time';
import { Avatar, StatusLabel, colorVar, personName } from './common';

function CardLine({ card }: { card: FeedbackCardRef }) {
  return (
    <p class="card-line">
      {t('thread.cardLine', { key: card.key, title: card.title, stage: card.stageName })}
    </p>
  );
}

function Message({ entry, now }: { entry: FeedbackThreadEntry; now: number }) {
  const event = entry.type !== 'comment';
  return (
    <li class={`msg${event ? ' event' : ''}`}>
      <Avatar person={entry.actor} />
      <div class="msg-main">
        <p class="msg-meta">
          <b>{personName(entry.actor)}</b>
          <time dateTime={entry.createdAt}>{messageTime(entry.createdAt, now)}</time>
        </p>
        {event && (
          <p class="msg-event">{t(`thread.event.${entry.type as Exclude<typeof entry.type, 'comment'>}`)}</p>
        )}
        {entry.body && <p class="msg-body">{entry.body}</p>}
        {entry.card && <CardLine card={entry.card} />}
      </div>
    </li>
  );
}

function Reply({
  controller,
  markId,
  sending,
  error,
}: {
  controller: Controller;
  markId: string;
  sending: boolean;
  error: boolean;
}) {
  const [text, setText] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const over = text.length > MAX_BODY;
  const send = async (): Promise<void> => {
    if (over) {
      field.current?.focus();
      return;
    }
    if (await controller.sendComment(markId, text)) setText('');
  };
  return (
    <form
      class="reply"
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      <textarea
        ref={field}
        class={`field${over ? ' bad' : ''}`}
        rows={2}
        value={text}
        placeholder={t('thread.reply')}
        aria-label={t('thread.replyAria')}
        aria-invalid={over ? 'true' : undefined}
        onInput={(event) => setText((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            void send();
          }
        }}
      />
      {error && (
        <p class="err" role="alert">
          {t('thread.sendError')}
        </p>
      )}
      <button type="submit" class="btn primary" disabled={sending || text.trim() === ''}>
        {t(sending ? 'thread.sending' : error ? 'thread.retry' : 'thread.send')}
      </button>
    </form>
  );
}

/** Asks before deleting a mark; it takes the place of the reply field. Esc is handled by the controller. */
function DeleteConfirm({
  controller,
  mark,
  own,
  deleting,
  error,
}: {
  controller: Controller;
  mark: FeedbackMarkView;
  own: boolean;
  deleting: boolean;
  error: boolean;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);
  const labelId = `del-${mark.id}`;
  return (
    <div class="del-confirm" role="group" aria-labelledby={labelId}>
      <p id={labelId} class="del-ask">
        {own ? t('thread.deleteAsk') : t('thread.deleteAskOf', { name: personName(mark.author) })}
      </p>
      <p class="del-info">
        {t('thread.deleteInfo')}
        {mark.card ? ` ${t('thread.deleteKeepsCard', { key: mark.card.key })}` : ''}
      </p>
      {error && (
        <p class="err" role="alert">
          {t('thread.deleteError')}
        </p>
      )}
      <div class="del-actions">
        <button
          ref={cancel}
          type="button"
          class="btn ghost"
          disabled={deleting}
          onClick={() => controller.askDelete(mark.id, false)}
        >
          {t('new.cancel')}
        </button>
        <button
          type="button"
          class="btn danger"
          disabled={deleting}
          onClick={() => void controller.deleteMark(mark.id)}
        >
          {t(deleting ? 'thread.deleting' : error ? 'thread.retry' : 'thread.deleteConfirm')}
        </button>
      </div>
    </div>
  );
}

/** A mark's conversation: its own text first, then the comments and events; used by the card and the panel. */
export function ThreadBody({
  controller,
  state,
  mark,
}: {
  controller: Controller;
  state: State;
  mark: FeedbackMarkView;
}) {
  const now = Date.now();
  const open = state.threads[mark.id];
  const detail = open?.detail ?? null;
  const resolution = controller.resolutionOf(mark);
  const changed = resolution.place === 'located' && resolution.changed;
  const closed = mark.status === 'closed';
  const loading = !detail && open?.status !== 'error';
  const asking = (mark.canDelete && open?.deleteAsk) ?? false;
  const own = mark.author.handle === (state.me ?? state.session?.me)?.handle;
  const deleteButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);
  useEffect(() => {
    // Closing the confirmation (Cancel or Esc) hands the focus back to the button that opened it.
    if (wasAsking.current && !asking) deleteButton.current?.focus();
    wasAsking.current = asking;
  }, [asking]);

  return (
    <div class="thread" style={{ '--pc': colorVar(mark.author) }}>
      <p class="thread-meta">
        <b>{personName(mark.author)}</b>
        <time dateTime={mark.createdAt}>{relativeTime(mark.createdAt, now)}</time>
        <StatusLabel mark={mark} />
        {mark.canDelete && (
          <button
            ref={deleteButton}
            type="button"
            class="link danger"
            disabled={open?.deleting ?? false}
            onClick={() => controller.askDelete(mark.id, true)}
          >
            {t('thread.delete')}
          </button>
        )}
      </p>
      {changed && (
        <p class="note changed-note" role="note">
          {t('thread.changed')}
        </p>
      )}
      {mark.card && <CardLine card={mark.card} />}
      <p class="first">{mark.body}</p>
      {loading && (
        <div class="skeleton" aria-hidden="true">
          <div class="sk" />
          <div class="sk short" />
        </div>
      )}
      {open?.status === 'error' && (
        <p class="err" role="alert">
          {t('thread.loadError')}{' '}
          <button type="button" class="link" onClick={() => void controller.reloadThread(mark.id)}>
            {t('thread.retry')}
          </button>
        </p>
      )}
      {detail && detail.thread.length > 0 && (
        <ol class="msgs">
          {detail.thread.map((entry) => (
            <Message key={entry.id} entry={entry} now={now} />
          ))}
        </ol>
      )}
      {mark.working && (
        <p class="note working" role="status">
          {t('thread.working')}
        </p>
      )}
      {asking ? (
        <DeleteConfirm
          controller={controller}
          mark={mark}
          own={own}
          deleting={open?.deleting ?? false}
          error={open?.deleteError ?? false}
        />
      ) : closed ? (
        <p class="note closed-note">{t('thread.closed')}</p>
      ) : (
        detail?.canComment && (
          <Reply
            controller={controller}
            markId={mark.id}
            sending={open?.sending ?? false}
            error={open?.sendError ?? false}
          />
        )
      )}
    </div>
  );
}
