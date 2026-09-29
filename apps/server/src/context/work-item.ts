import type { AiRole, CheckName, GateCondition, Stage } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { code, codeList, lowerFirst, stageLabel } from './format';

type HumanApproval = Extract<GateCondition, { type: 'human_approval' }>;

/** Where the member's work item stands in the pipeline. */
export interface Situation {
  stages: Stage[];
  /** Current stage of the task (null for general and meeting work items). */
  current: Stage | null;
  /** Stage after the current one in pipeline order. */
  next: Stage | null;
  /** The member is one of the current stage's owners. */
  ownsStage: boolean;
  /** The member is the task's assignee. */
  isAssignee: boolean;
}

export function assess(input: ContextPackInput): Situation {
  const stages = input.project.pipeline.stages;
  const task = input.workItem.type === 'task' ? input.task : null;
  const current = task ? (input.stage ?? stages.find((s) => s.id === task.stageId) ?? null) : null;
  return {
    stages,
    current,
    next: current ? stageAfter(stages, current) : null,
    ownsStage: current?.owners.includes(input.member.handle) ?? false,
    isAssignee: task?.assignee === input.member.handle,
  };
}

function stageAfter(stages: Stage[], stage: Stage): Stage | null {
  const index = stages.findIndex((s) => s.id === stage.id);
  return index >= 0 ? (stages[index + 1] ?? null) : null;
}

const REVIEW_CHECKS: Partial<Record<AiRole, CheckName>> = {
  code_review: 'code_review',
  security_review: 'security_review',
};

/**
 * What finishing the member's part of the current stage looks like, as numbered steps.
 * Shared by the system prompt ("what done means for you here") and the kick-off brief.
 */
export function expectedSteps(input: ContextPackInput, s: Situation): string[] {
  const { member } = input;
  const task = input.workItem.type === 'task' ? input.task : null;
  const current = s.current;
  if (!task || !current) return ['Read the task with get_task and ask the sender what is expected of you.'];

  const author = task.assignee ? code(task.assignee) : 'the author of the change';
  const notOwner = `You do not own the current stage (${stageLabel(current)}${
    current.owners.length > 0 ? `, owners ${codeList(current.owners)}` : ''
  }): do what you were asked and report back to the sender with send_message.`;

  switch (member.role) {
    case 'developer':
    case 'docs': {
      const building = current.kind === 'queue' || current.kind === 'work';
      if (building && (s.ownsStage || s.isAssignee || current.kind === 'queue')) {
        const working = current.kind === 'queue' ? s.next : current;
        const steps: string[] = [];
        if (current.kind === 'queue' && working) {
          steps.push(`Move the task to ${stageLabel(working)} with update_task as you start.`);
        }
        if (member.role === 'docs') {
          steps.push(
            "Update the documentation the task affects in your working directory (the task's own branch).",
          );
        } else {
          const where = task.repo
            ? "in your working directory (the task's own worktree and branch)"
            : 'in your working directory';
          steps.push(
            'Read the task, its links and prerequisites; ask with ask_human if the goal or a decision is unclear.',
            `Implement the change ${where} and run the project's tests.`,
          );
        }
        steps.push('Commit, push, open a pull request and attach it with link_pull_request.');
        steps.push(handover(input, working ? stageAfter(s.stages, working) : null));
        return steps;
      }
      if (s.isAssignee) {
        return [
          `The task is past development (now in ${stageLabel(current)}). Fix what teammates report in the same branch and pull request, push, and ask the reporter for a re-review or a retest with send_message.`,
        ];
      }
      return [notOwner];
    }

    case 'code_review':
    case 'security_review': {
      const check = REVIEW_CHECKS[member.role] ?? 'code_review';
      if (!s.ownsStage) {
        return [
          `Review what you were asked to review, record the ${check} check with update_task and report to the sender with send_message.`,
        ];
      }
      return [
        'Review the pull requests linked to the task; do not edit, commit or push.',
        `Record the ${check} check with update_task: passed, or blocked with a one-line summary.`,
        `Send "Blocking" / "Not blocking" findings with file:line to ${author} with send_message; review again when they report a fix.`,
        `When the review passes, ${lowerFirst(handover(input, s.next))}`,
      ];
    }

    case 'qa': {
      if (!s.ownsStage) {
        return [
          'Test what you were asked, record the qa check with update_task and report to the sender with send_message.',
        ];
      }
      return [
        'Test the change where it is deployed: what the task asks and the risky paths around it.',
        'Record the qa check with update_task: passed, failed or retest_needed, with a short note (what, where, result).',
        `Send failures to ${author} with send_message, with steps to reproduce.`,
        `When the test passes, ${lowerFirst(handover(input, s.next))}`,
      ];
    }

    case 'devops': {
      if (s.ownsStage && current.kind === 'deploy') {
        return [
          "Deploy the task's branch or pull request to the test environment and verify that it works.",
          'Record what is deployed where as a note with update_task.',
          handover(input, s.next),
        ];
      }
      if (s.ownsStage && current.kind === 'release') {
        const followUp = followUpMembers(input);
        return [
          'The task passed its release gate: a human approved the release. Release exactly the approved change to production and verify it.',
          'If anything changed since the approval (new commits, another version), stop and ask with ask_human.',
          handover(input, s.next),
          ...(followUp.length > 0 ? [`Tell ${codeList(followUp)} that the change is live.`] : []),
        ];
      }
      if (s.ownsStage) return ownerSteps(input, s);
      return [
        'Do the deployment or operations work you were asked for and report to the sender with send_message. Production changes need an approved human decision.',
      ];
    }

    case 'communication': {
      if (s.ownsStage && current.kind === 'client_test') {
        const humans = humanOwners(input, current);
        return [
          'Draft the client test request: what to test, where, what the tester needs to know, and who tests it.',
          `Hand the draft to ${humans.length > 0 ? codeList(humans) : 'a human'} with send_message; do not send it outside the team yourself.`,
          `When a human reports the client's result, record the client_test check with update_task and tell ${author} about failures.`,
          `When the client test passes, ${lowerFirst(handover(input, s.next))}`,
        ];
      }
      if (s.ownsStage) return ownerSteps(input, s);
      return [
        'Prepare the drafts or updates you were asked for and hand them to the right human with send_message.',
      ];
    }

    case 'scheduled': {
      if (s.ownsStage || s.isAssignee || current.kind === 'queue') {
        const working = current.kind === 'queue' ? s.next : current;
        const recipients = routineOwners(input);
        return [
          ...(current.kind === 'queue' && working
            ? [`Move the task to ${stageLabel(working)} with update_task as you start.`]
            : []),
          'Do the routine the task describes, the same way as before, and note anything unusual.',
          `Report the result to ${recipients.length > 0 ? codeList(recipients) : 'the owner'} with send_message: the facts that need attention first.`,
          `Record a short note with update_task. ${handover(input, working ? stageAfter(s.stages, working) : null)}`,
        ];
      }
      return [notOwner];
    }

    case 'project_manager':
      return [
        'Keep the task accurate (stage, assignee, checks, next step) and make sure whoever has to act next knows it.',
      ];
  }
  return s.ownsStage ? ownerSteps(input, s) : [notOwner];
}

