import { useEffect, useId, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { DetailPanel } from '../DetailPanel';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { appendColumn, blankColumn, newColumnId, sortColumnIssues } from './columnDraft';
import type { ColumnDraft } from './columnDraft';
import { ColumnForm } from './ColumnForm';
import { PanelBands } from './PanelBands';
import { PanelFooter } from './PanelFooter';
import styles from './StagePanel.module.css';

interface NewColumnPanelProps {
  config: ProjectConfig;
  empty: ReactNode;
  onClose(): void;
  /** The column was saved: the address moves on to it. */
  onCreated(columnId: string): void;
}

/** A new column: a name and a colour; it joins the columns without a stage, at the end. */
export function NewColumnPanel({ config, empty, onClose, onCreated }: NewColumnPanelProps) {
  const formId = useId();
  const edit = useElementEdit<ColumnDraft>({
    key: 'new-column',
    initial: blankColumn,
    apply: appendColumn,
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) => t('settings.pipeline.edit.saved', { name: draft.name.trim() }),
    name: (draft) => draft.name.trim(),
  });
  const draft = edit.draft;
  useLeaveGuard(edit.dirty, edit.discard, draft?.name.trim() || t('settings.pipeline.new.columnTitle'));
  // The identifier of the column being saved; the address moves to it once the save went through.
  const creating = useRef<string | null>(null);
  const saves = edit.saves;
  useEffect(() => {
    if (saves > 0 && creating.current) {
      onCreated(creating.current);
      creating.current = null;
    }
  }, [saves]);

  const sorted = useMemo(() => {
    if (!edit.candidate || !draft) return null;
    const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
    return sortColumnIssues(
      [...edit.errors, ...failed],
      edit.candidate,
      newColumnId(config, draft.name),
      draft,
    );
  }, [edit.candidate, edit.errors, edit.failure, draft, config]);

  if (!draft) return null;
  const id = newColumnId(config, draft.name);
  const named = draft.name.trim() !== '';
  const canSave = edit.dirty && named && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;

  return (
    <DetailPanel
      open
      itemKey="new-column"
      focusSignal={edit.saves}
      kicker={t('settings.pipeline.kickerNewColumn')}
      title={t('settings.pipeline.new.columnTitle')}
      empty={empty}
      footer={
        <PanelFooter
          edit={edit}
          canSave={canSave}
          formId={formId}
          submitLabel={t('settings.pipeline.createColumn')}
          cancel="close"
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
        disabled={edit.saving}
        nameIssues={sorted?.name ?? []}
        nameNote={
          named ? <p className={styles.hintText}>{t('settings.pipeline.new.idPreview', { id })}</p> : null
        }
        onSubmit={() => {
          if (!canSave) return;
          creating.current = id;
          void edit.save();
        }}
      />
    </DetailPanel>
  );
}
