import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import styles from './EditChrome.module.css';
import type { FieldIssue } from './FieldErrors';
import type { ElementEdit } from './useElementEdit';

type EditState = Pick<
  ElementEdit<unknown>,
  'gone' | 'conflict' | 'failure' | 'dirty' | 'locked' | 'errors' | 'saving' | 'discard'
>;

/** What an element panel says above its form: the element is gone, someone saved first, or the save failed. */
export function EditBand({
  edit,
  conflictName,
  other,
}: {
  edit: Pick<EditState, 'gone' | 'conflict' | 'failure'>;
  /** Who saved first, as a name to show. */
  conflictName: string;
  /** The refusals that belong to no field of the form. */
  other: readonly FieldIssue[];
}): ReactNode {
  if (edit.gone)
    return (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.gone')}
      </p>
    );
  if (edit.conflict)
    return (
      <p className={clsx(styles.band, styles.warning)} role="status">
        {t('settings.pipeline.edit.conflict', { name: conflictName })}
      </p>
    );
  const failure = edit.failure;
  if (failure?.kind === 'owner_only')
    return (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {t('settings.pipeline.edit.ownerOnly')}
      </p>
    );
  if (failure?.kind === 'error')
    return (
      <p className={clsx(styles.band, styles.danger)} role="alert">
        {failure.reason
          ? t('settings.pipeline.edit.failed', { reason: failure.reason })
          : t('settings.pipeline.edit.failedNetwork')}
      </p>
    );
  if (other.length === 0) return null;
  return (
    <div className={clsx(styles.band, styles.danger)} role="alert">
      <p>{t('settings.pipeline.edit.failed', { reason: other.map((issue) => issue.message).join(' ') })}</p>
      <details>
        <summary>{t('settings.pipeline.edit.details')}</summary>
        {other.map((issue) => (
          <code key={`${issue.code}:${issue.path}`}>
            {issue.code} · {issue.path}
          </code>
        ))}
      </details>
    </div>
  );
}

/** The panel's sticky foot: the unsaved mark and the Save / Cancel pair, or only Close for a gone element. */
export function EditFooter({
  edit,
  formId,
  canSave,
  saveText,
  onClose,
  cancel,
}: {
  edit: EditState;
  formId: string;
  canSave: boolean;
  /** The Save button's text when idle (adding names it differently). */
  saveText: string;
  onClose(): void;
  /** A new element's cancel closes the panel (asking first when something was typed); a saved one's drops the draft. */
  cancel?: 'close';
}) {
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
          {edit.saving ? t('settings.pipeline.edit.saving') : saveText}
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
