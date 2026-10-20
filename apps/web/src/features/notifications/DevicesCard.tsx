import clsx from 'clsx';
import { useState } from 'react';
import type { PushDeviceView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { deviceName, deviceStatus, deviceWhy, failText } from './deviceText';
import type { DeviceTone } from './deviceText';
import styles from './notifications.module.css';
import { useRemovePushDevice, useSetPushDeviceEnabled } from './usePush';

const toneClass: Record<DeviceTone, string | undefined> = {
  ok: styles.toneOk,
  err: styles.toneErr,
  exp: styles.toneExp,
  none: undefined,
  paused: undefined,
};

export function DevicesSkeleton() {
  return (
    <div className={styles.card} aria-busy="true">
      <span className={styles.srOnly}>{t('notifications.devices.loading')}</span>
      {[0, 1, 2].map((row) => (
        <div key={row} className={styles.skeletonRow}>
          <div className={styles.skeleton} style={{ width: 32, height: 32 }} />
          <div style={{ flex: 1 }}>
            <div className={styles.skeleton} style={{ height: 12, width: '40%', marginBottom: 8 }} />
            <div className={styles.skeleton} style={{ height: 10, width: '25%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The person's devices: the last send of each, a switch to pause it, a test and a delete (PM-815). */
export function DevicesCard({
  devices,
  selfEndpointHash,
  testingId,
  flashId,
  onTest,
  onRemoved,
}: {
  devices: readonly PushDeviceView[];
  /** The endpoint hash of this browser's subscription; its row gets the "this device" chip. */
  selfEndpointHash: string | null;
  testingId: string | null;
  flashId: string | null;
  onTest: (device: PushDeviceView) => void;
  /** A row was deleted; the page forgets this browser's subscription when it was this device's. */
  onRemoved: (device: PushDeviceView) => void;
}) {
  const toast = useToast();
  const toggle = useSetPushDeviceEnabled();
  const remove = useRemovePushDevice();
  const [removing, setRemoving] = useState<PushDeviceView | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  if (devices.length === 0) {
    return (
      <div className={styles.card}>
        <p className={styles.muted}>{t('notifications.devices.empty')}</p>
      </div>
    );
  }

  function setEnabled(device: PushDeviceView, enabled: boolean) {
    setTogglingId(device.id);
    toggle.mutate(
      { id: device.id, enabled },
      {
        onSuccess: () =>
          toast.show(
            enabled ? t('notifications.devices.enabledToast') : t('notifications.devices.pausedToast'),
            'ok',
          ),
        onError: (error) => toast.show(failText(error, t('notifications.devices.toggleFailed')), 'error'),
        onSettled: () => setTogglingId(null),
      },
    );
  }

  function confirmRemove() {
    const device = removing;
    if (!device) return;
    remove.mutate(device.id, {
      onSuccess: () => {
        setRemoving(null);
        onRemoved(device);
        toast.show(t('notifications.devices.removed'), 'ok');
      },
      onError: (error) => {
        setRemoving(null);
        toast.show(failText(error, t('notifications.devices.removeFailed')), 'error');
      },
    });
  }

  return (
    <div className={styles.card}>
      <ul className={styles.devices}>
        {devices.map((device) => {
          const name = deviceName(device);
          const status = deviceStatus(device, testingId === device.id);
          const why = deviceWhy(device);
          const expired = device.state === 'expired';
          return (
            <li
              key={device.id}
              id={`push-device-${device.id}`}
              className={clsx(
                styles.device,
                (expired || !device.enabled) && styles.deviceDim,
                flashId === device.id && styles.flash,
              )}
            >
              <span className={styles.deviceIcon} aria-hidden="true">
                <Icon name={device.form === 'phone' ? 'phone' : 'laptop'} size={17} />
              </span>
              <span className={styles.deviceName}>
                {name}
                {device.endpointHash === selfEndpointHash ? (
                  <span className={styles.chip}>{t('notifications.devices.self')}</span>
                ) : null}
              </span>
              <span className={clsx(styles.deviceMeta, toneClass[status.tone])} aria-live="polite">
                <span className={styles.dot} aria-hidden="true" />
                <span>{status.text}</span>
              </span>
              {why ? <span className={styles.why}>{why}</span> : null}
              {expired ? null : (
                <span className={styles.deviceSwitch}>
                  <input
                    type="checkbox"
                    role="switch"
                    className={styles.switch}
                    aria-label={t('notifications.devices.switchLabel', { name })}
                    checked={device.enabled}
                    disabled={togglingId === device.id}
                    onChange={(event) => setEnabled(device, event.target.checked)}
                  />
                </span>
              )}
              <span className={styles.deviceActions}>
                {device.enabled && !expired ? (
                  <Button
                    size="md"
                    variant="ghost"
                    disabled={testingId !== null}
                    aria-label={t('notifications.devices.testLabel', { name })}
                    onClick={() => onTest(device)}
                  >
                    {t('notifications.devices.test')}
                  </Button>
                ) : null}
                <Button
                  size="md"
                  variant="danger"
                  aria-label={t('notifications.devices.removeLabel', { name })}
                  onClick={() => setRemoving(device)}
                >
                  {t('notifications.devices.remove')}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
      <Dialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        size="sm"
        title={t('notifications.devices.removeTitle')}
        description={t('notifications.devices.removeText')}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setRemoving(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="dangerSolid" loading={remove.isPending} onClick={confirmRemove}>
              {t('notifications.devices.removeConfirm')}
            </Button>
          </>
        }
      />
    </div>
  );
}
