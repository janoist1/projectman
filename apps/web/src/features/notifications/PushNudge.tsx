import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { readStorage, writeStorage } from '../../lib/hooks';
import { pushSupport, readPermission } from '../../lib/pushBrowser';
import styles from './notifications.module.css';
import { usePushOverview, useThisDevice } from './usePush';

/** The device-local memory of "Most nem" (PM-815); the account menu still reaches the page. */
const DISMISSED_KEY = 'pushNudgeDismissed';

function NudgeBar() {
  const { key } = useProject();
  const navigate = useNavigate();
  const toast = useToast();
  const overview = usePushOverview();
  const thisDevice = useThisDevice(overview.data);
  const [hidden, setHidden] = useState(false);

  if (hidden || (thisDevice.state.kind !== 'off' && thisDevice.state.kind !== 'asking')) return null;

  const asking = thisDevice.state.kind === 'asking';

  async function enable() {
    const ok = await thisDevice.enable();
    if (ok) toast.show(t('notifications.enabled'), 'ok');
    // A refusal or a failure is explained on the page itself, where the person can act on it.
    navigate(`/p/${key}/notifications`);
  }

  function later() {
    writeStorage(DISMISSED_KEY, '1');
    setHidden(true);
    toast.show(t('notifications.banner.dismissed'), 'info');
  }

  return (
    <div className={styles.nudge} role="region" aria-label={t('notifications.banner.label')}>
      <span className={styles.nudgeIcon} aria-hidden="true">
        <Icon name="bell" size={20} />
      </span>
      <div className={styles.nudgeText}>
        <span className={styles.nudgeTitle}>{t('notifications.banner.title')}</span>
        <span>{t('notifications.banner.text')}</span>
      </div>
      <div className={styles.nudgeActions}>
        <Button size="md" variant="primary" loading={asking} onClick={() => void enable()}>
          {t('notifications.banner.enable')}
        </Button>
        <Button size="md" variant="ghost" disabled={asking} onClick={later}>
          {t('notifications.banner.later')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The bar at the top of the Inbox that offers to switch notifications on. It shows only where it can work:
 * this browser takes push, has not been asked for the permission yet and the person has not said "Most nem"
 * here. The check comes first so a browser that cannot show it never fetches the device list.
 */
export function PushNudge() {
  if (pushSupport() !== 'supported' || readPermission() !== 'default' || readStorage(DISMISSED_KEY)) {
    return null;
  }
  return <NudgeBar />;
}
