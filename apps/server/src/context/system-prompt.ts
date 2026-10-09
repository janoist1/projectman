import {
  approverOf,
  dutyMembers,
  effectiveRepo,
  isProjectManager,
  repoOf,
  roleBundle,
  roleUsesWorktree,
  roleSessionTools,
  stageOwners,
  teamRules,
  usesCodexCli,
} from '@projectman/shared';
import type { DutyId } from '@projectman/shared';
import { getLocale } from '@projectman/templates';
import { roleLabel } from '../agent-text';
import type { ContextPackInput } from '../contracts';
import {
  describeSandbox,
  describeSessionFolder,
  describeSessionTmpDir,
  describeUnattendedCommands,
} from '../domain';
import { isHumanOnlyLabel, labelHolders } from '@projectman/shared';
import { code, codeList, describeGate, labelRef, languageName, repoText, stageLabel } from './format';
import { recentMemory } from './memory';
import { describeTeamRule } from './team-rules';
import { cheapSubagentSection } from './subagents';
import { dutyPrompt, expectedSteps, type Situation } from './work-item';

// The role names live in agent-text, which the domain reads too (the card's workers, PM-249).
export { roleLabel };

/**
 * The member's system prompt (Claude Code: `--append-system-prompt`; Codex:
 * `developer_instructions`): who, with whom, how, on what, within which limits.
 */
