import type { Controller, Mode, State } from '../controller';
import { t } from '../i18n';
import { colorVar } from './common';

const MODES: Mode[] = ['element', 'point', 'area'];

/** The widget's one visible control: the mark button (or the mode switcher), the list and the menu. */
export function Launcher({ controller, state }: { controller: Controller; state: State }) {
  const busy = state.phase === 'activating';
  const person = state.me ?? state.session?.me ?? null;
  const open = Object.values(state.marks).filter((m) => m.status !== 'closed' && controller.isOnThisPage(m));
  const unread = Object.values(state.marks).some((m) => m.unread);
  const listLabel = t(unread ? 'launcher.listUnread' : 'launcher.list', { count: open.length });
  return (
    <div
      class={`launch${busy ? ' busy' : ''}${state.offline ? ' offline' : ''}`}
      role="toolbar"
      aria-label={t('launcher.aria')}
      aria-busy={busy ? 'true' : undefined}
      style={{ '--pc': colorVar(person) }}
    >
      <span class="dot" aria-hidden="true" />
      {busy ? (
        <span class="l-text" role="status">
          {t('launcher.busy')}
        </span>
      ) : state.mode ? (
        <div class="modes" role="group" aria-label={t('mode.aria')}>
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              class="mode"
              aria-pressed={state.mode === mode}
              onClick={() => controller.beginMode(mode)}
            >
              {t(`mode.${mode}`)}
            </button>
          ))}
          <button type="button" class="mode off" aria-label={t('mode.cancel')} onClick={() => controller.cancelMode()}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      ) : (
        <button type="button" class="l-main" onClick={() => controller.beginMode('element')}>
          <span class="l-label">{t('launcher.label')}</span>
          <span class="l-short" aria-hidden="true">
            +
          </span>
          <span class="sr">{t('launcher.new')}</span>
        </button>
      )}
      {!busy && (
        <>
          <button type="button" class="l-list" aria-label={listLabel} onClick={() => controller.openPanel()}>
            <span aria-hidden="true">☰ {open.length}</span>
            {unread && <i class="unread" aria-hidden="true" />}
          </button>
          <button
            type="button"
            class="l-more"
            aria-label={t('launcher.more')}
            aria-haspopup="dialog"
            aria-expanded={state.menuOpen}
            onClick={() => controller.toggleMenu()}
          >
            <span aria-hidden="true">⋯</span>
          </button>
        </>
      )}
    </div>
  );
}
