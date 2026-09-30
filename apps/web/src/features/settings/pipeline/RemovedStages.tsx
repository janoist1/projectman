import type { Pipeline, ProjectConfig } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import shared from '../settings.module.css';

/** Stages removed in this edit, each with an undo that puts it back where it was. */
export function RemovedStages({
  draft,
  original,
  change,
}: {
  draft: ProjectConfig;
  original: Pipeline;
  change: (update: (draft: ProjectConfig) => void) => void;
}) {
  const removed = original.stages.filter(
    (stage) => !draft.pipeline.stages.some((entry) => entry.id === stage.id),
  );
  return removed.map((stage) => (
    <div key={stage.id} className={shared.stage}>
      <p>{t('settings.pipeline.removedStage', { stage: stage.name })}</p>
      <Button
        onClick={() =>
          change((config) => {
            if (!config.pipeline.columns.some((column) => column.id === stage.columnId)) {
              config.pipeline.columns.push(
                structuredClone(original.columns.find((column) => column.id === stage.columnId)!),
              );
            }
            const position = original.stages.findIndex((entry) => entry.id === stage.id);
            const next = original.stages
              .slice(position + 1)
              .find((entry) => config.pipeline.stages.some((value) => value.id === entry.id));
            const index = next
              ? config.pipeline.stages.findIndex((entry) => entry.id === next.id)
              : config.pipeline.stages.length;
            config.pipeline.stages.splice(index, 0, structuredClone(stage));
          })
        }
      >
        {t('settings.pipeline.undoRemove')}
      </Button>
    </div>
  ));
}
