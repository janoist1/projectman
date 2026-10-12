import { useRef } from 'preact/hooks';
import type { Controller, Draft, State } from '../controller';
import { COUNTER_FROM, MAX_BODY } from '../controller';
import { t } from '../i18n';
import { tipOfTarget } from './place';
import { CloseButton, Dialog } from './Dialog';
import { Avatar, colorVar } from './common';
import { cardPlace } from './layout';

/** The new-mark card: what was marked, the text, the screenshot switch and the send row. */
export function NewMarkCard({
  controller,
  state,
  draft,
  phone,
}: {
  controller: Controller;
  state: State;
  draft: Draft;
  phone: boolean;
}) {
  const field = useRef<HTMLTextAreaElement>(null);
  const person = state.me ?? state.session?.me ?? null;
  const length = draft.body.length;
  const over = length > MAX_BODY;
  const place = cardPlace(tipOfTarget(draft.target), { width: window.innerWidth, height: window.innerHeight });

  const send = (): void => {
    if (over) {
      field.current?.focus();
      return;
    }
    void controller.sendMark();
  };

  const shotFailed = draft.shot.status === 'failed';
  const shotWaiting = draft.shot.status === 'pending';
  const sendLabel = draft.sending ? 'new.sending' : draft.error ? 'new.retry' : 'new.send';

  return (
    <Dialog label={t('new.title')} kind="card new" place={place} phone={phone} initialFocus={() => field.current}>
      <div class="bar" style={{ '--pc': colorVar(person) }} aria-hidden="true" />
      <header class="card-head">
        {person && <Avatar person={person} />}
        <h2>{t('new.title')}</h2>
        <CloseButton label={t('new.cancelAria')} onClick={() => controller.cancelDraft()} />
      </header>
      <p class="what">
        <span class="kind">{t(`kind.${draft.target.kind}`)}</span>
        <span class="what-label">{draft.target.label}</span>
      </p>
      <textarea
        ref={field}
        class={`field${over ? ' bad' : ''}`}
        rows={4}
        value={draft.body}
        placeholder={t('new.placeholder')}
        aria-label={t('new.title')}
        aria-invalid={over ? 'true' : undefined}
        onInput={(event) => controller.setBody((event.currentTarget as HTMLTextAreaElement).value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            send();
          }
        }}
      />
      <p class={`counter${over ? ' bad' : ''}`} aria-live="polite">
        {length >= COUNTER_FROM &&
          (over ? t('new.tooLong', { count: length - MAX_BODY }) : t('new.remaining', { count: MAX_BODY - length }))}
      </p>
      <div class="shot">
        <label class="switch">
          <input
            type="checkbox"
            role="switch"
            checked={draft.shotEnabled && !shotFailed}
            disabled={shotFailed}
            onChange={(event) => controller.setShotEnabled((event.currentTarget as HTMLInputElement).checked)}
          />
          <span class="switch-text">{t('new.screenshot')}</span>
        </label>
        <p class="shot-note" role="status">
          {shotFailed
            ? t('new.screenshotFailed')
            : shotWaiting && draft.shotEnabled
              ? t('new.screenshotWait')
              : draft.shotEnabled
                ? t('new.screenshotOn')
                : t('new.screenshotOff')}
        </p>
        {draft.shotEnabled && !shotFailed && (
          <div class="preview">
            {draft.shot.preview ? (
              <img src={draft.shot.preview} alt={t('new.screenshotPreview')} />
            ) : (
              <div class="sk" aria-hidden="true" />
            )}
          </div>
        )}
      </div>
      {draft.error && (
        <p class="err" role="alert">
          {draft.error.kind === 'rate' ? t('new.rateLimited', { minutes: draft.error.minutes }) : t('new.error')}
        </p>
      )}
      <footer class="card-foot">
        <span class="hotkey">{t('new.hotkey')}</span>
        <button type="button" class="btn ghost" onClick={() => controller.cancelDraft()}>
          {t('new.cancel')}
        </button>
        <button
          type="button"
          class="btn primary"
          disabled={draft.sending || draft.body.trim() === ''}
          onClick={send}
        >
          {t(sendLabel)}
        </button>
      </footer>
    </Dialog>
  );
}
