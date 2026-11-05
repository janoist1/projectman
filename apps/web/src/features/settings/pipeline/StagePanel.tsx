import { useEffect, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { MoreMenu } from '../../../components/MoreMenu';
import { t } from '../../../i18n/t';
import { DetailPanel, MissingSettingsElement } from '../DetailPanel';
import { EditFooter } from '../edit/EditChrome';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { DeleteSection } from './DeleteSection';
import { stageDeleteBlock, withoutStage } from './deletion';
import type { CardCount } from './deletion';
import { focusRow } from './focusRow';
import { orderColumns } from './flow';
import { PanelBands } from './PanelBands';
import { StageForm } from './StageForm';
import { draftOf, sortIssues, stageOf } from './stageDraft';
import type { StageDraft } from './stageDraft';
import styles from './StagePanel.module.css';

function applyDraft(config: ProjectConfig, draft: StageDraft): ProjectConfig {
  const moved = config.pipeline.stages.find((stage) => stage.id === draft.id)?.columnId !== draft.columnId;
  const pipeline = {
    ...config.pipeline,
    stages: config.pipeline.stages.map((stage) => (stage.id === draft.id ? stageOf(draft) : stage)),
  };
  // A stage in another column can change which column comes first; a name or a gate never reorders.
  return { ...config, pipeline: moved ? orderColumns(pipeline) : pipeline };
}

interface StagePanelProps {
  config: ProjectConfig;
  stageId: string;
  /** The cards in the stage, as far as the board is known. */
  cards: CardCount;
  back?: ReactNode;
  empty: ReactNode;
  onClose(): void;
  /** A save or an undo went through: the stage's row marks the moment. */
  onSaved(stageId: string): void;
  /** The stage was deleted: the panel closes and the focus moves on. */
  onDeleted(stageId: string): void;
  /** "Új lépés elé" / "Új lépés utána": the new stage goes after `after` ('' in front of the first). */
  onNewStage(after: string): void;
}

/** The stage's details as a form: one stage saved on its own, with its conflicts, undo and unsaved-change guard. */
export function StagePanel({
  config,
  stageId,
  cards,
  back,
  empty,
  onClose,
  onSaved,
  onDeleted,
  onNewStage,
}: StagePanelProps) {
  const { isOwner } = useProject();
  const formId = useId();
  const edit = useElementEdit<StageDraft>({
    key: `stage:${stageId}`,
    initial: (current) => {
      const stage = current.pipeline.stages.find((candidate) => candidate.id === stageId);
      return stage ? draftOf(stage) : null;
    },
    apply: applyDraft,
    toPatch: (candidate) => ({ pipeline: candidate.pipeline }),
    savedText: (draft) => t('settings.pipeline.edit.saved', { name: draft.name.trim() }),
    name: (draft) => draft.name.trim(),
  });
  const stages = config.pipeline.stages;
  const saved = stages.find((stage) => stage.id === stageId);
  const savedIndex = stages.findIndex((stage) => stage.id === stageId);
  const draft = edit.draft;
  useLeaveGuard(edit.dirty, edit.discard, draft?.name.trim() || saved?.name || '');
  const saves = edit.saves;
  useEffect(() => {
    if (saves > 0) onSaved(stageId);
  }, [saves]);

  const sorted = useMemo(() => {
    if (!edit.candidate || !draft) return null;
    const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
    return sortIssues([...edit.errors, ...failed], edit.candidate, stageId, draft);
  }, [edit.candidate, edit.errors, edit.failure, draft, stageId]);
  const block = useMemo(
    () => stageDeleteBlock(config, stageId, cards, isOwner),
    [config, stageId, cards, isOwner],
  );

  if (!draft)
    return (
      <DetailPanel open itemKey="gone" title={t('howWeWork.gone.title')} empty={empty} onClose={onClose}>
        <MissingSettingsElement onClose={onClose} />
      </DetailPanel>
    );

  const update = (change: Partial<StageDraft>) => edit.setDraft({ ...draft, ...change });
  const kindLocked =
    saved !== undefined &&
    ((savedIndex === 0 && saved.kind === 'queue') ||
      (savedIndex === stages.length - 1 && saved.kind === 'done'));
  const kindLock = kindLocked
    ? savedIndex === 0
      ? t('settings.pipeline.edit.kindFirst')
      : t('settings.pipeline.edit.kindLast')
    : null;
  const disabled = edit.saving || edit.gone;
  const canSave = edit.dirty && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;
  /** Nothing follows the last stage when it is the end of the path. */
  const lastIsEnd = savedIndex === stages.length - 1 && saved?.kind === 'done';

  const menu = (
    <MoreMenu label={t('settings.pipeline.menu.label')}>
      {(close) => (
        <>
          <Button
            variant="ghost"
            size="md"
            onClick={() => {
              close();
              onNewStage(stages[savedIndex - 1]?.id ?? '');
            }}
          >
            {t('settings.pipeline.menu.before')}
          </Button>
          <Button
            variant="ghost"
            size="md"
            disabled={lastIsEnd}
            onClick={() => {
              close();
              onNewStage(stageId);
            }}
          >
            {t('settings.pipeline.menu.after')}
          </Button>
          {lastIsEnd ? <p className={styles.hintText}>{t('settings.pipeline.edit.kindLast')}</p> : null}
        </>
      )}
    </MoreMenu>
  );

  return (
    <DetailPanel
      open
      itemKey={`stage:${stageId}`}
      focusSignal={edit.saves}
      kicker={t('settings.pipeline.kickerStage', { kind: t(`stageKinds.${draft.kind}`) })}
      title={saved?.name ?? draft.name}
      menu={menu}
      back={back}
      empty={empty}
      footer={
        <EditFooter
          edit={edit}
          canSave={canSave}
          formId={formId}
          saveText={t('settings.pipeline.edit.save')}
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
        disabled={disabled}
        issuesAt={(field) => sorted?.fields.get(field) ?? []}
        kindLock={kindLock}
        withDescription
        onSubmit={() => {
          if (canSave) void edit.save();
        }}
      />
      {cards.status === 'ready' ? (
        <p className={styles.cards}>
          {cards.count === 0
            ? t('settings.pipeline.cardsNone')
            : t('settings.pipeline.cards', { count: cards.count })}
        </p>
      ) : null}
      <p className={styles.id}>
        {t('settings.pipeline.id')} <code>{draft.id}</code>
      </p>
      <p className={styles.id}>{t('settings.pipeline.idFixed')}</p>
      {edit.gone ? null : (
        <DeleteSection
          kind="stage"
          name={saved?.name ?? draft.name}
          block={block}
          onDelete={() =>
            edit.removeElement(withoutStage(config, stageId), saved?.name ?? draft.name, () =>
              focusRow(`stage:${stageId}`),
            )
          }
          onDeleted={() => onDeleted(stageId)}
        />
      )}
    </DetailPanel>
  );
}
