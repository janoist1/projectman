import type { LabelId } from '../domain/label';
import { WAITING_ANSWER_LABEL } from '../domain/label';
import type { Task } from '../domain/task';
import { evaluateMove } from './gates';
import { labelDefinition } from './labels';
import type { ProjectConfig } from './schema';

/** The missing human approval a question appears to ask for; answering never sets it. */
export function questionApprovalLabel(
  config: ProjectConfig,
  task: Pick<Task, 'stageId' | 'labels' | 'assignee' | 'links'>,
  question: { text: string; assignees: readonly string[] },
): LabelId | null {
  const stages = config.pipeline.stages;
  const index = stages.findIndex((stage) => stage.id === task.stageId);
  const next = stages[index + 1];
  const last = stages.at(-1);
  if (index < 0 || !next || !last) return null;
  const t = { ...task, labels: task.labels.filter((label) => label !== WAITING_ANSWER_LABEL) };
  const text = question.text.toLowerCase();
  const candidates = evaluateMove(t, config, task.stageId, last.id).approvals;
  for (const { label } of candidates) {
    const escaped = label.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const name = labelDefinition(config, label)?.name.toLowerCase();
    if (new RegExp(`(^|[^a-z0-9-])${escaped}($|[^a-z0-9-])`).test(text) || (name && text.includes(name)))
      return label;
  }
  const immediate = evaluateMove(t, config, task.stageId, next.id);
  if (immediate.unmet.length > 0) return null;
  return (
    immediate.approvals.find(({ approvers }) => approvers.some((h) => question.assignees.includes(h)))
      ?.label ?? null
  );
}
