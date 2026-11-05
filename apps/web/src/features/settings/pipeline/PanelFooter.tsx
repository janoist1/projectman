import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import type { ElementEdit } from '../edit/useElementEdit';
import styles from './StagePanel.module.css';

interface PanelFooterProps {
  edit: Pick<ElementEdit<unknown>, 'gone' | 'dirty' | 'locked' | 'errors' | 'saving' | 'discard'>;
  canSave: boolean;
  /** "Mentés", or "Lépés hozzáadása" on a new one. */
  submitLabel: string;
  formId: string;
  onClose(): void;
  /** A new element's cancel closes the panel (asking first when something was typed); a saved one's drops the draft. */
  cancel?: 'close';
}

/** The pinned buttons: save (the form's submit), cancel, and what the unsaved draft is missing. */
export function PanelFooter({ edit, canSave, submitLabel, formId, onClose, cancel }: PanelFooterProps) {
  if (edit.gone)
    return (
      <div className={styles.footer}>
        <Button variant="secondary" onClick={onClose}>
          {t('settings.pipeline.edit.goneClose')}
        </Button>
      </div>
    );
  return (
    <div className={styles.footer}>
      <div className={styles.status}>
        {edit.dirty ? (
          <span className={styles.unsaved}>
            <span aria-hidden="true">●</span> {t('settings.pipeline.edit.unsaved')}
          </span>
        ) : null}
        {edit.locked.length > 0 ? (
          <span className={styles.hint}>{t('settings.edit.approvalOwnerOnly')}</span>
        ) : edit.errors.length > 0 ? (
          <span className={styles.hint}>{t('settings.pipeline.edit.fixFirst')}</span>
        ) : null}
      </div>
      <div className={styles.buttons}>
        <Button type="submit" form={formId} variant="primary" disabled={!canSave} loading={edit.saving}>
          {edit.saving ? t('settings.pipeline.edit.saving') : submitLabel}
        </Button>
        <Button
          variant="secondary"
          disabled={edit.saving || (cancel === undefined && !edit.dirty)}
          onClick={cancel === 'close' ? onClose : edit.discard}
        >
          {t('settings.pipeline.edit.cancel')}
        </Button>
      </div>
    </div>
  );
}
