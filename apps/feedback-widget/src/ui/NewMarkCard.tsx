import { useEffect, useRef } from 'preact/hooks';
import type { Controller, Draft, State } from '../controller';
import { COUNTER_FROM, MAX_BODY } from '../controller';
import { t } from '../i18n';
import { tipOfTarget } from './place';
import { CloseButton, Dialog } from './Dialog';
import { Avatar, colorVar } from './common';
import { useViewTick } from './hooks';
import { cardPlace, revealScroll } from './layout';
import { browserAskKey, browserOffer, shotNote } from './shot-offer';

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
  const root = useRef<HTMLDivElement>(null);
  const person = state.me ?? state.session?.me ?? null;
  const length = draft.body.length;
  const over = length > MAX_BODY;
  useViewTick(true); // the card follows the marked place when the page scrolls
  const place = cardPlace(controller.viewportOf(draft.target) ?? tipOfTarget(draft.target), {
    width: window.innerWidth,
    height: window.innerHeight,
  });

  // On a phone the sheet covers the bottom of the page: scroll so the draft marker shows above it.
  const shotStatus = draft.shot.status;
  useEffect(() => {
    const sheet = root.current;
    const found = controller.viewportOf(draft.target);
    if (!phone || !sheet || !found) return;
    const delta = revealScroll(found.y, sheet.getBoundingClientRect().top);
    if (delta !== 0) window.scrollBy({ top: delta, behavior: 'auto' });
  }, [controller, draft.target, phone, shotStatus]);

  const send = (): void => {
    if (over || draft.body.trim() === '') {
      field.current?.focus();
      return;
    }
    void controller.sendMark();
  };

  // After a browser picture the cursor is back in the text, where the user left off.
  const browserWas = useRef(draft.shot.browser);
  useEffect(() => {
    if (browserWas.current === 'asking' && draft.shot.browser === 'idle') field.current?.focus();
    browserWas.current = draft.shot.browser;
  }, [draft.shot.browser]);

  const shotFailed = draft.shot.status === 'failed';
  const note = shotNote(draft, state.canShare);
  const offer = browserOffer(draft, state.canShare, state.sharing);
  const sendLabel = draft.sending ? 'new.sending' : draft.error ? 'new.retry' : 'new.send';

  return (
    <Dialog
      label={t('new.title')}
      kind="card new"
      place={place}
      phone={phone}
      rootRef={root}
      initialFocus={() => field.current}
    >
      <div class="bar" style={{ '--pc': colorVar(person) }} aria-hidden="true" />
      <header class="card-head">
        {person && <Avatar person={person} />}
        <h2>{t('new.title')}</h2>
        <CloseButton label={t('new.cancelAria')} onClick={() => controller.cancelDraft()} />
      </header>
      <p class="what">
        {draft.target.kind === 'element' && <span>{t('new.whatElement')}</span>}
        <span class={draft.target.kind === 'element' ? 'what-label' : undefined}>{draft.target.label}</span>
      </p>
      <textarea
        ref={field}
        class={`field${over ? ' bad' : ''}`}
        rows={4}
        value={draft.body}
        placeholder={t('new.placeholder')}
        aria-label={t('new.placeholder')}
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
          (over
            ? t('new.tooLong', { count: length - MAX_BODY })
            : t('new.remaining', { count: MAX_BODY - length }))}
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
        <p class={`shot-note${note.warn ? ' warn' : ''}`} role="status">
          {t(note.key)}
        </p>
        {draft.shotEnabled && !shotFailed && (
          <div class="preview">
            {draft.shot.preview ? (
              <img key={draft.shot.source} src={draft.shot.preview} alt={t('new.screenshotPreview')} />
            ) : (
              <div class="sk" aria-hidden="true" />
            )}
          </div>
        )}
        {offer === 'button' && (
          <div class="shot-offer strong">
            <button type="button" class="btn primary" onClick={() => void controller.captureWithBrowser()}>
              {t('new.browserShot')}
            </button>
            <span class="hint-line">{t('new.browserShotHint')}</span>
          </div>
        )}
        {offer === 'link' && (
          <p class="shot-offer">
            <span class="ask">{t(browserAskKey(draft))}</span>
            <button type="button" class="link" onClick={() => void controller.captureWithBrowser()}>
              {t('new.browserShotAction')}
            </button>
          </p>
        )}
        {offer === 'asking' &&
          (shotFailed ? (
            <div class="shot-offer strong">
              <button type="button" class="btn primary" disabled aria-busy="true">
                {t('new.browserShotAsking')}
              </button>
            </div>
          ) : (
            <p class="shot-offer" role="status">
              {t('new.browserShotAsking')}
            </p>
          ))}
      </div>
      {draft.error && (
        <p class="err" role="alert">
          {draft.error.kind === 'rate'
            ? t('new.rateLimited', { minutes: draft.error.minutes })
            : t('new.error')}
        </p>
      )}
      <footer class="card-foot">
        <span class="hotkey">{t('new.hotkey')}</span>
        <button type="button" class="btn ghost" onClick={() => controller.cancelDraft()}>
          {t('new.cancel')}
        </button>
        <button type="button" class="btn primary" disabled={draft.sending} onClick={send}>
          {t(sendLabel)}
        </button>
      </footer>
    </Dialog>
  );
}