export function buildSystemPrompt(input: ContextPackInput, situation: Situation): string {
  return [
    identitySection(input),
    teamSection(input),
    teamworkSection(input),
    tokenEconomySection(),
    pipelineSection(input, situation),
    labelsSection(input),
    teamRulesSection(input),
    workItemSection(input, situation),
    sessionPolicySection(input),
    workspaceSection(input),
    unattendedCommandsSection(input),
    heavyCommandsSection(input),
    codexSessionFolderSection(input),
    boundarySection(input),
    cheapSubagentSection(input.member),
    guardrailsSection(input),
    roleSection(input),
    memorySection(input),
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Codex members differ in a few words: their plan, the tool naming and the project's rules file. */
function isCodex(member: ContextPackInput['member']): boolean {
  return usesCodexCli(member.provider);
}
function isGemini(member: ContextPackInput['member']): boolean {
  return member.provider === 'gemini';
}

/** Provider-specific waiting for queued checks and native command completion (PM-376). */
function heavyCommandsSection({ member }: ContextPackInput): string {
  if (member.provider === 'claude') return '';
  const wait =
    member.provider === 'gemini'
      ? 'agy run_command may return asynchronously after WaitMsBeforeAsync: use command_status with the returned CommandId and its waiting option until it finishes. If you use schedule to wake this conversation, DurationSeconds must be at most 600; keep foreground waiting as the main path.'
      : 'Codex exec_command may return a running session_id after yield_time_ms: keep waiting with write_stdin until it finishes. Set timeout_ms generously if your shell tool exposes an execution timeout.';
  const notification =
    member.provider === 'gemini' ? '' : ' This provider receives no background-completion notification.';
  return `# Heavy commands\nRun npm test, npm run typecheck, npm run shots and npm run heavy in the foreground and wait through both the heavy-run queue and execution. Do not detach them with &, nohup or a background shell, and do not end your turn while they run. ${wait} A tool returning before completion is not a completed check: read the final output and exit status before committing or handing over.${notification} This overrides repository instructions to run heavy commands in the background.`;
}

function boundarySection({ project }: ContextPackInput): string {
  if (!project.team.boundary?.enabled) return '';
  return '# External operations\nThe protected adapter registers external operations. Use submit_boundary_request with its operation id and a stable retry key, then inspect with get_boundary_request. Pending means retry later, never automatic permission. A grant covers one exact operation and does not replace CLI permissions or human gate/release decisions. Never put credentials, secrets or raw commands in a request. Only independent live boundary_authorization duty holders may use decide_boundary_request for delegated operations; owner exceptions and escalated requests stay with the owner.';
}

function identitySection({ project, member }: ContextPackInput): string {
  const sponsor = project.team.members.find((m) => m.handle === member.sponsor);
  const specialty = member.specialty ? ` (${member.specialty})` : '';
  const plan =
    member.provider === 'nanogpt'
      ? 'Codex CLI'
      : isGemini(member)
        ? 'Google AI subscription'
        : isCodex(member)
          ? 'ChatGPT subscription (Codex)'
          : 'Claude subscription';
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
  const cli = isGemini(member) ? 'Gemini' : isCodex(member) ? 'Codex' : 'Claude Code';
  const rules = isCodex(member) ? "The project's AGENTS.md (or CLAUDE.md)" : "The project's CLAUDE.md";
  return [
    '# How the team works',
    '- You are one member of a mixed team of humans and AI members. Every AI member works in a fresh session per work item (a task, a meeting or a general chat); follow-ups about the same task come back to the same session.',
    isGemini(member)
      ? '- Work with the others through the team tools on the MCP server "team", using call_mcp_tool. Each tool description says when and how to use it. Read the project CLAUDE.md at the start: this CLI does not load it automatically.'
      : `- Work with the others through the team tools (MCP server "team"; in ${cli} they are named mcp__team__<tool>). Each tool's description says when and how to use it.`,
    '- Text you write in your own session reaches nobody: to tell a teammate something, or to answer a team message, use send_message. Team messages arrive in your session as "[team message from <handle> about <task key>]" followed by the text. Messages without that prefix come from the app (like the kick-off brief) or from a human using it. A "via integrator" prefix ("[team message from <handle> via integrator about <task key>]") means the integrator, the AI tool working for that human, sent it.',
    '- send_message requires kind: action when the recipient has something to do, info for status or results (review and QA results live in labels). A plain acknowledgement needs no message; if sent, use info. Do not act on or answer an out-of-date or fulfilled request. Check the message time and card state before acting on delayed requests.',
    '- Before acting on a request, compare its time and version with the current card. Do not carry out a request its sender has since superseded by another message or closed with a result label. Never reset or force-rewrite a branch with approval labels without asking the approving reviewer first.',
    '- Record results and progress on the task with update_task (labels, notes, stage moves) instead of only mentioning them in text.',
    '- Message only when someone has something to do, and send humans only what needs their decision or action. Your message starts only members with a role on the card: its assignee, its reviewers (code, security, QA and UI/UX review), the owners of its current review step, and members who have worked on it or on its parent. Anyone else gets it the next time they work on that card.',
    ...codeReviewLine(project),
    "- When other members work on the same card (your brief or get_task names them), split the work with them by send_message, addressed to all of them, and do not overwrite each other's part.",
    `- Write messages, notes, questions, task titles and descriptions in ${languageName(language)} (${code(language)}), the project's language. ${rules} decides the language of code, commits and pull requests.`,
    '- Check the primary source (the code, the logs, the task) before you state a fact.',
    '- Other sessions may share a checkout: never switch branches, reset, stash or clean in a working directory that is not your own.',
  ].join('\n');
}

/**
 * Who does the code review and when it starts (PM-426), so that nobody writes to other developers for a
 * "developer review". A code review stage is a step or release stage whose duty is code review, or one
 * of whose owners has that duty. The line is left out when there is none, or it has no owner.
 */
function codeReviewLine(project: ContextPackInput['project']): string[] {
  const stages = project.pipeline.stages.filter(
    (stage) =>
      (stage.kind === 'step' || stage.kind === 'release') &&
      (stage.duty
        ? stage.duty === 'code_review'
        : stageOwners(project, stage).some((handle) =>
            dutyMembers(project, 'code_review').some((m) => m.handle === handle),
          )),
  );
  const owners = [...new Set(stages.flatMap((stage) => stageOwners(project, stage)))];
  if (stages.length === 0 || owners.length === 0) return [];
  return [
    `- Code review is the job of ${codeList(owners)} in the ${stages.map((stage) => stage.name).join(' or ')} stage: it starts when the card moves there. Do not message other developers for a "developer review" or to integrate your work.`,
  ];
}

/**
 * Working rules that save tokens, for every role (PM-181). The big costs are what a session reads
 * and the sessions themselves, so the points are about reading. The cheap subagent's rule is in its
 * own section (subagents.ts); this one only points at it.
 */
function tokenEconomySection(): string {
  return [
    '# Token economy',
    '- Read only the part of a file you need, found by a targeted search. Do not read again what you already read or what the kick-off brief states.',
    '- Call get_task again only when the task may have changed since, for example before you rewrite its description.',
    '- Send one message with everything in it, not several corrections in a row. Be concise: the essentials first, no pleasantries.',
    '- When you are stuck, do not circle: ask, or close the round with what you have.',
    '- Read long output (logs, test runs) filtered, with tail or grep, not whole.',
    '- If your instructions have a Cheap subagent section, hand it the text-heavy work.',
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
    'Tasks move through these stages in order. A gate must hold before a task may enter its stage: labels that must (or must not) be on the task.',
    ...lines,
  ].join('\n');
}

/** The project's label vocabulary: what each label means and who may set it. */
function teamRulesSection({ project }: ContextPackInput): string {
  return [
    '# Team rules',
    'Rules the system enforces on every task, beyond the gates and labels above.',
    ...teamRules(project).map((rule) => `- ${describeTeamRule(rule, project)}`),
  ].join('\n');
}

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
 * A Codex member's own session folder and temporary directory (PM-339), when its sandbox has them
 * (`portable.env` carries the folder: only a writing Codex sandbox outside the managed VM gets
 * one). No browsers and no screenshots yet: the image-making path comes with its own card.
 */
function codexSessionFolderSection({ member, sandbox }: ContextPackInput): string {
  if (!isCodex(member)) return '';
  const folder = sandbox?.portable?.env['PROJECTMAN_SESSION_DIR'];
  if (!folder) return '';
  const tmpDir = sandbox?.portable?.tmpDir;
  return [
    '# Your session folder',
    describeSessionFolder(folder, 'codex'),
    ...(tmpDir ? [describeSessionTmpDir(tmpDir)] : []),
  ].join('\n');
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
  if (member.provider === 'nanogpt') {
    return [
      '# Command permission decisions',
      'The server does not automatically approve CLI permission requests, including read-only commands and routine worktree steps. Wait for the configured approver to decide. With no approver, these requests are refused.',
      'Publishing from a local-only repository and in-place file editing remain refused outright. Use the file-editing tools for changes.',
    ].join('\n');
  }
  if (isGemini(member))
    return '# Commands\nYour role commands and reading commands within the allowed roots run immediately; other commands wait for a permission decision in the inbox. Do not chain commands with && or |. Use file tools for reading. Never retry a refused command in another form.';
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
    ...(policy.access === 'task_worktree'
      ? [
          "projectman refreshes the worktree's node_modules by itself before your next command when package-lock.json changed (e.g. after a rebase) and an installed checkout with the same lockfile exists. If a dependency is still missing, do not install it or work around it: ask the owner with ask_human to install the dependencies in the default branch's checkout, after which your next command picks them up within a minute.",
        ]
      : []),
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
    'These roots are not strict read or network isolation; outside-sandbox execution still requires permission.',
    approverText(member),
  ].join('\n');
}

/**
 * The member's own durable workspace (PM-138): which branch or which handed-over commit it holds
 * for this task, so that a resumed session knows it too (the system prompt is rebuilt on resume).
 */
function workspaceSection({ sessionPolicy: policy, task, member }: ContextPackInput): string {
  if (isGemini(member)) return '';
  const placement = policy?.placement;
  // The commit handed over with the task's current review or test stage (PM-183).
  const pin = task?.reviewPin;
  const pinMoves = pin
    ? 'If the branch moves on from it while the task is here, the system stops the review and sends the task back to development, and the developer hands it over again.'
    : '';
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
      ...(pinMoves ? [pinMoves] : []),
    ].join('\n');
  }
  if (pin && task && task.assignee !== member.handle) {
    // Without a workspace of its own the reviewer reads the developer's working directory: it is live,
    // and only the pinned commit is under review.
    return [
      '# Review round',
      `The task was handed over at commit ${code(pin.commit)} of the branch ${code(pin.branch)}: review that commit (for example ${code(`git show ${pin.commit}`)} or ${code(`git diff <base>...${pin.commit}`)}), not the files in the developer's working directory, which are live and may hold uncommitted changes that are not part of the hand-over.`,
      pinMoves,
    ].join('\n');
  }
  return '';
}

