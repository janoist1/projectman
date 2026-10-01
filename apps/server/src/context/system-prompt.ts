import {
  approverOf,
  effectiveRepo,
  isBuiltInRole,
  repoOf,
  roleBundle,
  roleUsesWorktree,
  roleSessionTools,
} from '@projectman/shared';
import type { BuiltInRoleId, CustomRoleDefinition } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { describeSandbox, describeUnattendedCommands } from '../domain';
import { isHumanOnlyLabel, labelHolders } from '@projectman/shared';
import { code, codeList, describeGate, labelRef, languageName, repoText, stageLabel } from './format';
import { recentMemory } from './memory';
import { dutyPrompt, expectedSteps, type Situation } from './work-item';

/** English names of the built-in roles for prompt text. */
const ROLE_LABELS: Record<BuiltInRoleId, string> = {
  operator: 'operator',
  product_owner: 'product owner',
  project_manager: 'project manager',
  business_analyst: 'business analyst',
  architect: 'architect',
  designer: 'designer',
  developer: 'developer',
  lead_developer: 'lead developer',
  code_review: 'code reviewer',
  security_review: 'security reviewer',
  qa: 'QA engineer',
  devops: 'DevOps engineer',
  communication: 'communication member',
  support: 'support member',
  researcher: 'researcher',
  maintainer: 'maintainer',
  coach: 'coach',
  watchdog: 'watchdog',
  content: 'content writer',
  translator: 'translator',
  docs: 'technical writer',
};

/**
 * A role for prompt text: the English name of a built-in role, a custom role's own name (in the
 * project's language), else the value as it is.
 */
export function roleLabel(
  role: string,
  customRoles: readonly Pick<CustomRoleDefinition, 'id' | 'name'>[] = [],
): string {
  if (isBuiltInRole(role)) return ROLE_LABELS[role];
  return customRoles.find((r) => r.id === role)?.name ?? role;
}

/**
 * The member's system prompt (Claude Code: `--append-system-prompt`; Codex:
 * `developer_instructions`): who, with whom, how, on what, within which limits.
 */
