import { useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { t } from '../../../i18n/t';
import { DetailPanel, MissingSettingsElement } from '../DetailPanel';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import type { SettingsShow } from '../selection';
import { applyColumnDraft, columnDraftOf, sortColumnIssues } from './columnDraft';
import type { ColumnDraft } from './columnDraft';
import { ColumnForm } from './ColumnForm';
import { columnDeleteBlock, withoutColumn } from './deletion';
import { DeleteSection } from './DeleteSection';
import { PanelBands } from './PanelBands';
import { PanelFooter } from './PanelFooter';
import panelStyles from './PipelinePanel.module.css';
import styles from './StagePanel.module.css';

interface ColumnPanelProps {
  config: ProjectConfig;
  columnId: string;
  empty: ReactNode;
  onSelect(show: SettingsShow): void;
  onClose(): void;
  /** The column was deleted: the panel closes and the focus moves on. */
  onDeleted(columnId: string): void;
}

/** A board column as a form: its name and colour saved on their own; its stages as links, its id, the delete. */
export function ColumnPanel({ config, columnId, empty, onSelect, onClose, onDeleted }: ColumnPanelProps) {
  const { isOwner } = useProject();
  const formId = useId();
  const edit = useElementEdit<ColumnDraft>({
    key: `column:${columnId}`,
    initial: (current) => {
      const column = current.pipeline.columns.find((candidate) => candidate.id === columnId);
      return column ? columnDraftOf(current, column) : null;
    },
    apply: applyColumnDraft,
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) => t('settings.pipeline.edit.saved', { name: draft.name.trim() }),
    name: (draft) => draft.name.trim(),
  });
  const saved = config.pipeline.columns.find((column) => column.id === columnId);
  const draft = edit.draft;
  useLeaveGuard(edit.dirty, edit.discard, draft?.name.trim() || saved?.name || '');

  const sorted = useMemo(() => {
    if (!edit.candidate || !draft) return null;
    const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
    return sortColumnIssues([...edit.errors, ...failed], edit.candidate, columnId, draft);
  }, [edit.candidate, edit.errors, edit.failure, draft, columnId]);
  const block = useMemo(() => columnDeleteBlock(config, columnId, isOwner), [config, columnId, isOwner]);

  if (!draft || !saved)
    return (
      <DetailPanel open itemKey="gone" title={t('howWeWork.gone.title')} empty={empty} onClose={onClose}>
        <MissingSettingsElement onClose={onClose} />
      </DetailPanel>
    );

  const stages = config.pipeline.stages.filter((stage) => stage.columnId === columnId);
  const canSave =
    edit.dirty &&
    draft.name.trim() !== '' &&
    edit.errors.length === 0 &&
    edit.locked.length === 0 &&
    !edit.gone;

  return (
    <DetailPanel
      open
      itemKey={`column:${columnId}`}
      focusSignal={edit.saves}
      kicker={t('settings.pipeline.kickerColumn')}
      title={saved.name}
      empty={empty}
      footer={
        <PanelFooter
          edit={edit}
          canSave={canSave}
          formId={formId}
          submitLabel={t('settings.pipeline.edit.save')}
          onClose={onClose}
        />
      }
      onClose={onClose}
    >
      <PanelBands edit={edit} config={config} other={sorted?.other ?? []} />
      <ColumnForm
        formId={formId}
        draft={draft}
        update={(change) => edit.setDraft({ ...draft, ...change })}
        disabled={edit.saving || edit.gone}
        nameIssues={sorted?.name ?? []}
        onSubmit={() => {
          if (canSave) void edit.save();
        }}
      />
      <dl className={panelStyles.fields}>
        <div className={panelStyles.field}>
          <dt>{t('settings.pipeline.fields.stages')}</dt>
          <dd>
            {stages.length === 0 ? (
              <span className={panelStyles.muted}>{t('settings.pipeline.noStages')}</span>
            ) : (
              <ul className={panelStyles.list}>
                {stages.map((stage) => (
                  <li key={stage.id}>
                    <button
                      type="button"
                      className={panelStyles.link}
                      onClick={() => onSelect({ type: 'stage', id: stage.id })}
                    >
                      {stage.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </dd>
        </div>
      </dl>
      <p className={styles.id}>
        {t('settings.pipeline.id')} <code>{columnId}</code>
      </p>
      {edit.gone ? null : (
        <DeleteSection
          kind="column"
          name={saved.name}
          block={block}
          onDelete={() => edit.remove(withoutColumn(config, columnId), saved.name)}
          onDeleted={() => onDeleted(columnId)}
        />
      )}
    </DetailPanel>
  );
}
