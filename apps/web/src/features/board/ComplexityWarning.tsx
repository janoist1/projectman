import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n/t';
import styles from './PrerequisiteWarning.module.css';

/** Confirm a manual start above the developer's limit. Cancel holds the initial focus. */
export function ComplexityWarning({
  name,
  points,
  limit,
  loading,
  onConfirm,
  onClose,
}: {
  /** The member the card would go to; null: no confirmation shown. */
  name: string | null;
  points: number;
  limit: number;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={name !== null}
      onClose={onClose}
      title={t('complexityWarning.title')}
      description={t('complexityWarning.description', { points, limit, name: name ?? '' })}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" autoFocus onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" className={styles.start} loading={loading} onClick={onConfirm}>
            {t('complexityWarning.confirm')}
          </Button>
        </>
      }
    />
  );
}
