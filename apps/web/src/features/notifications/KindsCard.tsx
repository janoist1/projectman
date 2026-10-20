import type { PushCategories, PushSettings } from '@projectman/shared';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import { failText } from './deviceText';
import styles from './notifications.module.css';
import { useSavePushSettings } from './usePush';

const KINDS: ReadonlyArray<{
  id: keyof PushCategories;
  title: PlainMessageKey;
  hint: PlainMessageKey;
}> = [
  { id: 'question', title: 'notifications.kinds.question', hint: 'notifications.kinds.questionHint' },
  { id: 'decision', title: 'notifications.kinds.decision', hint: 'notifications.kinds.decisionHint' },
  { id: 'approval', title: 'notifications.kinds.approval', hint: 'notifications.kinds.approvalHint' },
  { id: 'permission', title: 'notifications.kinds.permission', hint: 'notifications.kinds.permissionHint' },
  { id: 'release', title: 'notifications.kinds.release', hint: 'notifications.kinds.releaseHint' },
];

/** The five kinds of items worth a notification, each with its switch; saved at once (PM-815). */
export function KindsCard({ settings }: { settings: PushSettings }) {
  const toast = useToast();
  const save = useSavePushSettings();

  function change(id: keyof PushCategories, enabled: boolean) {
    save.mutate(
      { ...settings, categories: { ...settings.categories, [id]: enabled } },
      {
        onSuccess: () => toast.show(t('notifications.kinds.saved'), 'ok'),
        onError: (error) => toast.show(failText(error, t('notifications.kinds.saveFailed')), 'error'),
      },
    );
  }

  return (
    <div className={styles.card}>
      <ul className={styles.rows}>
        {KINDS.map((kind) => (
          <li key={kind.id} className={styles.row}>
            <label className={styles.rowLabel} htmlFor={`push-kind-${kind.id}`}>
              <span className={styles.rowTitle}>{t(kind.title)}</span>
              <span className={styles.rowHint}>{t(kind.hint)}</span>
            </label>
            <input
              id={`push-kind-${kind.id}`}
              type="checkbox"
              role="switch"
              className={styles.switch}
              checked={settings.categories[kind.id]}
              onChange={(event) => change(kind.id, event.target.checked)}
            />
          </li>
        ))}
      </ul>
      <p className={styles.foot}>{t('notifications.kinds.foot')}</p>
    </div>
  );
}
