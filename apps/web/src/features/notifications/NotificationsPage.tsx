import { useEffect, useRef, useState } from 'react';
import type { PushDeviceView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { PageHeader } from '../../components/PageHeader';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { useDocumentTitle } from '../../lib/hooks';
import { endpointHash, currentSubscription } from '../../lib/pushBrowser';
import { DevicesCard, DevicesSkeleton } from './DevicesCard';
import { KindsCard } from './KindsCard';
import { QuietHoursCard } from './QuietHoursCard';
import { ThisDeviceCard } from './ThisDeviceCard';
import { failText } from './deviceText';
import styles from './notifications.module.css';
import { usePushOverview, useTestPushDevice, useThisDevice } from './usePush';

/** The notifications page (PM-815): this device, the person's devices, the kinds worth a ping and the quiet hours. */
export function NotificationsPage() {
  useDocumentTitle(t('notifications.title'));
  const toast = useToast();
  const overview = usePushOverview();
  const thisDevice = useThisDevice(overview.data);
  const test = useTestPushDevice();
  const [testingId, setTestingId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [selfHash, setSelfHash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  useEffect(() => {
    let live = true;
    void currentSubscription()
      .then((subscription) => (subscription ? endpointHash(subscription.endpoint) : null))
      .catch(() => null)
      .then((hash) => {
        if (live) setSelfHash(hash);
      });
    return () => {
      live = false;
    };
  }, [overview.data]);

  function runTest(device: PushDeviceView) {
    setTestingId(device.id);
    test.mutate(device.id, {
      onSuccess: (updated) => {
        const self = updated.endpointHash === selfHash;
        toast.show(
          updated.lastResult === 'ok'
            ? t(self ? 'notifications.devices.testOkSelf' : 'notifications.devices.testOkOther')
            : t('notifications.devices.testFailed'),
          updated.lastResult === 'ok' ? 'ok' : 'error',
        );
        setFlashId(updated.id);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlashId(null), 1300);
      },
      onError: (error) => toast.show(failText(error, t('notifications.devices.testRequestFailed')), 'error'),
      onSettled: () => setTestingId(null),
    });
  }

  function removed(device: PushDeviceView) {
    if (device.endpointHash === selfHash) void thisDevice.forget();
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title={t('notifications.title')}
        subtitle={t('notifications.subtitle')}
        className={styles.header}
      />

      <section aria-labelledby="push-this-device">
        <h2 id="push-this-device" className={styles.srOnly}>
          {t('notifications.thisDevice')}
        </h2>
        <div className={styles.card}>
          <ThisDeviceCard thisDevice={thisDevice} sending={testingId !== null} onTest={runTest} />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="push-devices">
        <div className={styles.sectionHead}>
          <h2 id="push-devices" className={styles.sectionTitle}>
            {t('notifications.devices.title')}
          </h2>
          <span className={styles.hint}>{t('notifications.devices.hint')}</span>
        </div>
        {overview.isPending ? (
          <DevicesSkeleton />
        ) : overview.isError ? (
          <div className={`${styles.banner} ${styles.bannerError}`} role="alert">
            <span className={styles.grow}>{t('notifications.devices.loadFailed')}</span>
            <Button size="md" onClick={() => void overview.refetch()}>
              {t('app.retry')}
            </Button>
          </div>
        ) : (
          <DevicesCard
            devices={overview.data.devices}
            selfEndpointHash={selfHash}
            testingId={testingId}
            flashId={flashId}
            onTest={runTest}
            onRemoved={removed}
          />
        )}
      </section>

      {overview.data ? (
        <>
          <section className={styles.section} aria-labelledby="push-kinds">
            <div className={styles.sectionHead}>
              <h2 id="push-kinds" className={styles.sectionTitle}>
                {t('notifications.kinds.title')}
              </h2>
              <span className={styles.hint}>{t('notifications.kinds.hint')}</span>
            </div>
            <KindsCard settings={overview.data.settings} />
          </section>

          <section className={styles.section} aria-labelledby="push-quiet">
            <div className={styles.sectionHead}>
              <h2 id="push-quiet" className={styles.sectionTitle}>
                {t('notifications.quiet.title')}
              </h2>
              <span className={styles.hint}>{t('notifications.quiet.hint')}</span>
            </div>
            <QuietHoursCard settings={overview.data.settings} />
          </section>
        </>
      ) : null}
    </div>
  );
}
