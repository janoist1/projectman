import { useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ConfigView } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { isApiError } from '../../api/client';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { Fold } from '../../components/Fold';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './OperatorKnowledge.module.css';

function WaiverScope() {
  return (
    <div>
      <strong>{t('knowledge.waiver.allowed')}</strong>
      <ul>
        {(['allowedMembers', 'allowedLimits'] as const).map((key) => (
          <li key={key}>{t(`knowledge.waiver.${key}`)}</li>
        ))}
      </ul>
      <strong>{t('knowledge.waiver.protected')}</strong>
      <ul>
        {(
          [
            'protectedRights',
            'protectedApprovals',
            'protectedCode',
            'protectedSharing',
            'protectedSelf',
          ] as const
        ).map((key) => (
          <li key={key}>{t(`knowledge.waiver.${key}`)}</li>
        ))}
      </ul>
      <p>{t('knowledge.waiver.foot')}</p>
    </div>
  );
}

export function OperatorWaiver({
  config,
  agreementVersion,
}: {
  config: ConfigView;
  agreementVersion: number | null;
}) {
  const { key, isOwner } = useProject();
  const client = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ baseVersion: string; agreementVersion: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const [alert, setAlert] = useState<'conflict' | 'ownerOnly' | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const control = useRef<HTMLInputElement>(null);
  const title = useId();
  const description = useId();
  const enabled = config.config.team.operatorApprovalWaiver ?? false;
  useEffect(() => {
    if (!confirm) return;
    const frame = requestAnimationFrame(() => cancel.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [confirm]);
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.config(key) }),
      client.invalidateQueries({ queryKey: queryKeys.operatorKnowledge(key) }),
    ]);
  const save = async (next: boolean, versions: { baseVersion: string; agreementVersion: number }) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    setConfirm(null);
    setAlert(null);
    try {
      const result = await api.operatorApprovalWaiver(key, { ...versions, enabled: next });
      client.setQueryData<ConfigView>(queryKeys.config(key), (current) =>
        current
          ? {
              ...current,
              version: result.version,
              config: {
                ...current.config,
                team: { ...current.config.team, operatorApprovalWaiver: result.enabled },
              },
            }
          : current,
      );
      await refresh();
      toast.show(t(result.enabled ? 'knowledge.waiver.successOn' : 'knowledge.waiver.successOff'), 'ok');
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        await refresh();
        setAlert('conflict');
      } else if (isApiError(error) && error.code === 'owner_approval_required') setAlert('ownerOnly');
      else toast.show(errorMessage(error), 'error');
    } finally {
      busy.current = false;
      setSaving(false);
      requestAnimationFrame(() => control.current?.focus());
    }
  };
  return (
    <section className={styles.section}>
      <h4 id={title}>{t('knowledge.waiver.title')}</h4>
      {isOwner ? (
        <>
          <label className={styles.switch}>
            <input
              ref={control}
              type="checkbox"
              role="switch"
              checked={enabled}
              disabled={saving || agreementVersion === null}
              aria-labelledby={title}
              aria-describedby={description}
              onChange={() => {
                if (busy.current || agreementVersion === null) return;
                const versions = { baseVersion: config.version, agreementVersion };
                if (enabled) void save(false, versions);
                else setConfirm(versions);
              }}
            />
          </label>
          <p id={description}>
            {t(
              saving
                ? 'knowledge.waiver.saving'
                : agreementVersion === null
                  ? 'knowledge.waiver.missing'
                  : enabled
                    ? 'knowledge.waiver.on'
                    : 'knowledge.waiver.off',
            )}
          </p>
        </>
      ) : (
        <>
          <p>
            {t('knowledge.waiver.admin', {
              value: t(enabled ? 'knowledge.waiver.enabled' : 'knowledge.waiver.disabled'),
            })}
          </p>
          <p className={styles.meta}>{t('knowledge.waiver.ownerOnly')}</p>
        </>
      )}
      {alert ? (
        <p role="alert" className={styles.alert}>
          {t(`knowledge.waiver.${alert}`)}
        </p>
      ) : null}
      <Fold summary={t('knowledge.waiver.scope')}>
        <WaiverScope />
      </Fold>
      <Dialog
        open={confirm !== null}
        title={t('knowledge.waiver.confirm')}
        onClose={() => setConfirm(null)}
        returnFocusRef={control}
        footer={
          <>
            <Button ref={cancel} variant="secondary" onClick={() => setConfirm(null)}>
              {t('knowledge.waiver.cancel')}
            </Button>
            <Button variant="primary" disabled={saving} onClick={() => confirm && void save(true, confirm)}>
              {t('knowledge.waiver.enable')}
            </Button>
          </>
        }
      >
        <p>{t('knowledge.waiver.description', { version: confirm?.agreementVersion ?? '' })}</p>
        <WaiverScope />
      </Dialog>
    </section>
  );
}
