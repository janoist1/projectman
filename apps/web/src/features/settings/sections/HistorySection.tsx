import { useState } from 'react';
import type { ConfigVersionEntry } from '@projectman/shared';
import { useRevertConfig } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { useToast } from '../../../components/toastContext';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import shared from '../settings.module.css';
import styles from './HistorySection.module.css';
import { SettingsSection } from './SettingsSection';

/** Saved configuration versions, newest first; owners may revert to an earlier one. */
export function HistorySection({
  history,
  current,
  canRevert,
}: {
  history: ConfigVersionEntry[];
  current: string;
  canRevert: boolean;
}) {
  const { key } = useProject();
  const revert = useRevertConfig(key);
  const toast = useToast();
  const [target, setTarget] = useState<ConfigVersionEntry | null>(null);
  return (
    <SettingsSection id="settings-history" title={t('settings.sections.history')}>
      <p className={shared.muted}>{t('settings.history.intro')}</p>
      {history.length === 0 ? <p className={shared.muted}>{t('settings.history.empty')}</p> : null}
      <ol className={styles.history}>
        {history.map((entry) => {
          const isCurrent = entry.version === current;
          return (
            <li key={entry.version} className={styles.version}>
              <code className={styles.versionTag}>{entry.version.slice(0, 7)}</code>
              <div className={styles.versionText}>
                <span className={styles.versionMessage}>{entry.message}</span>
                <span className={shared.muted}>
                  {t('settings.history.by', {
                    author: entry.via ? t('involvement.integratorFull') : entry.author,
                    time: formatStamp(entry.at),
                  })}
                </span>
              </div>
              {isCurrent ? (
                <Chip tone="ok">{t('settings.history.current')}</Chip>
              ) : canRevert ? (
                <Button variant="secondary" size="sm" icon="undo" onClick={() => setTarget(entry)}>
                  {t('settings.history.revert')}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {!canRevert ? <p className={shared.muted}>{t('settings.history.ownerOnly')}</p> : null}
      <Dialog
        open={target !== null}
        onClose={() => setTarget(null)}
        title={target ? t('settings.history.revertTitle', { version: target.version.slice(0, 7) }) : ''}
        description={t('settings.history.revertBody')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon="undo"
              loading={revert.isPending}
              onClick={() => {
                if (!target) return;
                revert.mutate(target.version, {
                  onSuccess: () => {
                    toast.show(t('settings.history.reverted', { version: target.version.slice(0, 7) }));
                    setTarget(null);
                  },
                  onError: (error) => toast.show(errorMessage(error), 'error'),
                });
              }}
            >
              {t('settings.history.revert')}
            </Button>
          </>
        }
      />
    </SettingsSection>
  );
}
