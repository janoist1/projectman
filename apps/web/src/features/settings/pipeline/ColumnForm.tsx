import type { ReactNode } from 'react';
import clsx from 'clsx';
import { BoardColumnColor } from '@projectman/shared';
import { Icon } from '../../../components/Icon';
import { t } from '../../../i18n/t';
import { FieldErrors } from '../edit/FieldErrors';
import type { FieldIssue } from '../edit/FieldErrors';
import type { ColumnDraft } from './columnDraft';
import styles from './ColumnForm.module.css';
import stageStyles from './StagePanel.module.css';

interface ColumnFormProps {
  formId: string;
  draft: ColumnDraft;
  update(change: Partial<ColumnDraft>): void;
  disabled: boolean;
  nameIssues: readonly FieldIssue[];
  onSubmit(): void;
  /** Under the name: the new column's identifier preview. */
  nameNote?: ReactNode;
}

/** The two fields of a column: its name and the colour it shows in on the board; saved and new columns share them. */
export function ColumnForm({
  formId,
  draft,
  update,
  disabled,
  nameIssues,
  onSubmit,
  nameNote,
}: ColumnFormProps) {
  const errorId = `${formId}-name-errors`;
  return (
    <form
      id={formId}
      className={stageStyles.form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className={stageStyles.fields} disabled={disabled}>
        <div className={stageStyles.field}>
          <label htmlFor={`${formId}-name`}>{t('settings.pipeline.edit.name')}</label>
          <input
            id={`${formId}-name`}
            value={draft.name}
            required
            aria-invalid={nameIssues.length > 0}
            aria-describedby={nameIssues.length > 0 ? errorId : undefined}
            onChange={(event) => update({ name: event.target.value })}
          />
          {nameNote}
          <FieldErrors id={errorId} issues={nameIssues} />
        </div>
        <fieldset className={stageStyles.group}>
          <legend>{t('settings.pipeline.fields.color')}</legend>
          <div className={styles.colors}>
            {BoardColumnColor.options.map((color) => (
              <label key={color} className={clsx(styles.color, draft.color === color && styles.chosen)}>
                <input
                  type="radio"
                  name={`${formId}-color`}
                  value={color}
                  checked={draft.color === color}
                  onChange={() => update({ color })}
                />
                <span className={styles.swatch} style={{ background: `var(--column-${color}-fg)` }}>
                  {draft.color === color ? <Icon name="check" size={14} /> : null}
                </span>
                <span className={styles.colorName}>{t(`columnColors.${color}`)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
    </form>
  );
}