function ownerSteps(input: ContextPackInput, s: Situation): string[] {
  return [
    `Do your part of the ${s.current ? stageLabel(s.current) : 'current'} stage.`,
    handover(input, s.next),
  ];
}

/** How to pass the task on to the given stage (or close the work item without one). */
export function handover(input: ContextPackInput, target: Stage | null): string {
  if (!target) return 'Tell whoever asked that your part is done.';
  const approval = target.gate?.conditions.find((c): c is HumanApproval => c.type === 'human_approval');
  if (approval) {
    return `Request the move to ${stageLabel(target)} with update_task: it needs a human approval, so the system opens a decision for ${codeList(approval.approvers)} and the task waits until they approve. Do not message them separately and never approve it yourself.`;
  }
  const owners = target.owners.filter((h) => h !== input.member.handle);
  if (target.kind === 'done' || owners.length === 0) {
    return `Move the task to ${stageLabel(target)} with update_task.`;
  }
  return `Move the task to ${stageLabel(target)} with update_task and hand over to ${codeList(owners)} with send_message: the facts they need (links, what changed, what to check).`;
}

function humanHandles(input: ContextPackInput): Set<string> {
  return new Set(input.project.team.members.filter((m) => m.kind === 'human').map((m) => m.handle));
}

function humanOwners(input: ContextPackInput, stage: Stage): string[] {
  const humans = humanHandles(input);
  return stage.owners.filter((h) => humans.has(h));
}

/** Communication members who tell clients that a release is live. */
function followUpMembers(input: ContextPackInput): string[] {
  return input.project.team.members
    .filter((m) => m.kind === 'ai' && m.role === 'communication' && m.handle !== input.member.handle)
    .map((m) => m.handle);
}

/** Humans a routine reports to: the task's creator if human, otherwise the project owners. */
function routineOwners(input: ContextPackInput): string[] {
  const creator = input.task?.createdBy;
  if (creator && humanHandles(input).has(creator)) return [creator];
  return input.project.team.members
    .filter((m) => m.kind === 'human' && m.access === 'owner')
    .map((m) => m.handle);
}
