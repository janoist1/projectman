import type { AgentProvider, ProviderLoginStatus } from '@projectman/shared';
import { t } from '../../i18n/t';
import styles from './memberForm.module.css';
import { useRef, useState } from 'react';
import { useProviders } from '../../api/queries';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/toastContext';
import { NanogptKeyDialog } from '../settings/NanogptKeyDialog';

export function ProviderLoginSteps({ provider }: { provider: AgentProvider }) {
  if (provider === 'nanogpt') return null;
  return (
    <>
      {t(`providerSettings.loginSteps.${provider}`)}{' '}
      <code>{t(`providerSettings.loginCommands.${provider}`)}</code>
    </>
  );
}

/** Shared warning, with an alert only in the member dialog. NanoGPT extends this in PM-330. */
export function ProviderWarning({
  provider,
  status,
  inDialog = false,
}: {
  provider: AgentProvider;
  status?: ProviderLoginStatus;
  inDialog?: boolean;
}) {
  if (provider === 'nanogpt') return <NanogptWarning status={status} inDialog={inDialog} />;
  if (status?.loggedIn !== false) return null;
  const needsLogin = !status.problem || status.problem === 'not_logged_in';
  return (
    <p className={styles.warning} role={inDialog ? 'alert' : undefined}>
      {t(needsLogin ? 'providerSettings.loginWarning' : 'providerSettings.notReadyWarning', {
        provider: t(`providers.${provider}`),
      })}
      {needsLogin ? (
        <>
          {' '}
          <ProviderLoginSteps provider={provider} />
        </>
      ) : null}
    </p>
  );
}

function NanogptWarning({ status, inDialog }: { status?: ProviderLoginStatus; inDialog: boolean }) {
  const query = useProviders();
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const focus = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const missing = status?.loggedIn === false;
  const noKey = query.data?.keys.nanogpt.set === false;
  const problem = status?.problem;
  const reason =
    problem && problem !== 'not_logged_in'
      ? t(`providerSettings.nanogptProblems.${problem}`, {
          cliVersion: status?.cliVersion ?? t('common.dash'),
          minCliVersion: status?.minCliVersion ?? t('common.dash'),
        })
      : '';
  return (
    <>
      {missing || saved ? (
        <div
          ref={focus}
          tabIndex={-1}
          className={missing ? `${styles.warning} ${styles.providerWarning}` : styles.saved}
          role={missing ? (inDialog ? 'alert' : undefined) : 'status'}
        >
          <span>
            {missing ? (
              problem === 'no_key' ? (
                t('providerSettings.nanogptNoKey')
              ) : (
                t('providerSettings.nanogptIncomplete', { reason })
              )
            ) : (
              <>
                <Icon name="check" size={16} /> {t('nanogptKey.saved')}
              </>
            )}
            {missing && noKey && !query.data?.canManageKeys ? (
              <> {t('providerSettings.nanogptOwnerSettings')}</>
            ) : null}
          </span>
          {missing && noKey && query.data?.canManageKeys ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              {t('nanogptKey.add')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <NanogptKeyDialog
        open={open}
        onClose={() => setOpen(false)}
        onSaved={() => {
          setSaved(true);
          if (!inDialog) toast.show(t('nanogptKey.saved'));
          // Wait for the removed dialog's focus restoration and the new status to render.
          requestAnimationFrame(() => focus.current?.focus());
        }}
      />
    </>
  );
}
