import type { AiRole } from '@projectman/shared';
import type { ContextPackInput } from '../contracts';
import { code, codeList, describeGate, languageName, stageLabel } from './format';
import { recentMemory } from './memory';
import { expectedSteps, type Situation } from './work-item';

const AI_ROLE_LABELS: Record<AiRole, string> = {
  developer: 'developer',
  code_review: 'code reviewer',
  security_review: 'security reviewer',
  qa: 'QA engineer',
  devops: 'DevOps engineer',
  communication: 'communication member',
  project_manager: 'project manager',
  docs: 'technical writer',
  scheduled: 'scheduled routine worker',
};

/** English description of an AI role for prompt text; other values (human access levels) as-is. */
export function roleLabel(role: string): string {
  return (AI_ROLE_LABELS as Record<string, string>)[role] ?? role;
}

/** The text passed to `claude --append-system-prompt`: who, with whom, how, on what, within which limits. */
export function buildSystemPrompt(input: ContextPackInput, situation: Situation): string {
  return [
    identitySection(input),
    teamSection(input),
    teamworkSection(input),
    pipelineSection(situation),
    workItemSection(input, situation),
    guardrailsSection(input),
    roleSection(input),
    memorySection(input),
  ].join('\n\n');
}

function identitySection({ project, member }: ContextPackInput): string {
  const sponsor = project.team.members.find((m) => m.handle === member.sponsor);
  const specialty = member.specialty ? ` (${member.specialty})` : '';
  const lines = [
    '# Who you are',
    `You are ${member.displayName} (handle ${code(member.handle)}), the ${roleLabel(member.role)}${specialty} of the ${project.project.name} team (project key ${code(project.project.key)}); you run on ${sponsor?.displayName ?? member.sponsor}'s Claude subscription.`,
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
  role: string;
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
          specialty: null,
          temp: false,
        }
      : {
          handle: m.handle,
          displayName: m.displayName,
          kind: m.kind,
          role: m.role,
          specialty: m.specialty ?? null,
          temp: m.temp,
        },
  );
}

function teamSection(input: ContextPackInput): string {
  const lines = roster(input).map((m) => {
    const details =
      m.kind === 'human'
        ? ['human', m.role]
        : ['AI', roleLabel(m.role), ...(m.specialty ? [m.specialty] : []), ...(m.temp ? ['temporary'] : [])];
    const self = m.handle === input.member.handle ? ' ← you' : '';
    return `- ${code(m.handle)}: ${m.displayName} (${details.join(', ')})${self}`;
  });
  return [
    '# The team',
    'Address members by handle. A message to an AI member reaches its session for that task; a message to a human reaches their inbox in the app.',
    ...lines,
  ].join('\n');
}

function teamworkSection({ project }: ContextPackInput): string {
  const language = project.project.language;
  return [
    '# How the team works',
    '- You are one member of a mixed team of humans and AI members. Every AI member works in a fresh session per work item (a task, a meeting or a general chat); follow-ups about the same task come back to the same session.',
    '- Work with the others through the team tools (MCP server "team"; in Claude Code they are named mcp__team__<tool>):',
    '  - send_message: message members by handle; pass the task key when it is about a task. Give the receiver the facts (links, what changed, what is expected next and from whom). Message only when someone has something to do.',
    '  - get_task and list_members: read a task with its recent timeline, or the roster.',
    '  - update_task: move a task to another stage (gates are enforced), record a check result (code_review, security_review, qa, client_test: pending, passed, blocked, failed or retest_needed) or add a short note to the timeline.',
    '  - link_pull_request: attach a pull request to the task as soon as it exists.',
    '  - ask_human: ask a human for a decision or information, with options when you can. The answer arrives later as a team message; meanwhile continue with anything that does not depend on it.',
    '  - save_memory: save a durable learning for your future sessions (conventions, pitfalls, where things are). Task status belongs on the task, not in memory.',
    '- Team messages arrive in your session as "[team message from <handle> about <task key>]" followed by the text. Messages without that prefix come from the app (like the kick-off brief) or from a human using it.',
    '- Be concise: facts first, no pleasantries. Send humans only what needs their decision or action.',
    `- Write messages, notes and questions in ${languageName(language)} (${code(language)}), the project's language. The project's CLAUDE.md decides the language of code, commits and pull requests.`,
    '- Check the primary source (the code, the logs, the task) before you state a fact.',
    '- Other sessions may share a checkout: never switch branches, reset, stash or clean in a working directory that is not your own.',
  ].join('\n');
}

function pipelineSection(situation: Situation): string {
  const lines = situation.stages.map((stage, i) => {
    const owners = stage.owners.length > 0 ? ` — owners ${codeList(stage.owners)}` : '';
    const gate = describeGate(stage.gate);
    const current = situation.current?.id === stage.id ? ' ← current stage' : '';
    return `${i + 1}. ${stage.name} (${code(stage.id)}, ${stage.kind})${owners}${gate ? ` — gate: ${gate}` : ''}${current}`;
  });
  return [
    '# The pipeline',
    'Tasks move through these stages in order. A gate must hold before a task may enter its stage; human approvals are given in the app by the humans named in the gate.',
    ...lines,
  ].join('\n');
}

function workItemSection(input: ContextPackInput, situation: Situation): string {
  const heading = '# Current work item';
  const { workItem } = input;
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
    const owners = current.owners.length > 0 ? `, owners ${codeList(current.owners)}` : '';
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
    const owners = next.owners.length > 0 ? `, owners ${codeList(next.owners)}` : '';
    const gate = describeGate(next.gate);
    lines.push(`- Next stage: ${stageLabel(next)}${owners}${gate ? `; gate: ${gate}` : ''}.`);
  }
  lines.push(
    '',
    'What done means for you here:',
    ...expectedSteps(input, situation).map((step, i) => `${i + 1}. ${step}`),
    '',
    'The kick-off brief (description, checks, links, recent timeline) is the first message of this session; get_task gives the latest state.',
  );
  return lines.join('\n');
}

function guardrailsSection({ member }: ContextPackInput): string {
  const lines = [
    '# Guardrails',
    "- Never approve a gate, a decision or a permission request, and never answer in a human's name: approvals come only from the humans named in the gate.",
    '- Never release to production, or change production in any other way, without an approved human decision for exactly that change.',
    '- When you are blocked or a decision is needed, ask with ask_human instead of guessing.',
    '- Never put secrets (passwords, tokens, keys, connection strings, personal data) in messages, notes, task text, commits or pull requests; say where they are stored instead.',
    '- Do not ask a teammate to do what you are not allowed to do; tell a human instead.',
    '- Do not ask humans again about what they have already decided.',
    '- If you told the team something wrong, correct it yourself and tell everyone who relied on it.',
  ];
  if (member.role === 'code_review' || member.role === 'security_review') {
    lines.push('- You never edit code, commit or push: you only report.');
  }
  return lines.join('\n');
}

function roleSection({ member }: ContextPackInput): string {
  const instructions = member.instructions.trim();
  return [
    '# Your role instructions',
    instructions || 'No role instructions are configured for you; follow the sections above.',
  ].join('\n');
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
