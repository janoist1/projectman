import { useProject } from '../../app/contexts';
import { usePauseProject } from '../../api/queries';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { ErrorBanner } from '../../components/ErrorBanner';
import { t } from '../../i18n/t';
import { errorCode, errorMessage } from '../../lib/errors';
import styles from './PauseConfirmDialog.module.css';

/** Asks before the team is paused (PM-220); the dialog stays open with the refusal when the request fails. */
export function PauseConfirmDialog({
  open,
  onClose,
  onRequested,
}: {
  open: boolean;
  onClose: () => void;
  /** The id of the pause the request opened, for the bar's details to open by themselves. */
  onRequested: (pauseId: string | null) => void;
}) {
  const { key } = useProject();
  const pause = usePauseProject(key);
  const code = pause.error ? errorCode(pause.error) : null;

  const close = () => {
    pause.reset();
    onClose();
  };
  const submit = () =>
    pause.mutate(undefined, {
      onSuccess: (view) => {
        onRequested(view.project?.id ?? null);
        close();
      },
    });

  return (
    <Dialog
      open={open}
      onClose={close}
      size="sm"
      title={t('pause.confirm.title')}
      description={t('pause.confirm.body')}
      error={
        pause.error ? (
          <>
            <ErrorBanner>{errorMessage(pause.error)}</ErrorBanner>
            {code ? (
              <details className={styles.details}>
                <summary>{t('errors.details')}</summary>
                <span>{t('errors.code', { code })}</span>
              </details>
            ) : null}
          </>
        ) : null
      }
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            {t('pause.confirm.cancel')}
          </Button>
          <Button variant="primary" icon="pause" loading={pause.isPending} onClick={submit}>
            {pause.isPending ? t('pause.confirm.submitting') : t('pause.confirm.submit')}
          </Button>
        </>
      }
    />
  );
}
