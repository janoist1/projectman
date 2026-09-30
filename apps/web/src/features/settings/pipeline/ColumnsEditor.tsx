import { useState } from 'react';
import { BoardColumnColor, defaultBoardColumnColor } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';
import styles from './ColumnsEditor.module.css';
import { pipelineId } from './StageFields';

/** The board columns: name and colour of each, add, and remove once no stage uses it. */
export function ColumnsEditor({
  draft,
  change,
}: {
  draft: ProjectConfig;
  change: (update: (draft: ProjectConfig) => void) => void;
}) {
  const [columnName, setColumnName] = useState('');
  const [columnError, setColumnError] = useState<string | null>(null);
  const addColumn = () => {
    if (!columnName.trim()) return;
    change((config) => {
      config.pipeline.columns.push({
        id: pipelineId(
          columnName,
          config.pipeline.columns.map((column) => column.id),
        ),
        name: columnName.trim(),
      });
    });
    setColumnName('');
    setColumnError(null);
  };
  return (
    <fieldset className={shared.conditions}>
      <legend>{t('settings.pipeline.columns')}</legend>
      {draft.pipeline.columns.map((column, index) => (
        <div key={column.id} className={styles.column}>
          <label className={shared.field}>
            {t('settings.pipeline.columnName')}
            <input
              value={column.name}
              onChange={(event) =>
                change((config) => {
                  config.pipeline.columns[index]!.name = event.target.value;
                })
              }
            />
          </label>
          <fieldset className={styles.swatches}>
            <legend>{t('settings.pipeline.color')}</legend>
            {BoardColumnColor.options.map((color) => (
              <button
                type="button"
                key={color}
                className={styles.swatch}
                data-column-color={color}
                aria-label={t(`columnColors.${color}`)}
                aria-pressed={(column.color ?? defaultBoardColumnColor(index)) === color}
                onClick={() =>
                  change((config) => {
                    config.pipeline.columns[index]!.color = color;
                  })
                }
              />
            ))}
          </fieldset>
          <Button
            variant="secondary"
            onClick={() => {
              const count = draft.pipeline.stages.filter((stage) => stage.columnId === column.id).length;
              if (count) {
                setColumnError(t('settings.pipeline.columnInUse', { count }));
                return;
              }
              if (draft.pipeline.columns.length === 1) {
                setColumnError(t('settings.pipeline.lastColumn'));
                return;
              }
              setColumnError(null);
              change((config) => {
                config.pipeline.columns.splice(index, 1);
              });
            }}
          >
            {t('settings.pipeline.removeColumn')}
          </Button>
        </div>
      ))}
      {columnError && <p role="alert">{columnError}</p>}
      <label className={shared.field}>
        {t('settings.pipeline.columnName')}
        <input
          value={columnName}
          onChange={(event) => setColumnName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addColumn();
            }
          }}
        />
      </label>
      <Button disabled={!columnName.trim()} onClick={addColumn}>
        {t('settings.pipeline.addColumn')}
      </Button>
    </fieldset>
  );
}
