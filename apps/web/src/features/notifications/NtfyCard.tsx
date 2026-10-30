import clsx from 'clsx';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_NTFY_SERVER } from '@projectman/shared';
import type { NtfyChannelView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { failText, ntfyStatus, ntfyWhy } from './deviceText';
import type { DeviceTone } from './deviceText';
import styles from './notifications.module.css';
import { useNtfyOverview, useRemoveNtfy, useRenewNtfyTopic, useSaveNtfy, useTestNtfy } from './usePush';

const toneClass: Record<DeviceTone, string | undefined> = {
  ok: styles.toneOk,
  err: styles.toneErr,
  exp: styles.toneExp,
  none: undefined,
  paused: undefined,
};

const MASK = '••••••••••••••••';

/** The topic of the channel: hidden until the person asks, with a copy button (it is the channel's only secret). */
function TopicRow({
  channel,
  revealed,
  onReveal,
}: {
  channel: NtfyChannelView;
  revealed: boolean;
  onReveal: (value: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(channel.topic);
      setCopied(true);
      setCopyFailed(false);
    } catch {
      setCopied(false);
      setCopyFailed(true);
    }
  }

  return (
    <div className={styles.ntfyTopic}>
      <span className={styles.rowTitle}>{t('notifications.ntfy.topic')}</span>
      <span className={styles.ntfyTopicLine}>
        <code
          className={styles.ntfyCode}
          aria-label={revealed ? undefined : t('notifications.ntfy.topicMasked')}
          data-testid="ntfy-topic"
        >
          {revealed ? channel.topic : MASK}
        </code>
        <Button
          size="md"
          variant="ghost"
          aria-label={t(revealed ? 'notifications.ntfy.hideLabel' : 'notifications.ntfy.revealLabel')}
          aria-pressed={revealed}
          onClick={() => onReveal(!revealed)}
        >
          {t(revealed ? 'notifications.ntfy.hide' : 'notifications.ntfy.reveal')}
        </Button>
        <Button
          size="md"
          variant="ghost"
          aria-label={t('notifications.ntfy.copyLabel')}
          onClick={() => void copy()}
        >
          {t(copied ? 'notifications.ntfy.copied' : 'notifications.ntfy.copy')}
        </Button>
      </span>
      <span className={styles.rowHint}>{t('notifications.ntfy.topicHint')}</span>
      {copyFailed ? (
        <span role="alert" className={styles.fieldError}>
          {t('notifications.ntfy.copyFailed')}
        </span>
      ) : null}
    </div>
  );
}

/** The channel once it is set up: the switch and last result, the topic, the server and the actions. */
function ChannelBody({ channel }: { channel: NtfyChannelView }) {
  const toast = useToast();
  const save = useSaveNtfy();
  const test = useTestNtfy();
  const renew = useRenewNtfyTopic();
  const remove = useRemoveNtfy();
  const [revealed, setRevealed] = useState(false);
  const [server, setServer] = useState(channel.server);
  const [confirm, setConfirm] = useState<'renew' | 'remove' | null>(null);
  const serverId = useId();
  const status = ntfyStatus(channel, test.isPending);
  const why = ntfyWhy(channel);

  // The server's value wins again after a refetch or a failed save.
  useEffect(() => setServer(channel.server), [channel.server]);

  function toggle(enabled: boolean) {
    save.mutate(
      { server: channel.server, enabled },
      {
        onSuccess: () =>
          toast.show(t(enabled ? 'notifications.ntfy.enabledToast' : 'notifications.ntfy.pausedToast'), 'ok'),
        onError: (error) => toast.show(failText(error, t('notifications.ntfy.toggleFailed')), 'error'),
      },
    );
  }

  function saveServer(event: FormEvent) {
    event.preventDefault();
    save.mutate(
      { server: server.trim(), enabled: channel.enabled },
      {
        onSuccess: () => toast.show(t('notifications.ntfy.saved'), 'ok'),
        onError: (error) => toast.show(failText(error, t('notifications.ntfy.saveFailed')), 'error'),
      },
    );
  }

  function runTest() {
    test.mutate(undefined, {
      onSuccess: (updated) =>
        toast.show(
          updated?.lastResult === 'ok' ? t('notifications.ntfy.testOk') : t('notifications.ntfy.testFailed'),
          updated?.lastResult === 'ok' ? 'ok' : 'error',
        ),
      onError: (error) => toast.show(failText(error, t('notifications.ntfy.testRequestFailed')), 'error'),
    });
  }

  function confirmed() {
    const action = confirm;
    if (action === 'renew')
      renew.mutate(undefined, {
        onSuccess: () => {
          setConfirm(null);
          setRevealed(false);
          toast.show(t('notifications.ntfy.renewed'), 'ok');
        },
        onError: (error) => {
          setConfirm(null);
          toast.show(failText(error, t('notifications.ntfy.renewFailed')), 'error');
        },
      });
    else if (action === 'remove')
      remove.mutate(undefined, {
        onSuccess: () => {
          setConfirm(null);
          toast.show(t('notifications.ntfy.removed'), 'ok');
        },
        onError: (error) => {
          setConfirm(null);
          toast.show(failText(error, t('notifications.ntfy.removeFailed')), 'error');
        },
      });
  }

  return (
    <>
      <div className={styles.ntfyHead}>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          aria-label={t('notifications.ntfy.switchLabel')}
          checked={channel.enabled}
          disabled={save.isPending}
          onChange={(event) => toggle(event.target.checked)}
        />
        <span className={clsx(styles.deviceMeta, toneClass[status.tone])} aria-live="polite">
          <span className={styles.dot} aria-hidden="true" />
          <span>{status.text}</span>
        </span>
      </div>
      {why ? <p className={styles.why}>{why}</p> : null}

      <TopicRow channel={channel} revealed={revealed} onReveal={setRevealed} />

      <form className={clsx(styles.field, styles.ntfyServer)} onSubmit={saveServer}>
        <label htmlFor={serverId}>{t('notifications.ntfy.server')}</label>
        <span className={styles.ntfyServerLine}>
          <input
            id={serverId}
            type="url"
            inputMode="url"
            autoComplete="off"
            value={server}
            onChange={(event) => setServer(event.target.value)}
          />
          <Button
            type="submit"
            size="md"
            variant="secondary"
            loading={save.isPending && server.trim() !== channel.server}
            disabled={server.trim() === channel.server || save.isPending}
          >
            {t('notifications.ntfy.save')}
          </Button>
        </span>
        <span className={styles.rowHint}>{t('notifications.ntfy.serverHint')}</span>
      </form>

      {channel.hasLink ? null : <p className={styles.foot}>{t('notifications.ntfy.noLink')}</p>}

      <div className={styles.ntfyActions}>
        {channel.enabled ? (
          <Button size="md" variant="ghost" loading={test.isPending} onClick={runTest}>
            {t('notifications.ntfy.test')}
          </Button>
        ) : null}
        <Button size="md" variant="ghost" onClick={() => setConfirm('renew')}>
          {t('notifications.ntfy.renew')}
        </Button>
        <Button size="md" variant="danger" onClick={() => setConfirm('remove')}>
          {t('notifications.ntfy.remove')}
        </Button>
      </div>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        size="sm"
        title={t(confirm === 'renew' ? 'notifications.ntfy.renewTitle' : 'notifications.ntfy.removeTitle')}
        description={t(
          confirm === 'renew' ? 'notifications.ntfy.renewText' : 'notifications.ntfy.removeText',
        )}
        footer={
          <>
            <Button variant="secondary" autoFocus onClick={() => setConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="dangerSolid" loading={renew.isPending || remove.isPending} onClick={confirmed}>
              {t(
                confirm === 'renew' ? 'notifications.ntfy.renewConfirm' : 'notifications.ntfy.removeConfirm',
              )}
            </Button>
          </>
        }
      />
    </>
  );
}

/** The phone channel through ntfy, next to the browser devices (PM-901). */
export function NtfyCard() {
  const toast = useToast();
  const overview = useNtfyOverview();
  const save = useSaveNtfy();

  function setUp() {
    save.mutate(
      { server: DEFAULT_NTFY_SERVER, enabled: true },
      {
        onSuccess: () => toast.show(t('notifications.ntfy.created'), 'ok'),
        onError: (error) => toast.show(failText(error, t('notifications.ntfy.setUpFailed')), 'error'),
      },
    );
  }

  if (overview.isPending)
    return (
      <div className={styles.card} aria-busy="true">
        <p className={styles.muted}>{t('notifications.ntfy.loading')}</p>
      </div>
    );
  if (overview.isError)
    return (
      <div className={styles.loadFailed}>
        <ErrorBanner>{t('notifications.ntfy.loadFailed')}</ErrorBanner>
        <Button size="md" onClick={() => void overview.refetch()}>
          {t('app.retry')}
        </Button>
      </div>
    );
  if (!overview.data.available)
    return (
      <div className={styles.card}>
        <p className={styles.muted}>{t('notifications.ntfy.unavailable')}</p>
      </div>
    );
  const channel = overview.data.channel;
  return (
    <div className={styles.card}>
      {channel ? (
        <ChannelBody channel={channel} />
      ) : (
        <>
          <p className={styles.muted}>{t('notifications.ntfy.intro')}</p>
          <div className={styles.ntfyActions}>
            <Button size="md" variant="primary" loading={save.isPending} onClick={setUp}>
              {t('notifications.ntfy.setUp')}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