export function buildSystemPrompt(input: ContextPackInput, situation: Situation): string {
  return [
    identitySection(input),
    teamSection(input),
    teamworkSection(input),
    pipelineSection(input, situation),
    labelsSection(input),
    workItemSection(input, situation),
    sessionPolicySection(input),
    workspaceSection(input),
    unattendedCommandsSection(input),
    boundarySection(input),
    guardrailsSection(input),
    roleSection(input),
    memorySection(input),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Codex members differ in a few words: their plan, the tool naming and the project's rules file. */
function isCodex(member: ContextPackInput['member']): boolean {
  return member.provider === 'codex';
}

function boundarySection({ project }: ContextPackInput): string {
  if (!project.team.boundary?.enabled) return '';
  return '# External operations\nThe protected adapter registers external operations. Use submit_boundary_request with its operation id and a stable retry key, then inspect with get_boundary_request. Pending means retry later, never automatic permission. A grant covers one exact operation and does not replace CLI permissions or human gate/release decisions. Never put credentials, secrets or raw commands in a request. Only independent live boundary_authorization duty holders may use decide_boundary_request for delegated operations; owner exceptions and escalated requests stay with the owner.';
}

function identitySection({ project, member }: ContextPackInput): string {
  const sponsor = project.team.members.find((m) => m.handle === member.sponsor);
  const specialty = member.specialty ? ` (${member.specialty})` : '';
  const plan = isCodex(member) ? 'ChatGPT subscription (Codex)' : 'Claude subscription';
  const lines = [
    '# Who you are',
    `You are ${member.displayName} (handle ${code(member.handle)}), the ${roleLabel(member.role, project.team.roles)}${specialty} of the ${project.project.name} team (project key ${code(project.project.key)}); you run on ${sponsor?.displayName ?? member.sponsor}'s ${plan}.`,
    'You are an AI member of a team run by projectman: humans follow your work, answer your questions and make the decisions in its web app.',
  ];
  if (member.temp) {
    lines.push('You are a temporary stand-in hired for one task; you are retired when it is done.');
  }
  return lines.join('\n');
}

interface RosterEntry {
  handle: string;
  displayName: string;
  kind: 'human' | 'ai';
  /** Access level of a human; the role of an AI member. */
  role: string;
  /** Roles a human holds. */
  roles: string[];
  specialty: string | null;
  temp: boolean;
}

function roster(input: ContextPackInput): RosterEntry[] {
  if (input.team.length > 0) {
    return input.team
      .filter((m) => m.status !== 'retired')
      .map((m) => ({
        handle: m.handle,
        displayName: m.displayName,
        kind: m.kind,
        role: m.role,
        roles: m.kind === 'human' ? m.roles : [],
        specialty: m.specialty,
        temp: m.temp,
      }));
  }
  return input.project.team.members.map((m) =>
    m.kind === 'human'
      ? {
          handle: m.handle,
          displayName: m.displayName,
          kind: m.kind,
          role: m.access,
          roles: m.roles,
          specialty: null,
          temp: false,
        }
      : {
          handle: m.handle,
          displayName: m.displayName,
          kind: m.kind,
          role: m.role,
          roles: [],
          specialty: m.specialty ?? null,
          temp: m.temp,
        },
  );
}

function teamSection(input: ContextPackInput): string {
  const customRoles = input.project.team.roles;
  const lines = roster(input).map((m) => {
    const held = m.roles.map((role) => roleLabel(role, customRoles));
    const details =
      m.kind === 'human'
        ? [`human, ${m.role}${held.length > 0 ? `; roles: ${held.join(', ')}` : ''}`]
        : [
            'AI',
            roleLabel(m.role, customRoles),
            ...(m.specialty ? [m.specialty] : []),
            ...(m.temp ? ['temporary'] : []),
          ];
    const self = m.handle === input.member.handle ? ' ← you' : '';
    return `- ${code(m.handle)}: ${m.displayName} (${details.join(', ')})${self}`;
  });
  return ['# The team', 'Address members by handle.', ...lines].join('\n');
}

/**
 * The team rules, stated once. Both providers receive this system prompt, so rules that are not
 * about one tool live here; what a tool does and when to use it lives in its description (see
 * src/mcp/tools.ts), and the MCP server instructions only name the server.
 */
function teamworkSection({ project, member }: ContextPackInput): string {
  const language = project.project.language;
  const cli = isCodex(member) ? 'Codex' : 'Claude Code';
  const rules = isCodex(member) ? "The project's AGENTS.md (or CLAUDE.md)" : "The project's CLAUDE.md";
  return [
    '# How the team works',
    '- You are one member of a mixed team of humans and AI members. Every AI member works in a fresh session per work item (a task, a meeting or a general chat); follow-ups about the same task come back to the same session.',
    `- Work with the others through the team tools (MCP server "team"; in ${cli} they are named mcp__team__<tool>): send_message, list_members, list_tasks, get_task, update_task, create_task, link_pull_request, publish_task_branch (managed VM only), get_remote_state, ask_human, save_memory, and for files attached to tasks list_attachments, read_attachment, attach_file and delete_attachment; external operations use submit_boundary_request, get_boundary_request and decide_boundary_request, a permission request of a member that was delegated to its decider is answered with decide_permission_request, and refused network destinations are listed by list_network_denials. Each tool's description says when and how to use it.`,
    '- Text you write in your own session reaches nobody: to tell a teammate something, or to answer a team message, use send_message. Team messages arrive in your session as "[team message from <handle> about <task key>]" followed by the text. Messages without that prefix come from the app (like the kick-off brief) or from a human using it.',
    '- Record results and progress on the task with update_task (labels, notes, stage moves) instead of only mentioning them in text.',
    '- Message only when someone has something to do, and send humans only what needs their decision or action. Be concise: facts first, no pleasantries.',
    `- Write messages, notes, questions, task titles and descriptions in ${languageName(language)} (${code(language)}), the project's language. ${rules} decides the language of code, commits and pull requests.`,
    '- Check the primary source (the code, the logs, the task) before you state a fact.',
    '- Other sessions may share a checkout: never switch branches, reset, stash or clean in a working directory that is not your own.',
  ].join('\n');
}

function pipelineSection(input: ContextPackInput, situation: Situation): string {
  const lines = situation.stages.map((stage, i) => {
    const owners = (stage.owners ?? []).length > 0 ? ` — owners ${codeList(stage.owners ?? [])}` : '';
    const gate = describeGate(stage.gate, input.project.pipeline.labels);
    const current = situation.current?.id === stage.id ? ' ← current stage' : '';
    // A step is defined by its duty (a review, a deploy, a test ...), so name it.
    const kind =
      stage.kind === 'step' && stage.duty ? `step: ${stage.duty.replaceAll('_', ' ')}` : stage.kind;
    return `${i + 1}. ${stage.name} (${code(stage.id)}, ${kind})${owners}${gate ? ` — gate: ${gate}` : ''}${current}`;
  });
  return [
    '# The pipeline',
    'Tasks move through these stages in order. A gate must hold before a task may enter its stage: labels that must (or must not) be on the task. Approvals are labels only humans may set; the app asks them.',
    ...lines,
  ].join('\n');
}

/** The project's label vocabulary: what each label means and who may set it. */
function labelsSection({ project }: ContextPackInput): string {
  const labels = project.pipeline.labels;
  if (labels.length === 0) return '';
  const lines = labels.map((label) => {
    const who =
      label.setBy === 'system'
        ? 'set by the system'
        : isHumanOnlyLabel(label)
          ? `only humans set it: ${codeList(labelHolders(project, label))}; never set it yourself`
          : label.setBy === 'anyone' || label.setBy === 'humans'
            ? `set by ${label.setBy}`
            : `set by ${codeList(labelHolders(project, label))}`;
    const rules = [
      who,
      ...(label.group ? [`one of group ${code(label.group)}`] : []),
      ...(label.requiresComment ? ['needs a note'] : []),
      ...(label.notByAuthor ? ['not on your own work'] : []),
      ...(label.blocks ? ['holds the task back while on it'] : []),
    ].join('; ');
    return `- ${labelRef(label.id, labels)}${label.meaning ? `: ${label.meaning}` : ''} (${rules})`;
  });
  return [
    '# Labels',
    'Labels state facts about a task; gates and people rely on them. Record results as labels (add_labels / remove_labels of update_task). Other labels on tasks are plain tags.',
    ...lines,
  ].join('\n');
}

function workItemSection(input: ContextPackInput, situation: Situation): string {
  const heading = '# Current work item';
  const { workItem } = input;
  if (workItem.type === 'schedule') {
    return [
      heading,
      `Scheduled run ${code(workItem.runId)} in the project workspace. Follow the scheduled brief; there is no assigned task.`,
    ].join('\n');
  }
  if (workItem.type === 'general') {
    return [
      heading,
      "A general conversation, not tied to a task: help with what you are asked. If it turns into work on a task, ask a human to create or assign one (ask_human); task work happens in that task's own session.",
    ].join('\n');
  }
  if (workItem.type === 'meeting') {
    return [
      heading,
      `A team meeting (${code(workItem.meetingId)}). Contribute from your role, keep it short, and record agreed actions as notes on the tasks they concern (update_task).`,
    ].join('\n');
  }
  const task = input.task;
  if (!task) {
    return [
      heading,
      `Task ${code(workItem.taskKey)}. Its details were not available when this session started: read them with get_task.`,
    ].join('\n');
  }

  const { current, next } = situation;
  const lines = [heading, `Task ${task.key}: ${task.title}`];
  if (current) {
    const owners = (current.owners ?? []).length > 0 ? `, owners ${codeList(current.owners ?? [])}` : '';
    const own = situation.ownsStage ? 'you own this stage' : 'you do not own this stage';
    lines.push(`- Stage: ${stageLabel(current)}${owners}; ${own}.`);
  } else {
    lines.push(`- Stage: ${code(task.stageId)} (not in the pipeline).`);
  }
  lines.push(
    `- Status: ${task.status}; assignee: ${task.assignee ? code(task.assignee) : 'none'}; repo: ${repoText(
      input.project,
      task,
    )}.`,
  );
  if (next) {
    const owners = (next.owners ?? []).length > 0 ? `, owners ${codeList(next.owners ?? [])}` : '';
    const gate = describeGate(next.gate, input.project.pipeline.labels);
    lines.push(`- Next stage: ${stageLabel(next)}${owners}${gate ? `; gate: ${gate}` : ''}.`);
  }
  lines.push(
    '',
    'What done means for you here:',
    ...expectedSteps(input, situation).map((step, i) => `${i + 1}. ${step}`),
    '',
    'The kick-off brief (description, labels, links, attachments, recent timeline) is the first message of this session; get_task gives the latest state.',
  );
  return lines.join('\n');
}

/**
 * The shell commands the server allows without a human: generated from its rules (domain), so a
 * member writes commands in a form that passes instead of waiting for approval. Only task work
 * items have such rules (`commandVerdict` gives no verdict without a task).
 */
function unattendedCommandsSection({
  project,
  member,
  task,
  workItem,
  sessionPolicy,
  sandbox,
}: ContextPackInput): string {
  const repo = repoOf(project, effectiveRepo(project, task));
  // A Claude member in the CLI's own sandbox (PM-167) is told its boundary instead: nothing there
  // waits for a human, whatever the work item. Codex's text does not change.
  if (sandbox && !isCodex(member) && sessionPolicy) {
    return [
      '# Your sandbox',
      ...describeSandbox({
        sandbox,
        cwd: sessionPolicy.placement.path,
        localOnly: repo !== undefined && !repo.github,
      }),
    ].join('\n');
  }
  if (workItem.type !== 'task') return '';
  // The managed VM profile (PM-141) has no command rules: nothing waits for a human, so there is no
  // form to write commands in (the legacy rules of PM-104/105/109/116 stay in the legacy path).
  if (sessionPolicy?.execution?.profile === 'managed_vm') return '';
  const worktree = roleUsesWorktree(project, member.role);
  return [
    '# Commands that run without asking',
    ...describeUnattendedCommands({
      worktree,
      hasRepo: repo !== undefined,
      defaultBranch: repo?.defaultBranch,
      localOnly: repo !== undefined && !repo.github,
      // Codex has no allow list of its own; Claude Code's comes from the role (session-policy).
      codex: isCodex(member),
      preApproved: isCodex(member)
        ? []
        : (sessionPolicy?.tools ?? roleSessionTools(project, member.role)).shell
            .filter((rule) => rule.arguments === 'prefix')
            .map((rule) => rule.command),
    }),
  ].join('\n');
}

/** Who decides when the CLI asks for a permission (the member's approver, PM-165). */
function approverText(member: ContextPackInput['member']): string {
  const approver = approverOf(member);
  if (approver === 'none')
    return 'Permission questions: nobody approves them in this session. A request the CLI would ask about is refused at once, and the refusal is final: do not retry it in another form. If you really need it, ask a human with ask_human and say why.';
  if (approver === 'ai')
    return 'Permission questions: when the CLI asks for a permission, a teammate or a human decides. Wait for the answer and do not ask again in another form.';
  return 'Permission questions: when the CLI asks for a permission, a human decides in their inbox. Wait for the answer and do not ask again in another form.';
}

function sessionPolicySection({ sessionPolicy: policy, member }: ContextPackInput): string {
  if (!policy) return '';
  if (policy.execution?.profile === 'managed_vm') {
    const research = policy.permissions.sandbox === 'read-only';
    return [
      '# Session policy',
      `Execution profile: managed VM. Placement: ${policy.access}; working directory: ${code(policy.placement.path)}.`,
      research
        ? 'Your member mode is research-only (plan): you read and report; you do not change files.'
        : 'You work freely in your own workspace: shell commands (with substitution, redirections and pipes), installs, test runs of any kind, and commits run without asking, in any form. Nothing waits for a human, and nothing needs a special form.',
      'The limits are outside your session: your own account, the protected paths and the network gate. A step that leaves the machine is decided at that gate, not by a prompt; for a registered external operation use submit_boundary_request. Do not look for a way around a refusal there: report it instead.',
      'A permission request that reaches you anyway is refused, not queued for a human.',
      "Your task branch reaches GitHub only through publish_task_branch: commit, then pass the full commit id (git rev-parse HEAD). You hold no GitHub credentials, so do not push or open a pull request with git or gh; the default branch and other members' branches are never published. get_remote_state shows what GitHub has.",
    ].join('\n');
  }
  return [
    '# Session policy',
    `Placement: ${policy.access}; working directory: ${code(policy.placement.path)}.`,
    ...(policy.access === 'review_copy' ? [`Review copy mode: ${policy.reviewCopyMode ?? 'inherit'}.`] : []),
    `Readable roots for automatic command decisions: ${codeList(policy.filesystem.readableRoots)}.`,
    `Writable workspace roots: ${codeList(policy.filesystem.writableRoots)}.`,
    `Protected paths: ${codeList(policy.filesystem.protectedPaths)}.`,
    `Denied operations: ${codeList(policy.deniedOperations)}.`,
    ...(policy.filesystem.deniedPaths?.length
      ? [
          `The file tools never read or change credential files and the live instance's data (${codeList(policy.filesystem.deniedPaths)}), and web fetch never reaches ${codeList(policy.network.deniedHosts ?? [])}, in any mode: do not look for a way around it.`,
        ]
      : []),
    'Enforcement is the existing provider and command policy. These roots do not establish strict read or network isolation yet; outside-sandbox execution still requires permission.',
    approverText(member),
  ].join('\n');
}

/**
 * The member's own durable workspace (PM-138): which branch or which handed-over commit it holds
 * for this task, so that a resumed session knows it too (the system prompt is rebuilt on resume).
 */
function workspaceSection({ sessionPolicy: policy }: ContextPackInput): string {
  const placement = policy?.placement;
  if (placement?.kind === 'member_workspace' && placement.use === 'home') {
    return [
      '# Your workspace',
      `You work in your own directory ${code(placement.path)}: it has no repository, and it stays yours across sessions.`,
    ].join('\n');
  }
  const work =
    placement?.kind === 'task_worktree'
      ? placement.workspace
      : placement?.kind === 'member_workspace'
        ? placement.workspace
        : undefined;
  if (placement && work) {
    const { branch, baseCommit } = work;
    return [
      '# Your workspace',
      `You work in your own durable workspace for this repository, an independent clone at ${code(placement.path)}, on the task's branch ${code(branch)}${baseCommit ? ` (it started from ${code(baseCommit)})` : ''}.`,
      'It stays yours across tasks: the branches of your other tasks are kept in it, and nothing is ever reset, stashed or cleaned for you. Commit your work before you hand over: you move to another task here only when nothing is left uncommitted and no git operation (merge, rebase, cherry-pick) is unfinished.',
      'It has no remote. Teammates who review or test your work get your committed branch from here; uncommitted files never reach them.',
    ].join('\n');
  }
  const round =
    placement?.kind === 'review_copy'
      ? placement
      : placement?.kind === 'member_workspace'
        ? placement.review
        : undefined;
  if (placement && round?.sourceBranch) {
    return [
      '# Review round',
      `Round ${round.roundId}: your own workspace at ${code(placement.path)} has the handed-over commit ${code(round.sourceCommit)} of ${code(round.sourceBranch)} checked out (detached HEAD); the developer's uncommitted files are not in it.`,
      ...(round.baseCommit
        ? [
            `The review base is ${code(round.baseBranch ?? 'the default branch')} at ${code(round.baseCommit)}: read the change with ${code(`git log ${round.baseCommit}..HEAD`)} and ${code(`git diff ${round.baseCommit}...HEAD`)}.`,
          ]
        : []),
      'You keep this commit while the round lasts. A new round with the latest commit starts when the task enters a stage or its developer asks you for a re-review; you are restarted on it then.',
    ].join('\n');
  }
  return '';
}

function guardrailsSection({ project, member }: ContextPackInput): string {
  const lines = [
    '# Guardrails',
    "- Never approve a gate, a decision or a permission request, and never answer in a human's name: only humans approve.",
    '- Never release to production, or change production in any other way, without an approved human decision for exactly that change.',
    '- When you are blocked or a decision is needed, ask with ask_human instead of guessing.',
    '- The human who answers ask_human is usually not a specialist and often reads on a phone: start the question with one plain sentence that names the decision, recommend one option with a one-sentence reason, describe each option by what happens if it is picked, and keep code, file names and technical reasoning in the details field, which the inbox shows folded. Keep it short; options, reasons and details follow the language rule above.',
    '- Never put secrets (passwords, tokens, keys, connection strings, personal data) in messages, notes, task text, commits or pull requests; say where they are stored instead.',
    '- Do not ask a teammate to do what you are not allowed to do; tell a human instead.',
    // The self-review rule is per label (notByAuthor), marked in the Labels section.
    ...(project.pipeline.labels.some((label) => label.notByAuthor)
      ? [
          '- Never set a label marked "not on your own work" on a task you are assigned to or whose pull request you authored.',
        ]
      : []),
    '- Do not ask humans again about what they have already decided.',
    '- If you told the team something wrong, correct it yourself and tell everyone who relied on it.',
  ];
  if (!roleUsesWorktree(project, member.role)) {
    lines.push('- You never edit code, commit or push: you only report.');
  }
  return lines.join('\n');
}

/** Duty fragments are followed by prompt-only role extras, then personal instructions. */
function roleSection(input: ContextPackInput): string {
  const { project, member } = input;
  const bundle = roleBundle(project, member.role);
  return [
    '# Your role instructions',
    ...bundle.duties.map((id) => dutyPrompt(input, id)).filter(Boolean),
    bundle.instructions.trim(),
    member.instructions.trim(),
  ]
    .filter(Boolean)
    .join('\n\n');
}

function memorySection({ memory }: ContextPackInput): string {
  const { text, truncated } = recentMemory(memory);
  if (!text) return ['# Your memory', 'Nothing saved yet; use save_memory for durable learnings.'].join('\n');
  return [
    '# Your memory',
    'Notes you saved in earlier sessions with save_memory, most recent last. They may be out of date: check facts before you rely on them.',
    ...(truncated ? ['(Older entries are not shown.)'] : []),
    '',
    text,
  ].join('\n');
}
