import {
  gateLabels,
  isHumanOnlyLabel,
  labelDefinition,
  labelHolders,
  resolvedStages,
  roleBundle,
  stageOwners,
} from '@projectman/shared';
import type { DutyId, HumanMemberConfig, Stage, Task } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { code, codeList, labelRef, lowerFirst, stageLabel } from './format';

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
  const stages = resolvedStages(input.project);
  const task = input.workItem.type === 'task' ? input.task : null;
  const current = task ? (stages.find((s) => s.id === (input.stage?.id ?? task.stageId)) ?? null) : null;
  return {
    stages,
    current,
    next: current ? stageAfter(stages, current) : null,
    ownsStage: current?.owners?.includes(input.member.handle) ?? false,
    isAssignee: task?.assignee === input.member.handle,
  };
}

function stageAfter(stages: Stage[], stage: Stage): Stage | null {
  const index = stages.findIndex((s) => s.id === stage.id);
  return index >= 0 ? (stages[index + 1] ?? null) : null;
}

/**
 * The labels a duty lets this member record, e.g. "`qa-ok` (QA ok) or `qa-failed` (QA: failed,
 * with a note)"; null when the project defines none.
 */
function resultLabels(input: ContextPackInput, duty: DutyId): string | null {
  const labels = input.project.pipeline.labels;
  const mine = labels.filter(
    (label) =>
      typeof label.setBy === 'object' &&
      !isHumanOnlyLabel(label) &&
      label.setBy.duties?.includes(duty) &&
      labelHolders(input.project, label).includes(input.member.handle),
  );
  if (mine.length === 0) return null;
  const refs = mine.map((label) => {
    const ref = labelRef(label.id, labels);
    return label.requiresComment ? `${ref} with a note` : ref;
  });
  return refs.length === 1 ? refs[0]! : `${refs.slice(0, -1).join(', ')} or ${refs[refs.length - 1]}`;
}

/** "record the result with update_task as …" or a plain note when the project has no such labels. */
function recordResult(input: ContextPackInput, duty: DutyId, detail: string): string {
  const labels = resultLabels(input, duty);
  return labels
    ? `Record the result with update_task as ${labels}; put ${detail} in note.`
    : `Record the result as a note with update_task: ${detail}.`;
}

