import { useChecklist } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { t } from '../../i18n/t';
import styles from './OperatorChecklist.module.css';

export function ChecklistIndicator() {
  const { key, me, openOperator } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const enabled = access === 'owner' || access === 'admin';
  const query = useChecklist(key, enabled);
  const checklist = query.data?.checklist;
  if (!enabled || query.isPending || query.isError || !checklist?.items.length || checklist.progress.complete)
    return null;
  const { settled, total } = checklist.progress;
  return (
    <button
      className={styles.indicator}
      aria-label={t('operator.checklist.indicator.label', { settled, total })}
      aria-controls="operator-panel"
      title={t('operator.checklist.indicator.title')}
      onClick={(event) => openOperator(event.currentTarget, undefined, { checklist: true })}
    >
      <svg className={styles.ring} viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <circle
          className={styles.progressRing}
          cx="12"
          cy="12"
          r="9"
          pathLength="100"
          strokeDasharray="100"
          strokeDashoffset={100 - (settled / total) * 100}
        />
      </svg>
      <span className={styles.fullLabel}>{t('operator.checklist.indicator.text', { settled, total })}</span>
      <span className={styles.shortLabel} aria-hidden="true">
        {settled}/{total}
      </span>
    </button>
  );
}
