import type { Controller, State } from '../controller';
import { safeHttpUrl } from '../links';
import { t } from '../i18n';
import { Dialog } from './Dialog';
import { Avatar, personName } from './common';

/** The ⋯ menu above the launcher. */
export function Menu({ controller, state, phone }: { controller: Controller; state: State; phone: boolean }) {
  const person = state.me ?? state.session?.me ?? null;
  const link = safeHttpUrl(controller.appLink());
  return (
    <Dialog label={t('menu.aria')} kind="menu" phone={phone}>
      {state.offline && (
        <p class="menu-offline" role="status">
          {t('menu.offline')}
        </p>
      )}
      {person && (
        <p class="menu-me">
          <Avatar person={person} />
          <span>
            <b>{personName(person)}</b>
            <small>{t('menu.me')}</small>
          </span>
        </p>
      )}
      <button type="button" class="item" onClick={() => controller.toggleHidden()}>
        {t(state.hidden ? 'menu.show' : 'menu.hide')}
      </button>
      {link && (
        <a class="item" href={link} target="_blank" rel="noopener noreferrer">
          {t('menu.open')}
        </a>
      )}
      <button type="button" class="item" onClick={() => controller.toggleHelp(true)}>
        {t('menu.help')}
      </button>
      <button type="button" class="item danger" onClick={() => void controller.logout()}>
        {t('menu.logout')}
      </button>
    </Dialog>
  );
}