/** What a member of a role that changes files does in the working stage, before the pull request. */
function buildSteps(role: string, task: Task): string[] {
  const where = task.repo
    ? "in your working directory (the task's own worktree and branch)"
    : 'in your working directory';
  switch (role) {
    case 'developer':
      return [
        'Read the task, its links and prerequisites; ask with ask_human if the goal or a decision is unclear.',
        `Implement the change ${where} and run the project's tests.`,
      ];
    case 'docs':
      return [`Update the documentation the task affects ${where}.`];
    case 'maintainer':
      return [
        `Make the maintenance change the task describes ${where}, small and focused, and run the project's tests.`,
      ];
    case 'translator':
      return [
        `Update the translations the task asks for ${where}; keep keys, placeholders and markup intact.`,
      ];
    case 'content':
      return [
        `Write the texts the task asks for ${where}; texts for the public stay drafts until a human approves them.`,
      ];
    case 'designer':
      return [`Create the designs or mockups the task asks for ${where}.`];
  }
  return [];
}

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
  const inQueue = current.kind === 'queue';
  const notOwner = `You do not own the current stage (${stageLabel(current)}${
    (current.owners ?? []).length > 0 ? `, owners ${codeList(current.owners ?? [])}` : ''
  }): do what you were asked and report back to the sender with send_message.`;

  const bundle = roleBundle(input.project, member.role);
  const duty = current.duty && bundle.duties.includes(current.duty) ? current.duty : bundle.duties[0];
  const aliases: Partial<Record<import('@projectman/shared').DutyId, string>> = {
    implementation: 'developer',
    maintenance: 'maintainer',
    translation: 'translator',
    ux_design: 'designer',
    testing_acceptance: 'qa',
    deployment: 'devops',
    client_communication: 'communication',
    requirements_analysis: 'business_analyst',
    technical_direction: 'architect',
    scheduling: 'project_manager',
    research: 'researcher',
    retro_facilitation: 'coach',
    monitoring: 'watchdog',
  };
  const role = duty ? (aliases[duty] ?? duty) : '';
  switch (role) {
    case 'developer':
    case 'docs':
    case 'maintainer':
    case 'translator':
    case 'content':
    case 'designer': {
      const building = inQueue || current.kind === 'work';
      if (building && (s.ownsStage || s.isAssignee || inQueue)) {
        const working = inQueue ? s.next : current;
        const steps: string[] = [];
        if (inQueue && working) {
          steps.push(`Move the task to ${stageLabel(working)} with update_task as you start.`);
        }
        steps.push(...buildSteps(role, task));
        steps.push('Commit, push, open a pull request and attach it with link_pull_request.');
        steps.push(handover(input, working ? stageAfter(s.stages, working) : null));
        return steps;
      }
      if (role === 'designer' && s.ownsStage) {
        return [
          'Compare the finished interface with the design: screen sizes, states and texts.',
          `Send each difference to ${author} with send_message (where it is, what you expect) and record the result as a note with update_task.`,
          `When it follows the design, ${lowerFirst(handover(input, s.next))}`,
        ];
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
      const duty: DutyId = role === 'security_review' ? 'security_review' : 'code_review';
      if (!s.ownsStage) {
        return [
          `Review what you were asked to review. ${recordResult(input, duty, 'your findings')} Report to the sender with send_message.`,
        ];
      }
      return [
        'Review the pull requests linked to the task; do not edit, commit or push.',
        recordResult(input, duty, 'a one-line summary of the findings'),
        `Send "Blocking" / "Not blocking" findings with file:line to ${author} with send_message; review again when they report a fix.`,
        `When the review passes, ${lowerFirst(handover(input, s.next))}`,
      ];
    }

    case 'qa': {
      if (!s.ownsStage) {
        return [
          `Test what you were asked. ${recordResult(input, 'testing_acceptance', 'what you tested and the result')} Report to the sender with send_message.`,
        ];
      }
      return [
        'Test the change where it is deployed: what the task asks and the risky paths around it.',
        recordResult(input, 'testing_acceptance', 'a short note (what, where, result)'),
        `Send failures to ${author} with send_message, with steps to reproduce.`,
        `When the test passes, ${lowerFirst(handover(input, s.next))}`,
      ];
    }

    case 'devops': {
      if (s.ownsStage && current.kind === 'step' && current.duty === 'deployment') {
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
      if (s.ownsStage && current.kind === 'step' && current.duty === 'client_communication') {
        const humans = humanOwners(input, current);
        return [
          'Draft the client test request: what to test, where, what the tester needs to know, and who tests it.',
          `Hand the draft to ${humans.length > 0 ? codeList(humans) : 'a human'} with send_message; do not send it outside the team yourself.`,
          `When a human reports the client's result: ${lowerFirst(recordResult(input, 'client_communication', "the client's words"))} Tell ${author} about requested changes.`,
          `When the client test passes, ${lowerFirst(handover(input, s.next))}`,
        ];
      }
      if (s.ownsStage) return ownerSteps(input, s);
      return [
        'Prepare the drafts or updates you were asked for and hand them to the right human with send_message.',
      ];
    }

    case 'project_manager':
      return [
        'Check where the task stands against its dates: who has to act next, and whether anything has waited too long.',
        'Remind whoever has to act with send_message (the task key, what is due and by when) and record agreed dates as a note with update_task.',
        `If a deadline is at risk or priorities conflict, ask ${codeList(humansWithRole(input, 'product_owner'))} with ask_human; do not reorder the work yourself.`,
      ];

    case 'business_analyst': {
      if (!s.ownsStage && !inQueue) {
        return [
          'Clarify what you were asked about, update the description with update_task if it changes, and report to the sender with send_message.',
        ];
      }
      return [
        'Read the request with get_task; ask with ask_human about anything unclear before work starts.',
        'Rewrite the description with update_task: the goal, the expected behaviour and numbered acceptance criteria; keep the original request quoted at the end.',
        'If the request holds several independent pieces of work, create one task per piece with create_task and note the split on this task.',
        inQueue ? readyForPriority(input, current) : handover(input, s.next),
      ];
    }

    case 'architect': {
      if (!s.ownsStage && !inQueue) {
        return [
          'Answer the design question you were asked with send_message; leave the line-by-line review to the code reviewer.',
        ];
      }
      return [
        'Read the task with get_task and the code it touches; read only, never edit, commit or push.',
        'Add the technical plan to the description with update_task, under its own heading: approach, affected parts, data or API changes, risks, how to test.',
        'If the work is bigger than one pull request, create the parts with create_task and note the order and dependencies on this task.',
        inQueue ? readyForPriority(input, current) : handover(input, s.next),
      ];
    }

    case 'support': {
      if (!s.ownsStage && !inQueue) {
        return [
          'Reproduce what you were asked to and report to the sender with send_message; for a new bug, create a card with create_task.',
        ];
      }
      return [
        'Reproduce the report the task describes in a test environment or locally; never with production data unless a human explicitly asks.',
        'Complete the description with update_task: steps to reproduce, expected and actual behaviour, environment, impact, and whether you could reproduce it.',
        inQueue ? readyForPriority(input, current) : handover(input, s.next),
      ];
    }

    case 'researcher': {
      if (!s.ownsStage && !s.isAssignee) {
        return [
          'Investigate what you were asked and send the sender your recommendation, the options you compared and your sources with send_message.',
        ];
      }
      const working = inQueue ? s.next : current;
      return [
        ...(inQueue && working
          ? [`Move the task to ${stageLabel(working)} with update_task as you start.`]
          : []),
        'Make sure the question and the decision it serves are clear; ask with ask_human if not.',
        'Investigate from primary sources and change nothing.',
        'Add the result to the description with update_task, below the question: the recommendation first, then the options you compared, what you could not verify and your sources.',
        handover(input, working ? stageAfter(s.stages, working) : null),
      ];
    }

    case 'coach':
      return [
        "Read the task's timeline with get_task and note what slowed it down or went well: stalled stages, repeated review rounds, reopened work, unanswered questions.",
        'Send the humans your observations and at most three concrete proposals with send_message, or ask for a decision with ask_human; do not change anything yourself.',
      ];

    case 'watchdog':
      return [
        "Check the task's progress with get_task: how long it has been in its stage, moves back and forth, repeated review rounds, unanswered questions, work outside a member's role.",
        `Flag anything wrong to ${codeList(humansWithRole(input, 'operator'))} with send_message (who, what you saw, since when, why it matters) and record it as a note with update_task; do not intervene.`,
      ];
  }
  // Custom roles and anything else: the stage's owners do their part and hand over.
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
  const approvals = gateLabels(input.project, target).approvals;
  if (approvals.length > 0) {
    const labels = input.project.pipeline.labels;
    const approvers = [
      ...new Set(
        approvals.flatMap((id) => {
          const label = labelDefinition(input.project, id);
          return label ? labelHolders(input.project, label) : [];
        }),
      ),
    ];
    return `Request the move to ${stageLabel(target)} with update_task: it needs a human approval (${approvals.map((id) => labelRef(id, labels)).join(', ')}), so the system opens a decision for ${codeList(approvers)} and the task waits until they approve. Do not message them separately and never set that label yourself.`;
  }
  const owners = stageOwners(input.project, target).filter((h) => h !== input.member.handle);
  if (target.kind === 'done' || owners.length === 0) {
    return `Move the task to ${stageLabel(target)} with update_task.`;
  }
  return `Move the task to ${stageLabel(target)} with update_task and hand over to ${codeList(owners)} with send_message: the facts they need (links, what changed, what to check).`;
}

/** A task that waits in the queue is prioritised by humans: tell them instead of moving it on. */
function readyForPriority(input: ContextPackInput, queue: Stage): string {
  return `Tell ${codeList(humansWithRole(input, 'product_owner'))} with send_message that the task is ready to be prioritised; leave it in ${stageLabel(queue)}.`;
}

function humans(input: ContextPackInput): HumanMemberConfig[] {
  return input.project.team.members.filter((m): m is HumanMemberConfig => m.kind === 'human');
}

/** Humans holding a role (e.g. the operator); the project's owners when nobody does. */
function humansWithRole(input: ContextPackInput, role: string): string[] {
  const holders = humans(input).filter((m) => m.roles.includes(role));
  return (holders.length > 0 ? holders : humans(input).filter((m) => m.access === 'owner')).map(
    (m) => m.handle,
  );
}

function humanOwners(input: ContextPackInput, stage: Stage): string[] {
  const handles = new Set(humans(input).map((m) => m.handle));
  return stageOwners(input.project, stage).filter((h) => handles.has(h));
}

/** Communication members who tell clients that a release is live. */
function followUpMembers(input: ContextPackInput): string[] {
  return input.project.team.members
    .filter((m) => m.kind === 'ai' && m.role === 'communication' && m.handle !== input.member.handle)
    .map((m) => m.handle);
}
