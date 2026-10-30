import type { PublicInviteView } from '@projectman/shared';
import { intlLocale } from '../../i18n/format';
import { t } from '../../i18n/t';
import { humanRoleName } from '../../lib/roles';

/** What the invitation offers: the access, the roles and when it expires. */
export function InviteFacts({ invite }: { invite: PublicInviteView }) {
  return (
    <>
      <p>
        <strong>{humanRoleName(invite.access)}</strong> · {t(`invites.accessHint.${invite.access}`)}
      </p>
      {invite.roleNames.length > 0 ? (
        <p>
          {t('invites.roles')}: {invite.roleNames.join(t('common.listSeparator'))}
        </p>
      ) : null}
      <p>{t('invites.expires', { date: new Date(invite.expiresAt).toLocaleString(intlLocale()) })}</p>
    </>
  );
}
