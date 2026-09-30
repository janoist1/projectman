import type { GateCondition, Pipeline, ProjectConfig, Stage } from '@projectman/shared';
import { Button } from '../../../components/Button';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import shared from '../settings.module.css';
import { GateConditionsEditor, isApprovalLabel } from './GateConditionsEditor';
import { StageFields, StageOwners } from './StageFields';

/** Issues whose path points at this stage of the pipeline that was sent ("pipeline.stages[2].gate…"). */
function stageIssues(issues: readonly IssueRef[], stage: Stage, sent: Pipeline): IssueRef[] {
  return issues.filter((issue) => {
    const match = /^pipeline\.stages(?:\[(\d+)\]|\.(\d+))(?:\.|$)/.exec(issue.path);
    return match && sent.stages[Number(match[1] ?? match[2])]?.id === stage.id;
  });
}

/** One stage in the pipeline editor: its fields, order, owners, gate, issues and removal. */
export function StageCard({
  draft,
  index,
  change,
  isOwner,
  issues,
  sent,
  onRemove,
}: {
  draft: ProjectConfig;
  index: number;
  change: (update: (draft: ProjectConfig) => void) => void;
  isOwner: boolean;
  issues: readonly IssueRef[];
  /** The pipeline the issues refer to (the one last sent, or the draft). */
  sent: Pipeline;
  onRemove: (stage: Stage) => void;
}) {
  const stage = draft.pipeline.stages[index]!;
  const conditions = stage.gate?.conditions ?? [];
  const labels = draft.pipeline.labels;
  const update = (update: (stage: Stage) => void) =>
    change((config) => update(config.pipeline.stages[index]!));
  const updateConditions = (next: GateCondition[]) =>
    change((config) => {
      config.pipeline.stages[index]!.gate = next.length ? { conditions: next } : undefined;
    });
  return (
    <li className={shared.stage} aria-label={stage.name}>
      <StageFields stage={stage} pipeline={draft.pipeline} update={update} />
      {stageIssues(issues, stage, sent).map((issue, i) => (
        <p key={i} className={shared.validation} role="alert">
          {issueMessage(issue)}
        </p>
      ))}
      <div className={shared.actions}>
        {([-1, 1] as const).map((offset) => (
          <Button
            key={offset}
            variant="secondary"
            disabled={index + offset < 0 || index + offset >= draft.pipeline.stages.length}
            onClick={() =>
              change((config) => {
                const stages = config.pipeline.stages;
                [stages[index], stages[index + offset]] = [stages[index + offset]!, stages[index]!];
              })
            }
          >
            {t(offset === -1 ? 'settings.edit.moveUp' : 'settings.edit.moveDown')}
          </Button>
        ))}
      </div>
      <Button
        variant="danger"
        disabled={!isOwner && conditions.some((condition) => isApprovalLabel(labels, condition.label))}
        onClick={() => onRemove(stage)}
      >
        {t('settings.pipeline.removeStage')}
      </Button>
      <StageOwners stage={stage} config={draft} update={update} />
      <GateConditionsEditor
        conditions={conditions}
        labels={labels}
        isOwner={isOwner}
        onChange={updateConditions}
      />
    </li>
  );
}