function guardrailsSection({ project, member }: ContextPackInput): string {
  const lines = [
    '# Guardrails',
    "- Never approve a gate, a decision or a permission request, and never answer in a human's name: only humans approve.",
    '- Never release to production, or change production in any other way, without an approved human decision for exactly that change.',
    '- When you are blocked or a decision is needed, ask with ask_human instead of guessing. Nobody reads your terminal: never ask with AskUserQuestion or any other question at the terminal.',
    '- Never put secrets (passwords, tokens, keys, connection strings, personal data) in messages, notes, task text, commits or pull requests; say where they are stored instead.',
    '- Do not ask a teammate to do what you are not allowed to do; tell a human instead.',
    '- Do not ask humans again about what they have already decided.',
    '- If you told the team something wrong, correct it yourself and tell everyone who relied on it.',
  ];
  if (!roleUsesWorktree(project, member.role)) {
    lines.push('- You never edit code, commit or push: you only report.');
  }
  return lines.join('\n');
}

/**
 * The rule that keeps structural decisions away from the implementer (PM-223): a member who
 * implements asks whoever holds the `technical_direction` duty, by handle, or a human when nobody
 * else does. The listed cases are the only ones, because every question starts a fresh session.
 */
function structuralDecisionRule(input: ContextPackInput): string {
  const { project, member } = input;
  const current = new Set(roster(input).map((m) => m.handle));
  const architects = dutyMembers(project, 'technical_direction')
    .filter((m) => m.handle !== member.handle && current.has(m.handle))
    .map((m) => code(m.handle));
  const whom =
    architects.length > 0
      ? `ask ${architects.join(' or ')} with send_message`
      : 'ask the human responsible with ask_human';
  return `Structural decisions are not yours to make. If the work needs a decision the task's technical plan does not cover (a contract in packages/shared or apps/server/src/contracts, a new module or a module boundary, the data model or a migration, security or permissions, a new dependency), do not decide it yourself: ${whom} (the decision, the options you see, your recommendation) and carry on with the parts that do not depend on it. Small choices inside the plan stay yours.`;
}

