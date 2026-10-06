import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { t } from '../../i18n/t';
import styles from './PrerequisiteWarning.module.css';

/**
 * The confirmation before a person starts a Senior card with a member who is no Senior (PM-349): the
 * card's reason is the question's answer to give. "Mégse" has the focus, so Enter does not go ahead.
 */
export function SeniorWarning({
  name,
  reason,
  loading,
  onConfirm,
  onClose,
}: {
  /** The member the card would go to; null: no confirmation shown. */
  name: string | null;
  /** Why the card is a Senior task. */
  reason: string | null;
  loading?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const reasonText = reason?.trim();
  return (
    <Dialog
      open={name !== null}
      onClose={onClose}
      title={t('seniorWarning.title')}
      description={
        reasonText
          ? t('seniorWarning.description', { reason: reasonText, name: name ?? '' })
          : t('seniorWarning.descriptionNoReason', { name: name ?? '' })
      }
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="md" autoFocus onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" size="md" className={styles.start} loading={loading} onClick={onConfirm}>
            {t('seniorWarning.confirm')}
          </Button>
        </>
      }
    />
  );
}
