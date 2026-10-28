import { useState } from 'react';
import type { ConfigVersionEntry } from '@projectman/shared';
import clsx from 'clsx';
import { useRevertConfig } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { ActorName } from '../../../components/ActorName';
import { Button } from '../../../components/Button';
import { Chip } from '../../../components/Chip';
import { Dialog } from '../../../components/Dialog';
import { useToast } from '../../../components/toastContext';
import { formatStamp } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import type { MemberIndex } from '../../../lib/members';
import { actorLabel, nameOf } from '../../../lib/members';
import shared from '../settings.module.css';
import styles from './HistorySection.module.css';
import { SettingsSection } from './SettingsSection';

/** Who a saved version is shown as: the Operator by name when it made the change, else the stored author. */
export function historyAuthorOf(
  entry: ConfigVersionEntry,
  members: MemberIndex,
  myHandle: string | null,
): string {
  if (entry.actor) return actorLabel(entry.actor, members, myHandle);
  if (entry.operator) return nameOf(entry.operator, members, myHandle);
  return entry.via ? t('involvement.integratorFull') : entry.author;
}

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
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
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
          const operatorMember = entry.operator ? members.get(entry.operator) : undefined;
          return (
            <li key={entry.version} className={styles.version}>
              <code className={styles.versionTag}>{entry.version.slice(0, 7)}</code>
              <div className={styles.versionText}>
                <span className={styles.versionMessage}>{entry.message}</span>
                <span className={clsx(shared.muted, styles.byLine)}>
                  {operatorMember ? <Avatar member={operatorMember} size="xs" /> : null}
                  {entry.actor ? (
                    <ActorName
                      actor={entry.actor}
                      members={members}
                      myHandle={myHandle}
                      projectKey={key}
                      history
                      after={
                        <>
                          <span aria-hidden="true"> ·&nbsp;</span>
                          <time dateTime={entry.at}>{formatStamp(entry.at)}</time>
                        </>
                      }
                    />
                  ) : (
                    t('settings.history.by', {
                      author: historyAuthorOf(entry, members, myHandle),
                      time: formatStamp(entry.at),
                    })
                  )}
                  {entry.approvedBy ? (
                    <Chip tone="ok">
                      {t('settings.history.approvedBy', {
                        name: nameOf(entry.approvedBy, members, myHandle),
                      })}
                    </Chip>
                  ) : null}
                </span>
                {entry.request ? (
                  <span className={styles.request} title={entry.request}>
                    {t('settings.history.request', { quote: entry.request })}
                  </span>
                ) : null}
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
