import { useNavigate } from 'react-router';
import { useLogout } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The signed-in user's account and handle here, with log out. */
export function AccountSection() {
  const { me, myHandle } = useProject();
  const logout = useLogout();
  const navigate = useNavigate();
  return (
    <SettingsSection id="settings-account" title={t('settings.sections.account')}>
      <dl className={shared.facts}>
        <div>
          <dt>{t('settings.account.name')}</dt>
          <dd>{me.name}</dd>
        </div>
        <div>
          <dt>{t('settings.account.email')}</dt>
          <dd>{me.email}</dd>
        </div>
        {myHandle ? (
          <div>
            <dt>{t('settings.account.handle')}</dt>
            <dd>
              <code className={shared.id}>{myHandle}</code>
            </dd>
          </div>
        ) : null}
      </dl>
      <Button
        variant="secondary"
        icon="logout"
        loading={logout.isPending}
        onClick={() => logout.mutate(undefined, { onSettled: () => navigate('/login', { replace: true }) })}
      >
        {t('common.logout')}
      </Button>
    </SettingsSection>
  );
}
