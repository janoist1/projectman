import { useContext, useId, useState } from 'react';
import { Button } from '../../../components/Button';
import { Dialog } from '../../../components/Dialog';
import { t } from '../../../i18n/t';
import { LeaveGuardContext } from '../edit/LeaveGuard';
import type { RemoveFailure } from '../edit/useElementEdit';
import { deleteBlockText } from './deletion';
import type { DeleteBlock } from './deletion';
import styles from './DeleteSection.module.css';

interface DeleteSectionProps {
  kind: 'stage' | 'column';
  name: string;
  /** Why the delete is not offered now; the server decides in the end. */
  block: DeleteBlock | null;
  /** Saves the configuration without the element; null when it went through. */
  onDelete(): Promise<RemoveFailure | null>;
  /** The delete went through: the panel closes. */
  onDeleted(): void;
}

/**
 * The quiet "delete…" at the foot of a panel: the reason when it is not allowed, else a question, and a
 * delete that saves at once and can be undone from the toast. An unsaved draft is dropped (after asking)
 * before the question: the delete does not save it on the side.
 */
export function DeleteSection({ kind, name, block, onDelete, onDeleted }: DeleteSectionProps) {
  const guard = useContext(LeaveGuardContext);
  const reasonId = useId();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  /** What the last attempt answered; a fresh question (or a changed block) starts clean. */
  const [failure, setFailure] = useState<RemoveFailure | null>(null);

  const open = () => {
    setFailure(null);
    setConfirming(true);
  };
  const confirm = async () => {
    if (pending) return;
    setPending(true);
    const result = await onDelete();
    setPending(false);
    setConfirming(false);
    if (result === null) onDeleted();
    else setFailure(result);
  };

  const refusal =
    failure?.kind === 'conflict'
      ? t('settings.pipeline.delete.conflict', { name: failure.author })
      : failure
        ? (failure.reason ?? t('settings.pipeline.delete.failedNetwork'))
        : null;
  const reason = block ? deleteBlockText(block) : refusal;

  return (
    <section className={styles.section}>
      <Button
        variant="ghost"
        size="md"
        className={styles.button}
        disabled={block !== null}
        aria-describedby={reason ? reasonId : undefined}
        onClick={() => (guard ? guard.request(open) : open())}
      >
        {t(kind === 'stage' ? 'settings.pipeline.delete.stage' : 'settings.pipeline.delete.column')}
      </Button>
      {reason ? (
        <p id={reasonId} className={styles.reason} role={block === null ? 'alert' : undefined}>
          {reason}
          {block?.kind === 'check_failed' ? (
            <>
              {' '}
              <button type="button" className={styles.retry} onClick={block.retry}>
                {t('settings.pipeline.delete.retry')}
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      <Dialog
        role="alertdialog"
        open={confirming}
        size="sm"
        onClose={() => {
          if (!pending) setConfirming(false);
        }}
        title={t(
          kind === 'stage' ? 'settings.pipeline.delete.stageTitle' : 'settings.pipeline.delete.columnTitle',
          {
            name,
          },
        )}
        description={
          kind === 'stage'
            ? `${t('settings.pipeline.delete.stageBody')} ${t('settings.pipeline.delete.undoHint')}`
            : t('settings.pipeline.delete.undoHint')
        }
        footer={
          <>
            <Button
              size="md"
              variant="secondary"
              autoFocus
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button size="md" variant="dangerSolid" loading={pending} onClick={() => void confirm()}>
              {t('settings.pipeline.delete.confirm')}
            </Button>
          </>
        }
      />
    </section>
  );
}
