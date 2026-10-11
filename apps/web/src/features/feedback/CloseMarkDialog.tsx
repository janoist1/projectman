import { useId, useState } from 'react';
import type { FeedbackMarkDetail } from '@projectman/shared';
import { useCloseFeedback } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog, DialogActions } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TextAreaField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './FeedbackDialogs.module.css';

function CloseForm({ mark, onClose }: { mark: FeedbackMarkDetail; onClose: () => void }) {
  const { key } = useProject();
  const toast = useToast();
  const close = useCloseFeedback(key, mark.id);
  const formId = useId();
  const [reply, setReply] = useState('');

  return (
    <form
      id={formId}
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (close.isPending) return;
        close.mutate(reply.trim() ? { reply: reply.trim() } : {}, {
          onSuccess: () => {
            toast.show(t('feedback.close.done'));
            onClose();
          },
        });
      }}
    >
      <p className={styles.info}>{t('feedback.close.info', { name: mark.author.name })}</p>
      <TextAreaField
        label={t('feedback.reply.label')}
        optional
        rows={3}
        autoFocus
        value={reply}
        maxLength={4000}
        disabled={close.isPending}
        onChange={(event) => setReply(event.target.value)}
      />
      <DialogActions error={close.error ? <ErrorBanner>{errorMessage(close.error)}</ErrorBanner> : null}>
        <Button type="button" variant="secondary" size="md" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" form={formId} size="md" loading={close.isPending}>
          {t('feedback.close.submit')}
        </Button>
      </DialogActions>
    </form>
  );
}

/** "Lezárom": the mark is done; an optional last answer goes to the marker. */
export function CloseMarkDialog({
  open,
  mark,
  onClose,
}: {
  open: boolean;
  mark: FeedbackMarkDetail;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={t('feedback.close.heading')} size="sm">
      {open ? <CloseForm mark={mark} onClose={onClose} /> : null}
    </Dialog>
  );
}