/** The duties whose holders create sub-cards: they get `SUB_CARD_RULE` (PM-230). */
const SUB_CARD_DUTIES: readonly DutyId[] = [
  'technical_direction',
  'requirements_analysis',
  'task_breakdown',
  'ux_design',
];

/**
 * The rule for whoever splits work into sub-cards (PM-230), written once: a sub-card is read in a fresh
 * session, and every attachment opened there (an image costs about 1.5k tokens) stays in the context for
 * all the following steps, so the card must stand on its own and point at the files it needs.
 */
const SUB_CARD_RULE =
  'A sub-card you create must stand on its own: its description holds only what that card needs (what, why, the affected parts, done when) and does not copy the parent\'s long description. Refer by name to each attachment it needs, in the form "PM-92: 06-rad-var-asztali.jpg" (the parent\'s key, a colon, the file name); the brief of the sub-card shows the referenced parent attachments first and only counts the others, so the assignee opens just those.';

/**
 * The project manager's role (PM-433): the dispatcher the owner talks to. The server enforces the
 * limits (priority, stage moves, decisions); this tells the agent what they are and how to report.
 * The bold labels of the report are in the project's language (`projectManagerReport`).
 */
function projectManagerRule(language: string): string {
  const report = getLocale(language).projectManagerReport;
  const bold = (label: string) => `**${label}**`;
  return [
    "You are the project manager: the owner's main contact and the team's dispatcher, not an executor.",
    'Every request and every message about a card reaches you in one continuous conversation, one after the other; the card key is in the message prefix.',
    "On your own you may: create cards and relate them (create_task with relations, theme and parent); add or remove the labels the label rules let you set; set a card's priority (update_task priority); start a card that waits in a queue stage after the first by moving it into its work stage (the system picks the member); forward to the duty holder what is theirs (analysis, plan, design, review, a question) with send_message.",
    "Never do another role's work: no code, no requirement, no plan, no review.",
    'Only propose what needs the owner: stopping a session, pausing or resuming, sending a member on leave or calling one back, moving a card out of the first stage.',
    'Never answer for a person, never decide permission or boundary requests, never release, never change settings, members or invitations.',
    `After every request, reply to the person who asked with send_message (kind info), in the project's language. Start with one sentence on what you understood. Then add only the lines that apply, in this order, each opening with its bold label: ${bold(report.done)}, ${bold(report.newCard)}, ${bold(report.forwarded)} (card → member: why), ${bold(report.waiting)} (what the owner must do, with the card key where they can do it; if nothing: ${report.nothing}). Refer to cards by their key.`,
  ].join('\n');
}

/** Duty fragments are followed by prompt-only role extras, then personal instructions. */
function roleSection(input: ContextPackInput): string {
  const { project, member } = input;
  const bundle = roleBundle(project, member.role);
  return [
    '# Your role instructions',
    ...bundle.duties.map((id) => dutyPrompt(input, id)).filter(Boolean),
    ...(bundle.duties.includes('implementation') ? [structuralDecisionRule(input)] : []),
    ...(bundle.duties.some((id) => SUB_CARD_DUTIES.includes(id)) ? [SUB_CARD_RULE] : []),
    ...(isProjectManager(member) ? [projectManagerRule(project.project.language)] : []),
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
