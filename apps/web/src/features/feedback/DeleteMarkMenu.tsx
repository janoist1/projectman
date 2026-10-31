import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { FeedbackMarkDetail } from '@projectman/shared';
import { useDeleteFeedback } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { MoreMenu } from '../../components/MoreMenu';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './FeedbackDialogs.module.css';

/**
 * "⋯" next to the status of a mark: the author, an owner or an admin deletes it. The server says who may
 * (`canDelete`); this only reads it. A card made from the mark or linked to it stays.
 */
export function DeleteMarkMenu({ mark, search }: { mark: FeedbackMarkDetail; search: string }) {
  const { key, myHandle } = useProject();
  const toast = useToast();
  const navigate = useNavigate();
  const remove = useDeleteFeedback(key, mark.id);
  const [confirm, setConfirm] = useState(false);

  if (!mark.canDelete) return null;
  const own = mark.author.handle === myHandle;

  const finish = (alreadyGone: boolean) => {
    setConfirm(false);
    toast.show(t(alreadyGone ? 'feedback.delete.gone' : 'feedback.delete.done'));
    navigate({ pathname: `/p/${key}/feedback`, search });
  };

  return (
    <>
      <MoreMenu label={t('common.moreActions')}>
        {(close) => (
          <Button
            variant="danger"
            onClick={() => {
              remove.reset();
              setConfirm(true);
              close();
            }}
          >
            {t('feedback.delete.menu')}
          </Button>
        )}
      </MoreMenu>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title={
          own ? t('feedback.delete.headingOwn') : t('feedback.delete.headingOf', { name: mark.author.name })
        }
        size="sm"
        error={remove.isError ? <ErrorBanner>{errorMessage(remove.error)}</ErrorBanner> : null}
        footer={
          <>
            <Button variant="secondary" size="md" onClick={() => setConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="dangerSolid"
              size="md"
              loading={remove.isPending}
              onClick={() => remove.mutate(undefined, { onSuccess: (result) => finish(result.alreadyGone) })}
            >
              {t('feedback.delete.submit')}
            </Button>
          </>
        }
      >
        <div className={styles.form}>
          <p className={styles.info}>{t('feedback.delete.info')}</p>
          {mark.card ? (
            <p className={styles.info}>{t('feedback.delete.keepsCard', { key: mark.card.key })}</p>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
