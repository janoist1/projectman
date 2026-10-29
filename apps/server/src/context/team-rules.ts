import { developmentStage, stageOf } from '@projectman/shared';
import type { ProjectConfig, TeamRule } from '@projectman/shared';
import { code, codeList, labelRef, stageLabel } from './format';

/** Short index entries; full descriptions are served in the rules guide. */
export function summarizeTeamRule(rule: TeamRule, _project: ProjectConfig): string | null {
  switch (rule.id) {
    case 'approvals':
      return `Approvals: only humans set ${codeList(rule.labels)}; gates ask them in the inbox, never via ask_human.`;
    case 'self_review':
      return `No self-review: never set ${codeList(rule.labels)} on your assigned task or authored PR.`;
    case 'new_card':
      return `New tasks: AI or humans with ${code(rule.minimumAccess)} access; unassigned in ${code(rule.firstStageId)}.`;
    case 'gates_in_order':
      return `Moves: all forward gates apply; moving back clears ${codeList(rule.clearedOnMoveBack)}.`;
    case 'fix_limit':
      return `Fixes (${codeList(rule.labels)} / send-back): reaches ${rule.limit} rounds → ${rule.lead ? `${code(rule.lead)}, then ` : ''}humans (${codeList(rule.deciders)}) decide.`;
    case 'refinement':
      return `Refinement: ${codeList([...(rule.label ? [rule.label] : []), ...rule.stageIds])} → ${codeList(rule.steps)}, sequentially before ${code(rule.workStageId)}.`;
    case 'waiting_answer':
      return `Questions: ${code(rule.label)} blocks forward moves until the last open question is answered.`;
    case 'start_order':
      return 'Start order: urgent first, then by priority (a theme or parent priority counts), then board order.';
    case 'priority_setters':
      return `Priority: people and ${rule.members.length ? codeList(rule.members) : 'nobody else'} set it.`;
    case 'complexity_setters':
      return `Complexity points: ${codeList(rule.members)} set them.`;
    case 'assignee_fit':
      return `Assignee fit: an AI member names only a developer whose limit reaches the card's points and whose specialty fits (temp workers up to ${rule.tempMaxPoints}).`;
    case 'acceptance':
      return `Acceptance items: ${rule.reviewStageId ? `none open to enter ${code(rule.reviewStageId)}` : ''}${rule.reviewStageId && rule.doneStageId ? ', ' : ''}${rule.doneStageId ? `none unconfirmed to enter ${code(rule.doneStageId)}` : ''}.`;
    case 'project_manager_rights':
      return `Project manager: moves ${code(rule.moves)}, lifecycle ${rule.lifecycle.length ? codeList(rule.lifecycle) : 'none'}, ${rule.prerequisiteOverride ? 'may' : 'may not'} override a prerequisite.`;
    case 'viewer_recipients':
      return `Viewers write only to ${rule.mode === 'contacts' ? 'the contacts' : 'the project manager'}.`;
  }
}

/** Describe every shared rule in the member's system instructions. */
export function describeTeamRule(rule: TeamRule, project: ProjectConfig): string {
  const labels = (ids: string[], separator = ', ') =>
    ids.map((id) => labelRef(id, project.pipeline.labels)).join(separator);
  const stage = (id: string) => stageLabel(stageOf(project, id)!);
  switch (rule.id) {
    case 'new_card':
      return `New tasks: every AI member (create_task) and every human with ${code(rule.minimumAccess)} access or more may create a task. It starts unassigned in the first stage, ${stage(rule.firstStageId)}.`;
    case 'gates_in_order': {
      const done = project.pipeline.stages.find((s) => s.kind === 'done');
      const development = developmentStage(project);
      const closing = done
        ? ` Exception: a collecting card whose subtasks are all closed, at least one of them done, goes to ${stageLabel(done)} without the gates; the system closes it itself when its last subtask closes${development ? `, while the card stands before ${stageLabel(development)}` : ''}.`
        : '';
      return `Moves: a move forward enters every stage on the way, so all their gates must hold and none is skipped. A move back enters only the target stage${rule.clearedOnMoveBack.length ? ` and takes off ${labels(rule.clearedOnMoveBack)}` : ''}.${closing}`;
    }
    case 'approvals':
      return `Approvals: ${labels(rule.labels)} are set only by humans; when a gate needs one, the app asks its holders in their inbox. Never ask for an approval with ask_human: an answer puts no label on.`;
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
    case 'start_order':
      return `Start order: an urgent card starts first, then the higher priority (the priority of the card's theme or parent counts too), then the board order.${rule.urgentPull ? ' A free developer takes an urgent card from the queue before the development stage by itself.' : ''}`;
    case 'priority_setters':
      return `Priority: people set a card's priority${rule.members.length ? `, and so do ${codeList(rule.members)}` : ''}.`;
    case 'complexity_setters':
      return `Complexity points: only ${codeList(rule.members)} set a card's points.`;
    case 'assignee_fit':
      return `Assignee fit: when an AI member names an assignee, the member's complexity limit has to reach the card's points and the specialty has to fit (a temp worker takes cards up to ${rule.tempMaxPoints} points); a misfit is refused with assignee_unfit. People name anyone.`;
    case 'acceptance':
      return `Acceptance items: ${[
        rule.reviewStageId ? `a card with an open item does not enter ${stage(rule.reviewStageId)}` : null,
        rule.doneStageId ? `a card with an unconfirmed item does not enter ${stage(rule.doneStageId)}` : null,
      ]
        .filter(Boolean)
        .join('; ')}.`;
    case 'project_manager_rights':
      return `Project manager: ${rule.moves === 'start_only' ? 'starts cards only' : 'moves cards between queues and starts them'}; lifecycle actions on its own: ${rule.lifecycle.length ? codeList(rule.lifecycle) : 'none'}; ${rule.prerequisiteOverride ? 'may' : 'may not'} override an open prerequisite.`;
    case 'viewer_recipients':
      return `Viewers (read-only people) may write only to ${rule.mode === 'contacts' ? "the project's contacts" : 'the project manager'}.`;
    default: {
      const exhaustive: never = rule;
      return exhaustive;
    }
  }
}
