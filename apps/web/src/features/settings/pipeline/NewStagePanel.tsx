import { useEffect, useId, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { pipelineId } from '../../../lib/ids';
import { DetailPanel } from '../DetailPanel';
import { EditFooter } from '../edit/EditChrome';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { orderColumns } from './flow';
import { PanelBands } from './PanelBands';
import { StageForm } from './StageForm';
import { NEW_COLUMN, sortIssues, stageOf } from './stageDraft';
import type { StageDraft } from './stageDraft';
import styles from './StagePanel.module.css';

/** The new stage's fields, and where it goes: `after` is the stage it follows, null in front of the first. */
interface NewStageDraft extends StageDraft {
  after: string | null;
  /** The person chose the column: a change of place no longer suggests one. */
  columnTouched: boolean;
}

/** The place the path offers by default: just before its last stage (the end). */
function defaultAfter(config: ProjectConfig): string | null {
  const stages = config.pipeline.stages;
  return stages.length >= 2 ? stages[stages.length - 2]!.id : null;
}

/** The column the stage before a place is in (the first stage's, in front of it): the suggestion for a new one. */
function columnAt(config: ProjectConfig, after: string | null): string {
  const stages = config.pipeline.stages;
  const neighbour = after === null ? stages[0] : stages.find((stage) => stage.id === after);
  return neighbour?.columnId ?? config.pipeline.columns[0]?.id ?? '';
}

function blank(config: ProjectConfig, requested: string | undefined): NewStageDraft {
  const after =
    requested === ''
      ? null
      : requested !== undefined && config.pipeline.stages.some((stage) => stage.id === requested)
        ? requested
        : defaultAfter(config);
  return {
    id: '',
    name: '',
    description: '',
    kind: 'step',
    columnId: columnAt(config, after),
    duty: null,
    ownersMode: 'names',
    members: [],
    conditions: [],
    after,
    columnTouched: false,
  };
}

/** The identifiers a new stage (and its new column) would get from the name. */
function idsOf(config: ProjectConfig, draft: NewStageDraft): { stage: string; column: string } {
  return {
    stage: pipelineId(
      draft.name,
      config.pipeline.stages.map((stage) => stage.id),
    ),
    column: pipelineId(
      draft.name,
      config.pipeline.columns.map((column) => column.id),
    ),
  };
}

/** Where a draft goes: after its stage; a stage that disappeared meanwhile leaves the default place. */
function placeIndex(config: ProjectConfig, after: string | null): number {
  if (after === null) return 0;
  const index = config.pipeline.stages.findIndex((stage) => stage.id === after);
  if (index >= 0) return index + 1;
  return Math.max(0, config.pipeline.stages.length - 1);
}

function applyNew(config: ProjectConfig, draft: NewStageDraft): ProjectConfig {
  const ids = idsOf(config, draft);
  const columns = [...config.pipeline.columns];
  let columnId = draft.columnId;
  const created = columnId === NEW_COLUMN;
  if (created) {
    columnId = ids.column;
    columns.push({ id: ids.column, name: draft.name.trim() });
  }
  const stages = [...config.pipeline.stages];
  stages.splice(placeIndex(config, draft.after), 0, stageOf({ ...draft, id: ids.stage, columnId }));
  const ordered = orderColumns({ ...config.pipeline, columns, stages });
  return {
    ...config,
    pipeline: {
      ...ordered,
      // A new column takes the default colour of the place it ends up in, not of where it was appended.
      columns: ordered.columns.map((column) =>
        created && column.id === ids.column ? { id: column.id, name: column.name } : column,
      ),
    },
  };
}

interface NewStagePanelProps {
  config: ProjectConfig;
  /** From the address: the stage the new one follows ('' in front of the first), none: before the end. */
  after: string | undefined;
  empty: ReactNode;
  onClose(): void;
  /** The stage was saved: the address moves on to it. */
  onCreated(stageId: string): void;
}

/** A new stage: its place, kind, column (an existing one or a new one named like it), owners and gate. */
export function NewStagePanel({ config, after, empty, onClose, onCreated }: NewStagePanelProps) {
  const formId = useId();
  const edit = useElementEdit<NewStageDraft>({
    key: `new-stage:${after ?? ''}`,
    initial: (current) => blank(current, after),
    apply: applyNew,
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) => t('settings.pipeline.edit.saved', { name: draft.name.trim() }),
    name: (draft) => draft.name.trim(),
  });
  const draft = edit.draft;
  useLeaveGuard(edit.dirty, edit.discard, draft?.name.trim() || t('settings.pipeline.new.stageTitle'));
  // The identifier of the stage being saved; the address moves to it once the save went through.
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
    return sortIssues([...edit.errors, ...failed], edit.candidate, idsOf(config, draft).stage, draft);
  }, [edit.candidate, edit.errors, edit.failure, draft, config]);

  // A new panel always has a draft; the stages the neighbours name are in `config`.
  if (!draft) return null;
  const update = (change: Partial<StageDraft>) =>
    edit.setDraft({ ...draft, ...change, ...('columnId' in change ? { columnTouched: true } : {}) });
  const ids = idsOf(config, draft);
  const named = draft.name.trim() !== '';
  const stages = config.pipeline.stages;
  const lastIsEnd = stages[stages.length - 1]?.kind === 'done';
  const targets = lastIsEnd ? stages.slice(0, -1) : stages;
  const placeGone = draft.after !== null && !stages.some((stage) => stage.id === draft.after);
  const canSave =
    edit.dirty && named && !placeGone && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;
  const placeId = `${formId}-place`;

  const place = (
    <div className={styles.field}>
      <label htmlFor={placeId}>{t('settings.pipeline.new.place')}</label>
      <select
        id={placeId}
        value={draft.after ?? ''}
        aria-invalid={placeGone}
        aria-describedby={placeGone ? `${placeId}-error` : undefined}
        onChange={(event) => {
          const next = event.target.value === '' ? null : event.target.value;
          edit.setDraft({
            ...draft,
            after: next,
            columnId: draft.columnTouched ? draft.columnId : columnAt(config, next),
          });
        }}
      >
        {placeGone ? (
          <option value={draft.after!} disabled>
            {t('settings.pipeline.new.placeChoose')}
          </option>
        ) : null}
        <option value="">{t('settings.pipeline.new.placeFirst')}</option>
        {targets.map((stage) => (
          <option key={stage.id} value={stage.id}>
            {t('settings.pipeline.new.placeAfter', { name: stage.name })}
          </option>
        ))}
      </select>
      {placeGone ? (
        <p id={`${placeId}-error`} className={styles.hintText} role="alert">
          {t('settings.pipeline.new.placeGone')}
        </p>
      ) : null}
    </div>
  );

  return (
    <DetailPanel
      open
      itemKey={`new-stage:${after ?? ''}`}
      focusSignal={edit.saves}
      kicker={t('settings.pipeline.kickerNewStage')}
      title={t('settings.pipeline.new.stageTitle')}
      empty={empty}
      footer={
        <EditFooter
          edit={edit}
          canSave={canSave}
          formId={formId}
          saveText={t('settings.pipeline.createStage')}
          cancel="close"
          onClose={onClose}
        />
      }
      onClose={onClose}
    >
      <PanelBands edit={edit} config={config} other={sorted?.other ?? []} />
      <StageForm
        formId={formId}
        config={config}
        draft={draft}
        update={update}
        disabled={edit.saving}
        issuesAt={(field) => sorted?.fields.get(field) ?? []}
        nameNote={
          named ? (
            <p className={styles.hintText}>{t('settings.pipeline.new.idPreview', { id: ids.stage })}</p>
          ) : null
        }
        place={place}
        newColumnName={draft.name}
        columnNote={
          draft.columnId === NEW_COLUMN && named ? (
            <p className={styles.hintText}>
              {t('settings.pipeline.new.columnIdPreview', { id: ids.column })}
            </p>
          ) : null
        }
        onSubmit={() => {
          if (!canSave) return;
          creating.current = ids.stage;
          void edit.save();
        }}
      />
    </DetailPanel>
  );
}
