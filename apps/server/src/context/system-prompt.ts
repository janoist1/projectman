import { isBuiltInRole, roleBundle, DUTIES } from '@projectman/shared';
import type { BuiltInRoleId, CustomRoleDefinition } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { isHumanOnlyLabel, labelHolders } from '@projectman/shared';
import { code, codeList, describeGate, labelRef, languageName, stageLabel } from './format';
import { recentMemory } from './memory';
import { expectedSteps, type Situation } from './work-item';

/** English names of the built-in roles for prompt text. */
const ROLE_LABELS: Record<BuiltInRoleId, string> = {
  operator: 'operator',
  product_owner: 'product owner',
  project_manager: 'project manager',
  business_analyst: 'business analyst',
  architect: 'architect',
  designer: 'designer',
  developer: 'developer',
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
    `- Work with the others through the team tools (MCP server "team"; in ${cli} they are named mcp__team__<tool>): send_message, list_members, list_tasks, get_task, update_task, create_task, link_pull_request, ask_human and save_memory. Each tool's description says when and how to use it.`,
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
    `- Status: ${task.status}; assignee: ${task.assignee ? code(task.assignee) : 'none'}; repo: ${
      task.repo ? code(task.repo) : 'the workspace root'
    }.`,
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
    'The kick-off brief (description, labels, links, recent timeline) is the first message of this session; get_task gives the latest state.',
  );
  return lines.join('\n');
}

function guardrailsSection({ project, member }: ContextPackInput): string {
  const lines = [
    '# Guardrails',
    "- Never approve a gate, a decision or a permission request, and never answer in a human's name: only humans approve.",
    '- Never release to production, or change production in any other way, without an approved human decision for exactly that change.',
    '- When you are blocked or a decision is needed, ask with ask_human instead of guessing.',
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
  if (!roleBundle(project, member.role).duties.some((id) => DUTIES[id].toolPolicy === 'task_worktree')) {
    lines.push('- You never edit code, commit or push: you only report.');
  }
  return lines.join('\n');
}

/** Duty fragments are followed by prompt-only role extras, then personal instructions. */
function roleSection({ project, member }: ContextPackInput): string {
  const bundle = roleBundle(project, member.role);
  return [
    '# Your role instructions',
    ...bundle.duties.map((id) => DUTIES[id].prompt).filter(Boolean),
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
