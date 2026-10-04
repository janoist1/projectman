import { stageOf } from '@projectman/shared';
import type { ProjectConfig, TeamRule } from '@projectman/shared';
import { code, codeList, labelRef, stageLabel } from './format';

/** Describe every shared rule in the member's system instructions. */
export function describeTeamRule(rule: TeamRule, project: ProjectConfig): string {
  const labels = (ids: string[], separator = ', ') =>
    ids.map((id) => labelRef(id, project.pipeline.labels)).join(separator);
  const stage = (id: string) => stageLabel(stageOf(project, id)!);
  switch (rule.id) {
    case 'new_card':
      return `New tasks: every AI member (create_task) and every human with ${code(rule.minimumAccess)} access or more may create a task. It starts unassigned in the first stage, ${stage(rule.firstStageId)}.`;
    case 'gates_in_order':
      return `Moves: a move forward enters every stage on the way, so all their gates must hold and none is skipped. A move back enters only the target stage${rule.clearedOnMoveBack.length ? ` and takes off ${labels(rule.clearedOnMoveBack)}` : ''}.`;
    case 'approvals':
      return `Approvals: ${labels(rule.labels)} are set only by humans; when a gate needs one, the app asks its holders in their inbox.`;
    case 'self_review':
      return `Nobody approves their own work: never set ${labels(rule.labels)} on a task you are assigned to or whose pull request you authored.`;
    case 'fix_limit':
      return `Fix rounds: ${rule.labels.length ? `adding ${labels(rule.labels, ' or ')}, or a send-back into a work stage,` : 'a send-back into a work stage'} counts as a round. When a task whose assignee is an AI member reaches ${rule.limit} rounds, the work no longer goes back to the implementer by itself: ${rule.lead ? `${code(rule.lead)} decides first, and a human (${codeList(rule.deciders)}) when it is passed on` : `a human decides in their inbox (${codeList(rule.deciders)})`}.`;
    case 'refinement': {
      const subjects = [
        ...(rule.label ? [`a task with label ${labelRef(rule.label, project.pipeline.labels)}`] : []),
        ...(rule.stageIds.length ? [`a task in ${rule.stageIds.map(stage).join(', ')}`] : []),
      ];
      return `Refinement: ${subjects.join(' or ')} is worked out before development: the labels the gates up to ${stage(rule.workStageId)} need${rule.steps.length ? ` (${labels(rule.steps)})` : ''} are set one after the other, one member at a time; the system hands each step to the member on turn and moves the task on when all are set.`;
    }
    case 'waiting_answer':
      return `Questions: while an AI member's question about a task is open, the task carries ${labelRef(rule.label, project.pipeline.labels)} and does not move forward; the label comes off when the last open question is answered.`;
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}
