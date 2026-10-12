import { useRef } from 'preact/hooks';
import type { Controller, NoticeKind, State } from '../controller';
import { t } from '../i18n';
import { CloseButton, Dialog } from './Dialog';

const TEXT = {
  startError: 'notice.startError',
  badCode: 'notice.badCode',
  expired: 'notice.expired',
  signedOut: 'notice.signedOut',
} as const satisfies Record<NoticeKind, string>;

/** Why the widget is off (or could not start): a short message with the one action that fits. */
export function Notice({ controller, kind, phone }: { controller: Controller; kind: NoticeKind; phone: boolean }) {
  return (
    <div class={`notice${phone ? ' sheet' : ''}`} role={kind === 'startError' ? 'alert' : 'status'}>
      <p>{t(TEXT[kind])}</p>
      <div class="notice-actions">
        {kind === 'startError' ? (
          <>
            <button type="button" class="btn ghost" onClick={() => controller.dismissNotice()}>
              {t('notice.dismiss')}
            </button>
            <button type="button" class="btn primary" onClick={() => void controller.retryStart()}>
              {t('notice.retry')}
            </button>
          </>
        ) : (
          <button type="button" class="btn primary" onClick={() => controller.dismissNotice()}>
            {t('notice.ok')}
          </button>
        )}
      </div>
    </div>
  );
}

/** The first time in a browser: what the marker is and that the name is shown to the team. */
export function Welcome({ controller, state, phone }: { controller: Controller; state: State; phone: boolean }) {
  const start = useRef<HTMLButtonElement>(null);
  const full = (state.me ?? state.session?.me)?.name ?? '';
  // Hungarian names put the family name first, so the greeting uses the last word.
  const given = full.trim().split(/\s+/).pop() ?? '';
  return (
    <Dialog label={t('welcome.title', { name: given })} kind="welcome" phone={phone} modal initialFocus={() => start.current}>
      <h2>{t('welcome.title', { name: given })}</h2>
      <p>{t('welcome.body')}</p>
      <ul>
        <li>{t('welcome.point1')}</li>
        <li>{t('welcome.point2')}</li>
        <li>{t('welcome.point3')}</li>
      </ul>
      <footer class="card-foot">
        <button ref={start} type="button" class="btn primary" onClick={() => controller.finishWelcome()}>
          {t('welcome.start')}
        </button>
      </footer>
    </Dialog>
  );
}

export function Help({ controller, phone }: { controller: Controller; phone: boolean }) {
  return (
    <Dialog label={t('help.title')} kind="help" phone={phone}>
      <header class="card-head">
        <h2>{t('help.title')}</h2>
        <CloseButton label={t('thread.close')} onClick={() => controller.toggleHelp(false)} />
      </header>
      <p>{t('help.body')}</p>
    </Dialog>
  );
}

