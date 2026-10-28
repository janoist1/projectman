import clsx from 'clsx';
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { PushDeviceView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Fold } from '../../components/Fold';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { LoadingState } from '../../components/States';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { readPermission } from '../../lib/pushBrowser';
import { deviceName, deviceStatus } from './deviceText';
import styles from './notifications.module.css';
import type { ThisDevice } from './usePush';

type Tone = 'neutral' | 'ok' | 'needs';

function Hero({
  tone = 'neutral',
  icon,
  title,
  actions,
  children,
}: {
  tone?: Tone;
  icon: IconName;
  title: string;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className={clsx(styles.hero, tone === 'ok' && styles.heroOk, tone === 'needs' && styles.heroNeeds)}>
      <span className={styles.heroIcon} aria-hidden="true">
        <Icon name={icon} size={22} />
      </span>
      <div className={styles.heroBody}>
        <p className={styles.heroTitle}>{title}</p>
        {children}
      </div>
      {actions ? <div className={styles.heroActions}>{actions}</div> : null}
    </div>
  );
}

/** The first card: where this browser stands, with the one action that fits (PM-815). */
export function ThisDeviceCard({
  thisDevice,
  sending,
  onTest,
}: {
  thisDevice: ThisDevice;
  sending: boolean;
  onTest: (device: PushDeviceView) => void;
}) {
  const toast = useToast();
  const { state } = thisDevice;
  const [busy, setBusy] = useState(false);

  async function enable() {
    if (await thisDevice.enable()) toast.show(t('notifications.enabled'), 'ok');
  }

  async function recheck() {
    const subscribed = await thisDevice.recheck();
    if (!subscribed && readPermission() === 'denied')
      toast.show(t('notifications.denied.stillDenied'), 'info');
    if (subscribed) toast.show(t('notifications.enabled'), 'ok');
  }

  async function disable() {
    setBusy(true);
    try {
      await thisDevice.disable();
      toast.show(t('notifications.on.disabled'), 'ok');
    } catch {
      toast.show(t('notifications.on.disableFailed'), 'error');
    } finally {
      setBusy(false);
    }
  }

  switch (state.kind) {
    case 'loading':
      return <LoadingState compact />;
    case 'unavailable':
      return (
        <Hero icon="bellOff" title={t('notifications.unavailable.title')}>
          <p className={styles.heroText}>{t('notifications.unavailable.text')}</p>
        </Hero>
      );
    case 'unsupported':
      return (
        <Hero icon="bellOff" title={t('notifications.unsupported.title')}>
          <p className={styles.heroText}>{t('notifications.unsupported.text')}</p>
        </Hero>
      );
    case 'ios_install':
      return (
        <Hero icon="phone" title={t('notifications.ios.title')}>
          <p className={styles.heroText}>{t('notifications.ios.text')}</p>
          <ol className={styles.steps}>
            <li>{t('notifications.ios.step1')}</li>
            <li>{t('notifications.ios.step2')}</li>
            <li>{t('notifications.ios.step3')}</li>
            <li>{t('notifications.ios.step4')}</li>
          </ol>
          <p className={styles.heroSmall}>{t('notifications.ios.small')}</p>
        </Hero>
      );
    case 'denied':
      return (
        <Hero
          tone="needs"
          icon="ban"
          title={t('notifications.denied.title')}
          actions={
            <Button size="md" onClick={() => void recheck()}>
              {t('notifications.denied.action')}
            </Button>
          }
        >
          <p className={styles.heroText}>{t('notifications.denied.text')}</p>
          <Fold summary={t('notifications.denied.howTo')} className={styles.fold}>
            <dl className={styles.howTo}>
              <dt>{t('notifications.denied.chrome')}</dt>
              <dd>{t('notifications.denied.chromeText')}</dd>
              <dt>{t('notifications.denied.firefox')}</dt>
              <dd>{t('notifications.denied.firefoxText')}</dd>
              <dt>{t('notifications.denied.safari')}</dt>
              <dd>{t('notifications.denied.safariText')}</dd>
              <dt>{t('notifications.denied.iphone')}</dt>
              <dd>{t('notifications.denied.iphoneText')}</dd>
              <dt>{t('notifications.denied.android')}</dt>
              <dd>{t('notifications.denied.androidText')}</dd>
            </dl>
          </Fold>
        </Hero>
      );
    case 'asking':
      return (
        <Hero
          icon="bell"
          title={t('notifications.asking.title')}
          actions={
            <Button size="md" variant="primary" loading disabled>
              {t('notifications.asking.action')}
            </Button>
          }
        >
          <p className={styles.heroText}>{t('notifications.asking.text')}</p>
        </Hero>
      );
    case 'expired':
      return (
        <Hero
          tone="needs"
          icon="bellOff"
          title={t('notifications.expired.title')}
          actions={
            <Button size="md" variant="primary" onClick={() => void enable()}>
              {t('notifications.expired.action')}
            </Button>
          }
        >
          <p className={styles.heroText}>{t('notifications.expired.text')}</p>
        </Hero>
      );
    case 'on': {
      const device = state.device;
      return (
        <Hero
          tone="ok"
          icon="bell"
          title={t('notifications.on.title')}
          actions={
            <>
              <Button size="md" disabled={sending} onClick={() => onTest(device)}>
                {t('notifications.on.test')}
              </Button>
              <Button size="md" variant="ghost" loading={busy} onClick={() => void disable()}>
                {t('notifications.on.disable')}
              </Button>
            </>
          }
        >
          <p className={styles.heroText}>
            {t('notifications.on.line', {
              device: deviceName(device),
              state: deviceStatus(device, sending).text,
            })}
          </p>
        </Hero>
      );
    }
    case 'off':
      return (
        <Hero
          icon="bellOff"
          title={t('notifications.off.title')}
          actions={
            <Button size="md" variant="primary" onClick={() => void enable()}>
              {t('notifications.off.action')}
            </Button>
          }
        >
          <p className={styles.heroText}>{t('notifications.off.text')}</p>
          <p className={styles.heroSmall}>{t('notifications.off.hint')}</p>
          {state.failure ? <ErrorBanner className={styles.enableFailed}>{state.failure}</ErrorBanner> : null}
        </Hero>
      );
  }
}
