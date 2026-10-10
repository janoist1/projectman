import { describe, expect, it } from 'vitest';
import {
  AI_BUILT_IN_ROLE_IDS,
  DUTIES,
  DUTY_IDS,
  LabelDefinition,
  TEAM_RULE_IDS,
  teamRules,
} from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  Attachment,
  DutyId,
  HandoffSummary,
  MemberView,
  ProjectConfig,
  Task,
  TaskRelation,
  TimelineEvent,
  TimelineEventType,
  WorkItemRef,
} from '@projectman/shared';
import { aiMemberDefaults, getTemplate } from '@projectman/templates';
import type {
  CardQuestion,
  CardWorker,
  ContextPackInput,
  HandoffTakeover,
  SessionPolicy,
} from '../contracts';
import { commandVerdict, readableRootsFor, sessionSandbox } from '../domain';
import { buildSessionPolicy } from '../../test/helpers/session-policy';
import { createContextPackBuilder } from './context-pack';
import { stageLabel } from './format';
import { formatMemoryEntry, MEMORY_LIMIT_BYTES } from './memory';
import { roleLabel } from './system-prompt';
import { describeTeamRule } from './team-rules';

const builder = createContextPackBuilder();

describe('team rules in the system prompt', () => {
  it.each(['codex', 'gemini', 'nanogpt'] as const)('requires %s to await heavy commands', (provider) => {
    const project = buildProject();
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider };
    const prompt = builder.build(input({ project, member })).appendSystemPrompt;
    expect(prompt).toContain('# Heavy commands');
    expect(prompt).toContain('in the foreground');
    expect(prompt).toContain('do not end your turn while they run');
    if (provider === 'gemini') {
      expect(prompt).toContain('command_status with the returned CommandId');
      expect(prompt).toContain('schedule');
      expect(prompt).toContain('DurationSeconds must be at most 600');
      expect(prompt).not.toContain('This provider receives no background-completion notification');
    } else expect(prompt).toContain('write_stdin');
  });

  it('leaves Claude background completion to its native notification', () => {
    expect(builder.build(input()).appendSystemPrompt).not.toContain('# Heavy commands');
  });
  it('describes explicit approval instead of unattended commands for NanoGPT members', () => {
    const project = buildProject();
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'nanogpt' };
    const prompt = builder.build(input({ project, member })).appendSystemPrompt;
    expect(prompt).toContain('# Command permission decisions');
    expect(prompt).toContain('The server does not automatically approve CLI permission requests');
    expect(prompt).not.toContain('# Commands that run without asking');
    expect(prompt).not.toContain('NANOGPT_API_KEY');
  });

  it('describes every applicable rule immediately after labels without duplicate guardrails', () => {
    const project = buildProject();
    project.pipeline.labels.push(LabelDefinition.parse({ id: 'refine', name: 'Refine' }));
    const prompt = builder.build(input({ project })).appendSystemPrompt;
    const rules = teamRules(project);
    expect(rules.map((rule) => rule.id)).toEqual([...TEAM_RULE_IDS]);
    expect(prompt.indexOf('# Team rules')).toBeGreaterThan(prompt.indexOf('# Labels'));
    expect(section(prompt, '# Labels')).not.toContain('# Team rules');
    for (const rule of rules)
      expect(section(prompt, '# Team rules')).toContain(`- ${describeTeamRule(rule, project)}`);
    expect(prompt.match(/Approvals:/g)).toHaveLength(1);
    expect(prompt.match(/Nobody approves their own work:/g)).toHaveLength(1);
    expect(prompt).not.toContain('Approvals are labels only humans may set; the app asks them.');
    expect(prompt).not.toContain('Never set a label marked "not on your own work"');
  });

  it('renders the configured fix limit and human fallback', () => {
    const project = buildProject();
    project.team.limits.maxFixRounds = 5;
    expect(section(builder.build(input({ project })).appendSystemPrompt, '# Team rules')).toContain(
      'reaches 5 rounds',
    );
    const rule = teamRules(project).find((entry) => entry.id === 'fix_limit')!;
    expect(describeTeamRule({ ...rule, labels: [], lead: null, deciders: ['owner'] }, project)).toContain(
      'a human decides in their inbox (`owner`)',
    );
  });
});

/** Adds an AI member of the role with the role's defaults to the project. */
function addMember(
  project: ProjectConfig,
  handle: string,
  role: string,
  extra: Partial<AiMemberConfig> = {},
) {
  const defaults = aiMemberDefaults(role, project.team.roles);
  if (!defaults) throw new Error(`no AI can hold ${role}`);
  const member: AiMemberConfig = {
    kind: 'ai',
    handle,
    displayName: extra.displayName ?? handle,
    role,
    ...defaults,
    sponsor: 'owner',
    temp: false,
    ...extra,
  };
  project.team.members.push(member);
  return member;
}

function buildProject(templateId = 'web-client-project', language = 'en'): ProjectConfig {
  const template = getTemplate(templateId);
  if (!template) throw new Error(`missing template ${templateId}`);
  const config = template.build({
    key: 'AR',
    name: 'Acme Web',
    workspacePath: '/work/acme',
    language,
    owner: { handle: 'owner', displayName: 'Anna Example', email: 'anna@example.com' },
  });
  config.project.repos.push({ name: 'app', path: 'app', github: 'acme/app', defaultBranch: 'main' });
  return config;
}

/** The same project with its `app` repository local-only: no GitHub name, at `repoPath` in the workspace. */
function buildLocalOnlyProject(repoPath = 'app', templateId?: string): ProjectConfig {
  const project = buildProject(templateId);
  const repo = project.project.repos.find((r) => r.name === 'app')!;
  delete repo.github;
  repo.path = repoPath;
  return project;
}

/** The same project without repositories: its tasks work in the workspace root. */
function buildProjectWithoutRepos(): ProjectConfig {
  const project = buildProject();
  project.project.repos = [];
  return project;
}

/** The same project with a second repository: a task has to name the one it works in. */
function buildProjectWithTwoRepos(buildOne: () => ProjectConfig = buildProject): ProjectConfig {
  const project = buildOne();
  project.project.repos.push({ name: 'api', path: 'api', github: 'acme/api', defaultBranch: 'main' });
  return project;
}

function aiMember(project: ProjectConfig, handle: string): AiMemberConfig {
  const member = project.team.members.find((m) => m.handle === handle);
  if (!member || member.kind !== 'ai') throw new Error(`no AI member ${handle}`);
  return member;
}

function teamOf(project: ProjectConfig): MemberView[] {
  return project.team.members.map((m) => ({
    handle: m.handle,
    displayName: m.displayName,
    kind: m.kind,
    role: m.kind === 'human' ? m.access : m.role,
    roles: m.kind === 'human' ? m.roles : [m.role],
    specialty: m.kind === 'ai' ? (m.specialty ?? null) : null,
    status: 'idle',
    activity: null,
    currentTaskKeys: [],
    sponsor: m.kind === 'ai' ? m.sponsor : null,
    temp: m.kind === 'ai' ? m.temp : false,
  }));
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk_21',
    projectKey: 'AR',
    key: 'AR-21',
    title: 'Fix the booking confirmation email',
    description:
      'The confirmation email shows the wrong room name.\n\n- Steps: book any room as a guest\n- Expected: the email names the booked room',
    stageId: 'code_review',
    status: 'active',
    assignee: 'fe-1',
    repo: 'app',
    priority: 'high',
    labels: ['bug', 'email'],
    links: [
      {
        kind: 'pull_request',
        ref: '123',
        repo: 'acme/app',
        title: 'Fix room name in confirmation email',
        state: 'open',
      },
      { kind: 'branch', ref: 'AR-21-fix-the-booking-confirmation-email', repo: 'acme/app' },
      { kind: 'prerequisite', ref: 'AR-19', title: 'Update mail templates', state: 'done' },
      { kind: 'url', ref: 'https://example.com/reports/42', title: 'Client report' },
    ],
    visibility: 'shared',
    createdBy: 'owner',
    createdAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-29T10:00:00.000Z',
    closedAt: null,
    ...overrides,
  };
}

let eventSeq = 0;
function event(
  at: string,
  actor: string | null,
  type: TimelineEventType,
  data: Record<string, unknown>,
): TimelineEvent {
  const kind: Actor['kind'] = actor === null ? 'system' : actor === 'owner' ? 'human' : 'ai';
  eventSeq += 1;
  return {
    id: `evt_${eventSeq}`,
    projectKey: 'AR',
    taskKey: 'AR-21',
    sessionId: null,
    actor: { kind, handle: actor },
    type,
    data,
    createdAt: at,
  };
}

const timeline: TimelineEvent[] = [
  event('2026-09-28T08:00:00.000Z', 'owner', 'task_created', { title: 'Fix the booking confirmation email' }),
  event('2026-09-28T08:05:00.000Z', 'owner', 'task_assigned', { assignee: 'fe-1' }),
  event('2026-09-28T08:05:01.000Z', null, 'session_started', { member: 'fe-1', resumed: false }),
  event('2026-09-28T08:06:00.000Z', 'fe-1', 'task_stage_changed', { from: 'ready', to: 'dev' }),
  event('2026-09-28T09:10:00.000Z', 'fe-1', 'permission_requested', {
    inboxItemId: 'inb_1',
    toolName: 'Bash',
    summary: 'npm test',
  }),
  event('2026-09-28T09:30:00.000Z', 'owner', 'task_labels_changed', {
    added: ['waiting-answer'],
    removed: [],
  }),
  event('2026-09-28T10:45:00.000Z', 'owner', 'task_labels_changed', {
    added: [],
    removed: ['waiting-answer'],
  }),
  event('2026-09-28T11:30:00.000Z', 'fe-1', 'task_link_added', {
    kind: 'pull_request',
    ref: '123',
    repo: 'acme/app',
  }),
  event('2026-09-28T11:31:00.000Z', 'fe-1', 'task_stage_changed', { from: 'dev', to: 'code_review' }),
  event('2026-09-28T11:31:30.000Z', 'fe-1', 'team_message', {
    messageId: 'msg_1',
    from: 'fe-1',
    to: ['code-review'],
    excerpt: 'PR acme/app#123 is ready for review:\nthe room name now comes from the booking, not the cart.',
  }),
];

const memory =
  formatMemoryEntry(
    new Date('2026-09-20T09:00:00.000Z'),
    'Mail templates live in templates/email; run `npm run mail:preview` to render them.',
  ) +
  formatMemoryEntry(
    new Date('2026-09-25T16:45:00.000Z'),
    'The team wants pull request descriptions to list manual test steps.',
  );

const screenshot = (overrides: Partial<Attachment> = {}): Attachment => ({
  id: 'att_screenshot01',
  projectKey: 'AR',
  taskKey: 'AR-21',
  fileName: 'reset-mail.png',
  size: 48_213,
  mediaType: 'image/png',
  preview: 'image',
  uploadedBy: { kind: 'human', handle: 'owner' },
  createdAt: '2026-09-27T09:15:00.000Z',
  ...overrides,
});

const testReport = (): Attachment => ({
  ...screenshot(),
  id: 'att_testreport01',
  fileName: 'test-run.log',
  size: 1_250_000,
  mediaType: 'application/octet-stream',
  preview: 'none',
  uploadedBy: { kind: 'ai', handle: 'fe-1' },
  createdAt: '2026-09-28T10:02:00.000Z',
});

function input(overrides: Partial<ContextPackInput> & { handle?: string } = {}): ContextPackInput {
  const { handle = 'code-review', ...rest } = overrides;
  const project = rest.project ?? buildProject();
  const task = rest.task === undefined ? makeTask() : rest.task;
  return {
    project,
    member: aiMember(project, handle),
    workItem: { type: 'task', taskKey: 'AR-21' },
    task,
    stage: task ? (project.pipeline.stages.find((s) => s.id === task.stageId) ?? null) : null,
    timeline,
    team: teamOf(project),
    memory,
    relations: [
      { kind: 'prerequisite', key: 'AR-19', title: 'Update mail templates', stageId: 'done', status: 'done' },
    ],
    ...rest,
  };
}

/** One section of the system prompt, from its heading to the next one. */
function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  if (start < 0) return '';
  const end = prompt.indexOf('\n# ', start + 1);
  return prompt.slice(start + 1, end < 0 ? undefined : end);
}

/** The numbered steps under "What done means for you here" in the system prompt. */
function doneSteps(prompt: string): string {
  const steps = prompt.split('What done means for you here:\n')[1] ?? '';
  return steps.slice(0, steps.indexOf('\n\n'));
}

/** The sections a repository without GitHub words differently: the steps and the role instructions. */
const LOCAL_ONLY_HEADINGS = ['# Current work item', '# Your role instructions'];

function localOnlyParts(prompt: string): string {
  return LOCAL_ONLY_HEADINGS.map((heading) => section(prompt, heading)).join('\n');
}

/**
 * The system prompt without those sections, and without the one line about refused publishing in
 * "Commands that run without asking".
 */
function withoutLocalOnlyParts(prompt: string): string {
  return LOCAL_ONLY_HEADINGS.reduce(
    (text, heading) => text.replace(section(text, heading), ''),
    prompt.replace(/^- Refused outright:.*\n/m, ''),
  );
}

const dataSteward = {
  id: 'data_steward',
  name: 'Data steward',
  summary: 'Keeps the reference data clean.',
  notTheirJob: 'Does not change the database schema.',
  holders: 'both' as const,
  instructions: 'Check the reference tables for duplicates and report them to the owner.',
};

/**
 * A few whole context packs, built from the live web-client-project template: they show how the
 * sections read together. Details of each section are covered by the focused tests below.
 */
describe('context pack snapshots', () => {
  it('developer starting development', async () => {
    const pack = builder.build(
      input({
        handle: 'fe-1',
        task: makeTask({
          stageId: 'dev',
          links: [{ kind: 'prerequisite', ref: 'AR-19', title: 'Update mail templates', state: 'done' }],
        }),
        timeline: timeline.slice(0, 4),
      }),
    );
    await expect(`${pack.appendSystemPrompt}\n`).toMatchFileSnapshot(
      '__snapshots__/developer-dev.system-prompt.txt',
    );
    await expect(`${pack.initialMessage}\n`).toMatchFileSnapshot('__snapshots__/developer-dev.brief.txt');
  });

  it('code reviewer reviewing a pull request', async () => {
    const pack = builder.build(input({ handle: 'code-review', attachments: [screenshot(), testReport()] }));
    await expect(`${pack.appendSystemPrompt}\n`).toMatchFileSnapshot(
      '__snapshots__/code-review-code_review.system-prompt.txt',
    );
    await expect(`${pack.initialMessage}\n`).toMatchFileSnapshot(
      '__snapshots__/code-review-code_review.brief.txt',
    );
  });

  // The repository's GitHub name is all that differs from the two packs above, so the snapshots of a
  // local-only repository hold the two sections that change (see 'repositories without GitHub', which
  // also checks that the rest of the pack and the brief stay as they are).
  it('developer starting development in a local-only repository', async () => {
    const pack = builder.build(
      input({
        project: buildLocalOnlyProject('.'),
        handle: 'fe-1',
        task: makeTask({
          stageId: 'dev',
          links: [{ kind: 'prerequisite', ref: 'AR-19', title: 'Update mail templates', state: 'done' }],
        }),
        timeline: timeline.slice(0, 4),
      }),
    );
    await expect(localOnlyParts(pack.appendSystemPrompt)).toMatchFileSnapshot(
      '__snapshots__/developer-dev-local-only.instructions.txt',
    );
  });

  it('code reviewer reviewing the branch of a local-only repository', async () => {
    const pack = builder.build(
      input({
        project: buildLocalOnlyProject('.'),
        handle: 'code-review',
        task: makeTask({ links: [{ kind: 'branch', ref: 'AR-21-fix-the-booking-confirmation-email' }] }),
      }),
    );
    await expect(localOnlyParts(pack.appendSystemPrompt)).toMatchFileSnapshot(
      '__snapshots__/code-review-code_review-local-only.instructions.txt',
    );
  });

  it('custom role member in a general chat', async () => {
    const project = buildProject();
    project.team.roles.push(dataSteward);
    addMember(project, 'data-steward', 'data_steward', {
      displayName: 'Data steward',
      instructions: 'Start with the product catalogue.',
    });
    const owner = project.team.members[0]!;
    if (owner.kind === 'human') owner.roles = ['operator', 'product_owner', 'data_steward'];
    const pack = builder.build(
      input({
        project,
        handle: 'data-steward',
        workItem: { type: 'general' },
        task: null,
        stage: null,
        timeline: [],
        memory: '',
      }),
    );
    expect(pack.initialMessage).toBeNull();
    await expect(`${pack.appendSystemPrompt}\n`).toMatchFileSnapshot(
      '__snapshots__/custom-role-general.system-prompt.txt',
    );
  });
});

describe('token economy (PM-181)', () => {
  const customRolePack = () => {
    const project = buildProject();
    project.team.roles.push(dataSteward);
    addMember(project, 'data-steward', 'data_steward', {
      displayName: 'Data steward',
      instructions: 'Start with the product catalogue.',
    });
    return builder.build(
      input({
        project,
        handle: 'data-steward',
        workItem: { type: 'general' },
        task: null,
        stage: null,
        timeline: [],
        memory: '',
      }),
    );
  };

  it('is in the system prompt of every role, custom roles included, after how the team works', () => {
    const prompts = [
      ...AI_BUILT_IN_ROLE_IDS.map((role) => {
        const project = buildProject();
        addMember(project, `member-${role}`, role);
        return builder.build(input({ project, handle: `member-${role}` })).appendSystemPrompt;
      }),
      customRolePack().appendSystemPrompt,
    ];
    expect(prompts.length).toBeGreaterThan(AI_BUILT_IN_ROLE_IDS.length);
    for (const prompt of prompts) {
      expect(prompt).toContain('# Token economy\n');
      const headings = prompt.split('\n').filter((line) => line.startsWith('# '));
      expect(headings.indexOf('# Token economy')).toBe(headings.indexOf('# How the team works') + 1);
      expect(prompt.split('# Token economy').length - 1).toBe(1);
    }
  });

  it('keeps to six points that do not contradict the existing rules', () => {
    const economy = section(builder.build(input()).appendSystemPrompt, '# Token economy');
    expect(economy.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(6);
    // Re-reading the task before rewriting its description stays allowed, as the exception.
    expect(economy).toContain('Call get_task again only when the task may have changed since');
    expect(economy).toContain('before you rewrite its description');
    // The cheap subagent's own rule is in its section: this only points at it.
    expect(economy).toContain('If your instructions have a Cheap subagent section');
    expect(economy).not.toContain('reader-');
  });

  // The prompt and the kick-off brief together may not grow from the size they had before PM-181
  // (measured on the snapshots of that time, in characters). The developer's allowance grew once,
  // to make room for the structural decision rule of PM-223, and again for the rule of working on the
  // same card as others (PM-249), then for targeted checks (PM-335) and shared team rules (PM-289).
  // PM-287 names priority (high, not 2), adding three characters to the brief.
  // PM-368 adds 634 characters for message kinds, obsolete requests and approved-branch handling.
  // PM-251 adds 158 characters for the attributed integrator prefix.
  // PM-426 adds 463 characters: who a message starts, and whose job the code review is.
  // PM-432 adds 39 characters: every team has a project manager, one more line in the team list.
  // PM-445 adds 141 characters: a human's decision is asked with ask_human, never with send_message.
  // PM-462 adds 35 characters: every team has an Operator, one more line in the team list (the human
  // operator role is now called owner, three characters shorter).
  it.each([
    { name: 'developer', handle: 'fe-1', system: 16277, brief: 865 },
    { name: 'code reviewer', handle: 'code-review', system: 14377, brief: 1903 },
  ])('does not grow the system prompt and brief of the $name', ({ handle, system, brief }) => {
    const pack =
      handle === 'fe-1'
        ? builder.build(
            input({
              handle,
              task: makeTask({
                stageId: 'dev',
                links: [
                  { kind: 'prerequisite', ref: 'AR-19', title: 'Update mail templates', state: 'done' },
                ],
              }),
              timeline: timeline.slice(0, 4),
            }),
          )
        : builder.build(input({ handle, attachments: [screenshot(), testReport()] }));
    expect(pack.appendSystemPrompt.length + (pack.initialMessage?.length ?? 0)).toBeLessThanOrEqual(
      system + brief,
    );
  });

  it('does not grow the system prompt of a custom role', () => {
    // PM-376 adds provider-specific waiting instructions, avoiding stranded background checks.
    // PM-251 explains the integrator prefix (+158 characters).
    // PM-426 adds the same 463 characters (who a message starts, whose job the code review is).
    // PM-432 adds the project manager's 39-character line to the team list.
    // PM-445 adds 141 characters: a human's decision is asked with ask_human, never with send_message.
    // PM-462 adds the Operator's 35 characters to the team list.
    expect(customRolePack().appendSystemPrompt.length).toBeLessThanOrEqual(11026);
  });
});

describe('built-in tools the prompts name (PM-221)', () => {
  // Left out of the session's `--tools` list: a prompt that sends the member to one would strand it.
  const leftOut = [
    'Artifact',
    'ArtifactComments',
    'ArtifactData',
    'Workflow',
    'ScheduleWakeup',
    'ReportFindings',
    'SendFeedback',
    'SendMessage',
    'ListAgents',
    'CronCreate',
    'CronDelete',
    'CronList',
    'RemoteTrigger',
    'PushNotification',
    'EnterWorktree',
    'ExitWorktree',
    'EnterPlanMode',
    'ExitPlanMode',
    'DesignSync',
    'NotebookEdit',
    'Skill',
    'Grep',
    'Glob',
  ];

  it.each(AI_BUILT_IN_ROLE_IDS)('names no tool the %s does not have', (role) => {
    const project = buildProject();
    addMember(project, `member-${role}`, role);
    const pack = builder.build(input({ project, handle: `member-${role}` }));
    const text = `${pack.appendSystemPrompt}\n${pack.initialMessage ?? ''}`;
    for (const tool of leftOut) expect(text).not.toMatch(new RegExp(`\\b${tool}\\b`));
  });
});

describe('cheap subagent (PM-179)', () => {
  const withCheapSubagent = (cheapSubagent: AiMemberConfig['cheapSubagent'], provider?: 'codex') => {
    const project = buildProject();
    const member: AiMemberConfig = {
      ...aiMember(project, 'fe-1'),
      ...(cheapSubagent ? { cheapSubagent } : {}),
      ...(provider ? { provider } : {}),
    };
    return builder.build(input({ project, member, handle: 'fe-1', task: makeTask({ stageId: 'dev' }) }));
  };

  it('gives the member the rule and the reader on the chosen model when it is on', async () => {
    const pack = withCheapSubagent('haiku');
    await expect(section(pack.appendSystemPrompt, '# Cheap subagent')).toMatchFileSnapshot(
      '__snapshots__/developer-dev-cheap-subagent.section.txt',
    );
    expect(pack.subagents).toEqual([
      {
        name: 'reader-haiku',
        description: expect.stringContaining('Haiku'),
        prompt: expect.stringContaining('short, precise result'),
        tools: ['Read', 'Bash'],
        model: 'haiku',
      },
    ]);
    const sonnet = withCheapSubagent('sonnet');
    expect(sonnet.subagents.map((agent) => [agent.name, agent.model])).toEqual([['reader-sonnet', 'sonnet']]);
    expect(section(sonnet.appendSystemPrompt, '# Cheap subagent')).toContain('`reader-sonnet`');
  });

  it('puts the rule after the external operations and before the guardrails', () => {
    const headings = withCheapSubagent('haiku')
      .appendSystemPrompt.split('\n')
      .filter((line) => line.startsWith('# '));
    expect(headings.indexOf('# Cheap subagent')).toBe(headings.indexOf('# Guardrails') - 1);
  });

  it('changes nothing when it is off', () => {
    const off = withCheapSubagent(undefined);
    expect(off.subagents).toEqual([]);
    expect(off.appendSystemPrompt).not.toContain('# Cheap subagent');
    expect(off.appendSystemPrompt).not.toContain('reader-');
    // The rest of the prompt is the same with the subagent on.
    const on = withCheapSubagent('haiku').appendSystemPrompt;
    // (A section ends with its line break; another one separates it from the next.)
    expect(on.replace(`${section(on, '# Cheap subagent')}\n`, '')).toBe(off.appendSystemPrompt);
  });

  it('gives a Codex member neither the rule nor the subagent', () => {
    const codex = withCheapSubagent('haiku', 'codex');
    expect(codex.subagents).toEqual([]);
    expect(codex.appendSystemPrompt).not.toContain('# Cheap subagent');
  });
});

describe('context pack builder', () => {
  it('is deterministic', () => {
    const first = builder.build(input());
    const second = builder.build(structuredClone(input()));
    expect(second).toEqual(first);
  });

  it('builds scheduled work without a task and includes the schedule prompt', () => {
    const source = input({
      task: null,
      stage: null,
      timeline: [],
      workItem: { type: 'schedule', runId: 'run_fictional' },
    });
    source.member.schedule = { cron: '0 9 * * *', prompt: 'Inspect fictional maintenance opportunities.' };
    const pack = builder.build(source);
    expect(pack.initialMessage).toBe(source.member.schedule.prompt);
    expect(pack.appendSystemPrompt).toContain('Scheduled run `run_fictional` in the project workspace');
    expect(pack.appendSystemPrompt).toContain(source.member.handle);
  });

  it('shows a long note cut, with the event id to read it whole with get_task (PM-191)', () => {
    const long = event('2026-09-28T11:00:00.000Z', 'fe-1', 'task_note', { text: 'z'.repeat(2000) });
    const short = event('2026-09-28T11:01:00.000Z', 'fe-1', 'task_note', { text: 'short note' });
    const brief = builder.build(input({ timeline: [long, short] })).initialMessage!;
    expect(brief).toContain(`note: ${'z'.repeat(279)}…`);
    expect(brief).not.toContain('z'.repeat(281));
    expect(brief).toContain(`(cut, 2000 chars; read it whole: get_task task_key AR-21, event_id ${long.id})`);
    expect(brief).toContain('note: short note');
    expect(brief.split('read it whole:')).toHaveLength(2);
  });

  it('writes a brief only for known tasks', () => {
    const general = builder.build(input({ workItem: { type: 'general' }, task: null, stage: null }));
    expect(general.initialMessage).toBeNull();
    expect(section(general.appendSystemPrompt, '# Current work item')).toContain(
      'A general conversation, not tied to a task: help with what you are asked.',
    );
    const meeting: WorkItemRef = { type: 'meeting', meetingId: 'standup-2026-09-29' };
    const inMeeting = builder.build(input({ workItem: meeting, task: null, stage: null }));
    expect(inMeeting.initialMessage).toBeNull();
    expect(inMeeting.appendSystemPrompt).toContain('A team meeting (`standup-2026-09-29`)');
    const unknown = builder.build(input({ task: null, stage: null }));
    expect(unknown.initialMessage).toBeNull();
    expect(unknown.appendSystemPrompt).toContain('Task `AR-21`. Its details were not available');
  });
});

describe('continue message', () => {
  it('tells a restarted task session which task and stage it is in, and to check where it left off', () => {
    const message = builder.build(input()).continueMessage;
    expect(message).toBe(
      'Your session was restarted. ' +
        'You are working on AR-21 "Fix the booking confirmation email", now in stage Code review (`code_review`). ' +
        "Check where you left off (git status in your working directory, and the task's comments and attachments in get_task), " +
        "then carry on as usual, writing in English (`en`), the project's language.",
    );
    // Short: three sentences, one line, English.
    expect(message).not.toContain('\n');
    expect(message!.match(/\. /g)).toHaveLength(2);
  });

  it("names the member's other running sessions in one more sentence, when there are any (PM-184)", () => {
    const message = builder.build(
      input({
        relatedSessions: [
          { taskKey: 'AR-20', title: 'Booking flow rework', relation: 'parent', state: 'working' },
          { taskKey: 'AR-19', title: 'Update mail templates', relation: 'prerequisite', state: 'idle' },
        ],
      }),
    ).continueMessage;
    expect(message).toContain(
      "the project's language. Your other running sessions: AR-20 (the parent card), AR-19 (a prerequisite of this card); " +
        'the standing is on the cards, so read them before you give direction.',
    );
    expect(message).not.toContain('\n');
    expect(builder.build(input()).continueMessage).not.toContain('Your other running sessions');
  });

  it('names the commit a returning reviewer reviewed last, and asks for only what changed since (PM-213)', () => {
    const pin = { commit: 'b'.repeat(40), branch: 'AR-21-fix-email', pinnedAt: '2026-10-01T10:00:00.000Z' };
    const message = builder.build(
      input({ task: makeTask({ reviewPin: pin }), lastReviewedCommit: 'a'.repeat(40) }),
    ).continueMessage;
    expect(message).toContain(
      `You last reviewed commit \`${'a'.repeat(40)}\`; the commit handed over now is \`${'b'.repeat(40)}\` on \`AR-21-fix-email\`. ` +
        `Review only the change since your last review (git diff ${'a'.repeat(40)} ${'b'.repeat(40)}) and whether your earlier findings were fixed; do not read the whole change again.`,
    );
    expect(message).not.toContain('\n');
    // The branch did not move: only the earlier findings are left to check.
    expect(
      builder.build(input({ task: makeTask({ reviewPin: pin }), lastReviewedCommit: pin.commit }))
        .continueMessage,
    ).toContain('the branch has not moved since, so check only that your earlier findings were fixed');
    // Nothing is said without a pin on the card or without a last review.
    expect(builder.build(input({ lastReviewedCommit: 'a'.repeat(40) })).continueMessage).not.toContain(
      'last reviewed',
    );
    expect(builder.build(input({ task: makeTask({ reviewPin: pin }) })).continueMessage).not.toContain(
      'last reviewed',
    );
  });

  it('names the current stage and the project language', () => {
    const project = buildProject('web-client-project', 'hu');
    const message = builder.build(
      input({ project, handle: 'fe-1', task: makeTask({ stageId: 'dev', title: 'Új foglalási űrlap' }) }),
    ).continueMessage;
    expect(message).toContain('You are working on AR-21 "Új foglalási űrlap", now in stage ');
    expect(message).toContain(`stage ${stageLabel(project.pipeline.stages.find((s) => s.id === 'dev')!)}.`);
    expect(message).toContain("writing in Hungarian (`hu`), the project's language.");
  });

  it('falls back to the stage id when the stage is no longer in the pipeline', () => {
    const message = builder.build(
      input({ task: makeTask({ stageId: 'retired_stage' }), stage: null }),
    ).continueMessage;
    expect(message).toContain('now in stage `retired_stage`.');
  });

  it('is only for task sessions', () => {
    const scheduled = input({
      task: null,
      stage: null,
      workItem: { type: 'schedule', runId: 'run_fictional' },
    });
    scheduled.member.schedule = { cron: '0 9 * * *', prompt: 'Inspect fictional maintenance.' };
    const cases: Array<Partial<ContextPackInput>> = [
      { workItem: { type: 'general' }, task: null, stage: null },
      { workItem: { type: 'meeting', meetingId: 'standup-2026-09-29' }, task: null, stage: null },
      { task: null, stage: null },
      scheduled,
    ];
    for (const overrides of cases) expect(builder.build(input(overrides)).continueMessage).toBeNull();
  });
});

describe('system prompt', () => {
  it('has its sections in a fixed order', () => {
    const prompt = builder.build(input()).appendSystemPrompt;
    expect(prompt.split('\n').filter((line) => line.startsWith('# '))).toEqual([
      '# Who you are',
      '# The team',
      '# How the team works',
      '# Token economy',
      '# The pipeline',
      '# Labels',
      '# Team rules',
      '# Current work item',
      '# Commands that run without asking',
      '# Guardrails',
      '# Your role instructions',
      '# Your memory',
    ]);
  });

  describe('commands that run without asking', () => {
    const HEADING = '# Commands that run without asking';
    const commandsOf = (overrides: Parameters<typeof input>[0]) =>
      section(builder.build(input(overrides)).appendSystemPrompt, HEADING);

    it('tells a developer the routine steps with the repository default branch', () => {
      const text = commandsOf({ handle: 'fe-1' });
      expect(text).toContain("in your working directory (the task's worktree)");
      expect(text).toContain('`git merge --ff-only main`');
      expect(text).toContain('`git commit -m "message"`');
      expect(text).toContain('Claude Code also pre-approves');
      expect(text).not.toContain('Refused outright');
    });

    it('tells a reviewer the reading rules only', () => {
      const text = commandsOf({ handle: 'code-review' });
      expect(text).toContain("your working directory and the task's own worktree");
      expect(text).toContain('`npm run typecheck`');
      expect(text).not.toContain('git commit');
    });

    it('says publishing is refused in a local-only repository', () => {
      expect(commandsOf({ handle: 'fe-1', project: buildLocalOnlyProject() })).toContain(
        'Refused outright: `git push`',
      );
    });

    it('leaves the Claude Code allow list out for a Codex member', () => {
      const project = buildProject();
      const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'codex' };
      const text = commandsOf({ project, member });
      expect(text).toContain('`git commit -m "message"`');
      expect(text).not.toContain('Claude Code');
      expect(text).toContain('Your sandbox runs commands on its own');
      expect(text).not.toContain('Every other shell command');
    });

    it('is left out of work that is not a task', () => {
      for (const workItem of [
        { type: 'general' } as const,
        { type: 'meeting', meetingId: 'mtg_1' } as const,
      ]) {
        const prompt = builder.build(input({ workItem, task: null })).appendSystemPrompt;
        expect(prompt).not.toContain(HEADING);
      }
    });
  });

  it('introduces the member, the team and the sponsor', () => {
    const prompt = builder.build(input({ handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain(
      "You are Frontend developer (handle `fe-1`), the developer (Frontend) of the Acme Web team (project key `AR`); you run on Anna Example's Claude subscription.",
    );
    expect(prompt).toContain('- `owner`: Anna Example (human, owner; roles: owner, product owner)');
    expect(prompt).toContain('- `fe-1`: Frontend developer (AI, developer, Frontend) ← you');
    expect(prompt.match(/← you/g)).toHaveLength(1);
  });

  it('describes a temporary stand-in and leaves retired members out', () => {
    const project = buildProject();
    const temp: AiMemberConfig = {
      ...aiMember(project, 'fe-1'),
      handle: 'temp-1',
      displayName: 'Stand-in',
      temp: true,
    };
    project.team.members.push(temp);
    const team = teamOf(project).map((m) => (m.handle === 'be-1' ? { ...m, status: 'retired' as const } : m));
    const prompt = builder.build(input({ project, member: temp, team, handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain('You are a temporary stand-in hired for one task');
    expect(prompt).toContain('- `temp-1`: Stand-in (AI, developer, Frontend, temporary) ← you');
    expect(prompt).not.toContain('- `be-1`');
  });

  it('builds the roster from the configuration when no team view is given', () => {
    const prompt = builder.build(input({ team: [] })).appendSystemPrompt;
    expect(prompt).toContain('- `code-review`: Code reviewer (AI, code reviewer) ← you');
    expect(prompt).toContain('- `owner`: Anna Example (human, owner; roles: owner, product owner)');
  });

  it('states each team rule once and leaves the tool list to the tool descriptions', () => {
    // The tool descriptions and the MCP server instructions leave these rules to the system prompt.
    const prompt = builder.build(input()).appendSystemPrompt;
    for (const rule of [
      'Address members by handle',
      'reaches nobody',
      'instead of only mentioning them in text',
      'Be concise',
      "the project's language",
      'Message only when someone has something to do',
    ]) {
      expect(prompt.split(rule).length - 1, rule).toBe(1);
    }
    const teamwork = section(prompt, '# How the team works');
    expect(teamwork).toContain('mcp__team__<tool>');
    expect(teamwork).not.toContain('list_network_denials');
  });

  it('says who is started by a message and whose job the code review is (PM-426)', () => {
    const project = buildProject();
    const teamwork = section(builder.build(input({ project })).appendSystemPrompt, '# How the team works');
    expect(teamwork).toContain('Your message starts only members with a role on the card');
    const review = project.pipeline.stages.find((s) => s.kind === 'step' && s.duty === 'code_review');
    expect(review).toBeDefined();
    expect(teamwork).toContain(
      `- Code review is the job of \`code-review\` in the ${review!.name} stage: it starts when the card moves there. Do not message other developers for a "developer review" or to integrate your work.`,
    );
    // A pipeline with no code review stage leaves the line out.
    const without = buildProject();
    without.pipeline.stages = without.pipeline.stages.filter((s) => s.id !== review!.id);
    const bare = section(
      builder.build(input({ project: without })).appendSystemPrompt,
      '# How the team works',
    );
    expect(bare).not.toContain('Code review is the job of');
    expect(bare).toContain('Your message starts only members with a role on the card');
  });

  it('tells the member to write in the project language', () => {
    const hungarian = builder.build(input({ project: buildProject('web-client-project', 'hu') }));
    expect(hungarian.appendSystemPrompt).toContain("in Hungarian (`hu`), the project's language");
    const english = builder.build(input());
    expect(english.appendSystemPrompt).toContain("in English (`en`), the project's language");
  });

  describe('the project manager rule (PM-433)', () => {
    const roleOf = (prompt: string) => section(prompt, '# Your role instructions');
    const withPm = (language: string) => {
      const project = buildProject('web-client-project', language);
      addMember(project, 'pm', 'project_manager');
      return project;
    };

    it('gives the dispatcher role and the order of the report to the project manager alone', () => {
      const project = withPm('en');
      const pm = roleOf(builder.build(input({ project, handle: 'pm' })).appendSystemPrompt);
      expect(pm).toContain(
        "You are the project manager: the team's dispatcher, not an executor. The owner talks to the Operator about how the project runs; the Operator may also give you a task, and you take it as you take the owner's.",
      );
      expect(pm).toContain(
        'in one continuous conversation, one after the other; the card key is in the message prefix',
      );
      expect(pm).toContain("set a card's priority (update_task priority)");
      expect(pm).toContain('(the system picks the member)');
      expect(pm).toContain("Never do another role's work: no code, no requirement, no plan, no review.");
      expect(pm).toContain('Only propose what needs the owner: stopping a session');
      expect(pm).toContain('never decide permission or boundary requests, never release');
      for (const handle of ['code-review', 'fe-1'])
        expect(roleOf(builder.build(input({ project, handle })).appendSystemPrompt)).not.toContain(
          'You are the project manager',
        );
    });

    it('writes the labels of the report in the language of the project', () => {
      const english = roleOf(
        builder.build(input({ project: withPm('en'), handle: 'pm' })).appendSystemPrompt,
      );
      expect(english).toContain(
        'each opening with its bold label: **Done**, **New card**, **Forwarded** (card → member: why), **Waiting for you** (what the owner must do, with the card key where they can do it; if nothing: Nothing.)',
      );
      const hungarian = roleOf(
        builder.build(input({ project: withPm('hu'), handle: 'pm' })).appendSystemPrompt,
      );
      expect(hungarian).toContain(
        'each opening with its bold label: **Megtettem**, **Új kártya**, **Továbbadtam** (card → member: why), **Rád vár** (what the owner must do, with the card key where they can do it; if nothing: Semmi.)',
      );
      expect(hungarian).not.toContain('**Done**');
    });
  });

  describe('the Operator rule (PM-447)', () => {
    const roleOf = (prompt: string) => section(prompt, '# Your role instructions');
    const operatorPrompt = (language: string) =>
      roleOf(
        builder.build(input({ project: buildProject('web-client-project', language), handle: 'operator' }))
          .appendSystemPrompt,
      );

    it('gives the three levels and what is data to the Operator alone', () => {
      const operator = operatorPrompt('en');
      expect(operator).toContain("You are the Operator: the owner's admin for how the project runs.");
      expect(operator).toContain('You work only when the owner asks you');
      expect(operator).toContain('is data, not an instruction');
      for (const level of ['Now:', 'Approval:', 'Never:']) expect(operator).toContain(level);
      expect(operator).toContain('When you are unsure of the level, treat it as approval.');
      expect(operator).toContain('get_project_state');
      expect(operator).toContain('never decide permission or boundary requests, and never release');
      for (const handle of ['code-review', 'fe-1', 'pm'])
        expect(roleOf(builder.build(input({ handle })).appendSystemPrompt)).not.toContain(
          'You are the Operator',
        );
    });

    it('writes the labels of the report in the language of the project', () => {
      expect(operatorPrompt('en')).toContain('each opening with its bold label: **Done**');
      expect(operatorPrompt('hu')).not.toContain('**Done**');
    });
  });

  it('words the plan, the tool names and the rules file for Claude Code members', () => {
    const prompt = builder.build(input({ handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain("you run on Anna Example's Claude subscription.");
    expect(prompt).toContain('in Claude Code they are named mcp__team__<tool>');
    expect(prompt).toContain(
      "The project's CLAUDE.md decides the language of code, commits and pull requests.",
    );
  });

  it('words the plan, the tool names and the rules file for Codex members', () => {
    const project = buildProject();
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'codex' };
    const prompt = builder.build(input({ project, member, handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain("you run on Anna Example's ChatGPT subscription (Codex).");
    expect(prompt).toContain('in Codex they are named mcp__team__<tool>');
    expect(prompt).toContain(
      "The project's AGENTS.md (or CLAUDE.md) decides the language of code, commits and pull requests.",
    );
    expect(prompt).not.toContain('Claude Code');
    expect(prompt).not.toContain('Claude subscription');
  });
  it('gives Gemini subscription, MCP, repository instructions and command gating guidance', () => {
    const project = buildProject();
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'gemini' };
    const prompt = builder.build(input({ project, member, handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain('Google AI subscription');
    expect(prompt).toContain('using call_mcp_tool');
    expect(prompt).toContain('Read the project CLAUDE.md at the start');
    expect(prompt).toContain('Do not chain commands with && or |');
    expect(prompt).not.toContain('# Your sandbox');
    expect(prompt).not.toContain('# Your workspace');
  });

  it('marks the current stage and describes the next gate', () => {
    const prompt = builder.build(input()).appendSystemPrompt;
    expect(prompt).toContain(
      '3. Code review (`code_review`, step: code review) — owners `code-review` ← current stage',
    );
    expect(prompt).toContain(
      '- Next stage: Integration (`integration`), owners `devops`; gate: label `code-review-ok` (Code review ok).',
    );
    expect(prompt).toContain(
      '7. Merge (`merge`, step: final decision) — owners `owner` — gate: label `client-accepted` (Client accepted) and label `merge-approved` (Merge approved), a human approval',
    );
  });

  it('lists the labels with who may set them and their rules', () => {
    const labels = section(builder.build(input()).appendSystemPrompt, '# Labels').split('\n');
    const rules = (id: string) =>
      labels.find((line) => line.startsWith(`- \`${id}\``))?.replace(/^.*\(/, '(');
    expect(rules('code-review-changes')).toBe(
      '(set by `code-review`; one of group `code-review`; needs a note; not on your own work)',
    );
    expect(rules('client-accepted')).toBe(
      '(set by `owner`, `qa`, `communication`; one of group `client-test`)',
    );
    expect(rules('release-approved')).toBe('(only humans set it: `owner`; never set it yourself)');
    expect(rules('waiting-answer')).toBe('(set by anyone; holds the task back while on it)');
  });

  it('leaves the labels section out when the project defines no labels', () => {
    const project = buildProject();
    project.pipeline.labels = [];
    expect(builder.build(input({ project })).appendSystemPrompt).not.toContain('\n# Labels\n');
  });

  it('tells the member whether it owns the current stage', () => {
    expect(builder.build(input()).appendSystemPrompt).toContain(
      '- Stage: Code review (`code_review`), owners `code-review`; you own this stage.',
    );
    expect(builder.build(input({ handle: 'devops' })).appendSystemPrompt).toContain(
      'you do not own this stage',
    );
  });

  it('keeps the guardrails for every member', () => {
    for (const handle of ['fe-1', 'qa', 'devops', 'communication']) {
      const prompt = builder.build(input({ handle })).appendSystemPrompt;
      expect(prompt).toContain('- Never approve a gate');
      expect(prompt).toContain('- Never release to production');
      expect(prompt).toContain('ask with ask_human instead of guessing');
      expect(prompt).toContain('- Never put secrets');
    }
    expect(builder.build(input({ handle: 'fe-1' })).appendSystemPrompt).not.toContain('You never edit code');
    expect(builder.build(input({ handle: 'code-review' })).appendSystemPrompt).toContain(
      '- You never edit code, commit or push: you only report.',
    );
  });

  it('leaves the guidance on writing questions to humans to the ask_human tool description (PM-181)', () => {
    for (const handle of ['fe-1', 'qa', 'devops', 'communication']) {
      const prompt = builder.build(input({ handle })).appendSystemPrompt;
      // One line in the guardrails; how to word the question lives in the tool description (mcp.test.ts).
      expect(prompt.split('ask_human instead of guessing').length - 1, handle).toBe(1);
      expect(prompt, handle).not.toContain('usually not a specialist');
      expect(prompt, handle).not.toContain('the details field');
    }
  });

  it('forbids self-review through the labels marked for it', () => {
    const project = buildProject();
    expect(section(builder.build(input({ project })).appendSystemPrompt, '# Team rules')).toContain(
      'Nobody approves their own work: never set',
    );
    project.pipeline.labels = project.pipeline.labels.map((label) => ({ ...label, notByAuthor: false }));
    expect(builder.build(input({ project })).appendSystemPrompt).not.toContain('not on your own work');
  });

  it('includes the role instructions from the configuration', () => {
    const project = buildProject();
    const member = { ...aiMember(project, 'qa'), instructions: 'Always test on a phone-sized screen too.' };
    const prompt = builder.build(input({ project, member, handle: 'qa' })).appendSystemPrompt;
    expect(prompt).toContain('\n\nAlways test on a phone-sized screen too.');
  });

  it('bounds the memory to the most recent entries', () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      formatMemoryEntry(new Date(Date.UTC(2026, 0, 1, 0, i)), `Learning ${i}: ${'x'.repeat(300)}`),
    ).join('');
    const prompt = builder.build(input({ memory: entries })).appendSystemPrompt;
    const memorySection = prompt.slice(prompt.indexOf('# Your memory'));
    expect(memorySection).toContain('(Older entries are not shown.)');
    expect(memorySection).toContain('Learning 59:');
    expect(memorySection).not.toContain('Learning 0:');
    const shown = memorySection.slice(memorySection.indexOf('## '));
    expect(shown.startsWith('## 2026-01-01T')).toBe(true);
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(MEMORY_LIMIT_BYTES);
  });

  it('says so when the memory is empty', () => {
    const prompt = builder.build(input({ memory: '  \n' })).appendSystemPrompt;
    expect(prompt).toContain('# Your memory\nNothing saved yet');
  });
});

describe('kick-off brief', () => {
  it('lists the attachments with the tools, and says how to get the rest of a long list', () => {
    const brief = (attachments?: Attachment[]) =>
      (builder.build(input({ attachments })).initialMessage ?? '')
        .split('\n\n')
        .find((part) => part.startsWith('## Attachments\n'));
    expect(brief()).toBe('## Attachments\nNone.');

    const one = brief([screenshot()]);
    expect(one).toContain(
      '- `att_screenshot01` "reset-mail.png" · image/png · 48.2 kB · by `owner`, 2026-09-27 09:15 UTC',
    );
    expect(one).toContain('Open one with read_attachment');
    expect(one).not.toContain('more; list them');

    const many = Array.from({ length: 13 }, (_, i) =>
      screenshot({ id: `att_screenshot${String(i).padStart(2, '0')}`, fileName: `shot-${i}.png` }),
    );
    const long = brief(many);
    expect(long).toContain('shot-9.png');
    expect(long).not.toContain('shot-10.png');
    expect(long).toContain('(3 more; list them with list_attachments, task_key AR-21, offset 10.)');
  });

  it("names the parent card's attachments and the task_key that reads them (PM-228)", () => {
    const attachmentsOf = (overrides: Partial<ContextPackInput>) =>
      (builder.build(input(overrides)).initialMessage ?? '')
        .split('\n\n')
        .find((part) => part.startsWith('## Attachments\n')) ?? '';
    const parentFiles = (count: number) => ({
      taskKey: 'AR-7',
      attachments: Array.from({ length: count }, (_, i) =>
        screenshot({ id: `att_parent${String(i).padStart(2, '0')}`, fileName: `parent-${i}.png` }),
      ),
    });

    // No parent files given (no parent, a parent without files, or one the member may not read): no line.
    expect(attachmentsOf({})).toBe('## Attachments\nNone.');

    const own = attachmentsOf({ parentAttachments: parentFiles(2) });
    expect(own).toContain('None.\nParent `AR-7` has 2 attachments:');
    expect(own).toContain('"parent-0.png"');
    expect(own).toContain('"parent-1.png"');
    expect(own).toContain('task_key AR-7');

    // Next to the task's own files, with the same limit for the long list.
    const both = attachmentsOf({ attachments: [screenshot()], parentAttachments: parentFiles(12) });
    expect(both).toContain('"reset-mail.png"');
    expect(both).toContain('Parent `AR-7` has 12 attachments:');
    expect(both).toContain('parent-9.png');
    expect(both).not.toContain('parent-10.png');
    expect(both).toContain('(2 more.)');
  });

  it("names the member's other running sessions on related cards, and where the standing is (PM-184)", async () => {
    const brief =
      builder.build(
        input({
          handle: 'fe-1',
          task: makeTask({ stageId: 'dev', parentKey: 'AR-20' }),
          relatedSessions: [
            { taskKey: 'AR-20', title: 'Booking flow rework', relation: 'parent', state: 'working' },
            { taskKey: 'AR-22', title: 'Mail template fixes', relation: 'prerequisite_of', state: 'idle' },
          ],
        }),
      ).initialMessage ?? '';
    const start = brief.indexOf('## Your other running sessions');
    const end = brief.indexOf('\n\n## ', start + 1);
    await expect(brief.slice(start, end)).toMatchFileSnapshot(
      '__snapshots__/developer-dev-related-sessions.section.txt',
    );
    // After the relations, before the attachments.
    expect(brief.indexOf('## Relations')).toBeLessThan(start);
    expect(start).toBeLessThan(brief.indexOf('## Attachments'));
  });

  it('has no section about other sessions when the member has none', () => {
    expect(builder.build(input()).initialMessage).not.toContain('Your other running sessions');
    expect(builder.build(input({ relatedSessions: [] })).initialMessage).not.toContain(
      'Your other running sessions',
    );
  });

  describe('the card’s thread: other workers and questions (PM-249)', () => {
    const workers: CardWorker[] = [
      {
        handle: 'designer',
        displayName: 'UI/UX designer',
        role: 'UI/UX designer',
        state: 'working',
        doing: { summary: 'The form layout is being drawn' },
      },
      { handle: 'fe-2', displayName: 'Fejlesztő', role: 'developer', state: 'idle' },
    ];
    const questions: CardQuestion[] = [
      {
        inboxItemId: 'inb_1',
        asker: 'analyst',
        question: 'Which export format?',
        askedAt: '2026-10-03T11:20:00.000Z',
        askedEventId: 'evt_q1',
        state: 'answered',
        answer: { by: 'owner', text: 'CSV', at: '2026-10-03T12:00:00.000Z', eventId: 'evt_a1' },
      },
      {
        inboxItemId: 'inb_2',
        asker: 'designer',
        question: 'Should the form keep its draft?',
        askedAt: '2026-10-03T11:54:00.000Z',
        askedEventId: 'evt_q2',
        state: 'open',
      },
    ];
    const workersBlock = [
      '## Also working on this card',
      '- `designer` (UI/UX designer, working): The form layout is being drawn',
      '- `fe-2` (developer, idle)',
      "Each of you works from your own conversation, and none sees another's. Split the work by send_message with the members it concerns, do not overwrite each other's part (the description above all), and send a message about coordinating to all of them.",
    ].join('\n');
    const questionsBlock = [
      '## Questions to people on this card',
      '- `analyst` asked (2026-10-03 11:20 UTC): "Which export format?" → `owner` answered: "CSV"',
      '- `designer` asked (2026-10-03 11:54 UTC): "Should the form keep its draft?" → open',
      'Before you ask a person, check here (and in get_task) that it was not answered and is not open already.',
    ].join('\n');

    it('puts both sections after the theme and before the attachments, only when they are not empty', () => {
      const brief =
        builder.build(input({ handle: 'fe-1', cardWorkers: workers, cardQuestions: questions }))
          .initialMessage ?? '';
      expect(brief).toContain(`\n\n${workersBlock}\n\n${questionsBlock}\n\n## Attachments`);
      expect(brief.indexOf('## Relations')).toBeLessThan(brief.indexOf('## Also working on this card'));
      const plain = builder.build(input({ handle: 'fe-1', cardWorkers: [], cardQuestions: [] }));
      for (const heading of ['## Also working on this card', '## Questions to people on this card'])
        expect(plain.initialMessage).not.toContain(heading);
      expect(plain.initialMessage).toBe(builder.build(input({ handle: 'fe-1' })).initialMessage);
    });

    it('says in the first line of `standing` where the card stands, and only when there is something to say', () => {
      const standing = builder.build(input({ cardWorkers: workers, cardQuestions: questions })).standing;
      expect(standing).toBe(`Now on AR-21:\n\n${workersBlock}\n\n${questionsBlock}`);
      expect(builder.build(input({ cardWorkers: workers })).standing).toBe(
        `Now on AR-21:\n\n${workersBlock}`,
      );
      expect(builder.build(input({ cardQuestions: questions })).standing).toBe(
        `Now on AR-21:\n\n${questionsBlock}`,
      );
      expect(builder.build(input()).standing).toBeNull();
      expect(builder.build(input({ cardWorkers: [], cardQuestions: [] })).standing).toBeNull();
      expect(
        builder.build(input({ workItem: { type: 'general' }, task: null, cardWorkers: workers })).standing,
      ).toBeNull();
    });

    it('cuts a long question and answer, and says how to read them whole', () => {
      const long: CardQuestion = {
        ...questions[0]!,
        question: `Q${'q'.repeat(300)}`,
        answer: {
          by: 'owner',
          text: `A${'a'.repeat(400)}`,
          at: '2026-10-03T12:00:00.000Z',
          eventId: 'evt_a1',
        },
      };
      const brief = builder.build(input({ cardQuestions: [long] })).initialMessage ?? '';
      expect(brief).toContain(
        `"Q${'q'.repeat(158)}… (read it whole: get_task task_key AR-21, event_id evt_q1)"`,
      );
      expect(brief).toContain(
        `"A${'a'.repeat(238)}… (read it whole: get_task task_key AR-21, event_id evt_a1)"`,
      );
      expect(brief).not.toContain('q'.repeat(160));
      // Without an event to read from, the cut says only that.
      const noEvent = builder.build(
        input({ cardQuestions: [{ ...long, askedEventId: null }] }),
      ).initialMessage;
      expect(noEvent).toContain(`"Q${'q'.repeat(158)}…" → `);
    });
  });

  it('keeps the brief compact', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      event(`2026-09-29T10:${String(i).padStart(2, '0')}:00.000Z`, 'fe-1', 'task_note', {
        text: `Note ${i} ${'y'.repeat(400)}`,
      }),
    );
    const brief = builder.build(input({ timeline: many })).initialMessage ?? '';
    expect(brief).toContain('(25 earlier events omitted)');
    expect(brief).toContain('Note 39');
    expect(brief).not.toContain('Note 24 ');
    const noteLine = brief.split('\n').find((l) => l.includes('Note 39')) ?? '';
    // The text is cut to 280 characters; the rest is the line's prefix and the cut hint (PM-191).
    expect(noteLine.length).toBeLessThan(440);
    expect(noteLine).toContain('read it whole: get_task task_key AR-21, event_id ');
  });

  it('names the labels of label changes in the timeline', () => {
    const changes = [
      event('2026-09-29T10:00:00.000Z', 'code-review', 'task_labels_changed', {
        added: ['code-review-changes'],
        removed: [],
      }),
      event('2026-09-29T11:00:00.000Z', null, 'task_labels_changed', {
        added: [],
        removed: ['code-review-changes', 'hotfix'],
        reason: 'moved_back',
      }),
    ];
    const brief = builder.build(input({ timeline: changes })).initialMessage ?? '';
    expect(brief).toContain(
      '- 2026-09-29 10:00 UTC · `code-review`: labels added: `code-review-changes` (Code review: changes needed)\n',
    );
    // A label without a definition is a plain tag: shown by its id.
    expect(brief).toContain(
      '- 2026-09-29 11:00 UTC · system: labels removed: `code-review-changes` (Code review: changes needed), `hotfix`',
    );
  });

  it('still shows check results recorded before labels replaced checks', () => {
    const legacy = event('2026-09-20T10:00:00.000Z', 'qa', 'task_check_changed', {
      check: 'qa',
      from: 'pending',
      to: 'failed',
    });
    const brief = builder.build(input({ timeline: [legacy] })).initialMessage ?? '';
    expect(brief).toContain('- 2026-09-20 10:00 UTC · `qa`: set the qa check to failed (was pending)');
  });

  it('leaves session and permission bookkeeping out of the timeline', () => {
    const brief = builder.build(input()).initialMessage ?? '';
    expect(brief).not.toContain('session_started');
    expect(brief).not.toContain('permission');
    expect(brief).toContain('- 2026-09-28 08:06 UTC · `fe-1`: moved it from Ready to Development');
  });

  it('does not repeat the steps of the system prompt', () => {
    const pack = builder.build(input());
    expect(pack.initialMessage).not.toContain('What is expected next');
    const firstStep = doneSteps(pack.appendSystemPrompt).split('\n')[0]!.replace(/^1\. /, '');
    expect(firstStep).toContain('Review the pull requests linked to the task');
    expect(pack.initialMessage).not.toContain(firstStep);
  });

  it('lists links apart from the relations to other cards', () => {
    const brief = builder.build(input()).initialMessage ?? '';
    expect(brief).toContain(
      [
        '## Links',
        '- Pull request: acme/app#123 "Fix room name in confirmation email" (open)',
        '- Branch: `AR-21-fix-the-booking-confirmation-email` in acme/app',
        '- Link: https://example.com/reports/42 "Client report"',
        '',
        '## Relations',
        'This card needs first (prerequisite):',
        '- `AR-19` "Update mail templates" · Stage: Done · Status: done',
      ].join('\n'),
    );
  });

  it('lists the relations by kind, both directions, and none when there are none (PM-192)', () => {
    const card = (key: string, kind: TaskRelation['kind'], stageId = 'dev') => ({
      kind,
      key,
      title: `Card ${key}`,
      stageId,
      status: 'active' as const,
    });
    const brief =
      builder.build(
        input({
          task: makeTask({
            links: [
              { kind: 'related', ref: 'AR-5' },
              { kind: 'duplicate_of', ref: 'AR-6' },
            ],
          }),
          relations: [
            card('AR-20', 'part_of'),
            card('AR-22', 'prerequisite_of'),
            card('AR-23', 'prerequisite_of'),
            card('AR-5', 'related'),
            card('AR-6', 'duplicate_of'),
          ],
        }),
      ).initialMessage ?? '';
    const start = brief.indexOf('## Relations');
    expect(brief.slice(start, brief.indexOf('\n\n## ', start))).toBe(
      [
        '## Relations',
        'This card is part of:',
        '- `AR-20` "Card AR-20" · Stage: Development · Status: active',
        'This card is the prerequisite of:',
        '- `AR-22` "Card AR-22" · Stage: Development · Status: active',
        '- `AR-23` "Card AR-23" · Stage: Development · Status: active',
        'This card is related to:',
        '- `AR-5` "Card AR-5" · Stage: Development · Status: active',
        'This card is a duplicate of:',
        '- `AR-6` "Card AR-6" · Stage: Development · Status: active',
      ].join('\n'),
    );
    // Links to cards are relations, not links.
    expect(brief).not.toContain('Related card:');
    expect(brief).not.toContain('Duplicate of:');
    const none = builder.build(input({ relations: [] })).initialMessage ?? '';
    expect(none).toContain('## Relations\nNone.');
    expect(none).not.toContain('## Prerequisites');
  });

  it('names the theme of the card after its relations, and has no section without one (PM-192)', () => {
    const theme = { key: 'AR-30', title: 'The epic', stageId: 'backlog', status: 'active' as const };
    const brief = builder.build(input({ relations: [], theme })).initialMessage ?? '';
    expect(brief).toContain('## Relations\nNone.\n\n## Theme\n`AR-30` "The epic" · Status: open');
    // A closed theme says so.
    expect(builder.build(input({ theme: { ...theme, status: 'cancelled' } })).initialMessage ?? '').toContain(
      '## Theme\n`AR-30` "The epic" · Status: closed',
    );
    // A card with no theme gets no section, so its brief does not grow (PM-181).
    expect(builder.build(input({})).initialMessage ?? '').not.toContain('## Theme');
  });

  it('lists the project focus and the place of the card, and has no section without one (PM-437)', () => {
    const items = [
      { position: 1, key: 'AR-30', title: 'The epic', kind: 'theme' as const },
      { position: 3, key: 'AR-12', title: 'Fix login', kind: 'task' as const },
    ];
    const header =
      '## Project focus\nWhat the team works on now, in this order. Urgent cards come first even outside it. Only people set it.\n1. AR-30 (theme) The epic\n3. AR-12 Fix login\n';
    const via = builder.build(input({ focus: { items, place: { position: 1, via: 'AR-30' } } }));
    expect(via.initialMessage ?? '').toContain(`${header}Your card is in the focus: place 1 (via AR-30).`);
    const itself = builder.build(input({ focus: { items, place: { position: 3 } } }));
    expect(itself.initialMessage ?? '').toContain(`${header}Your card is in the focus: place 3.`);
    const outside = builder.build(input({ focus: { items, place: null } }));
    expect(outside.initialMessage ?? '').toContain(`${header}Your card is not in the focus.`);
    expect(builder.build(input({})).initialMessage ?? '').not.toContain('## Project focus');
  });

  it('cuts very long descriptions', () => {
    const brief =
      builder.build(input({ task: makeTask({ description: 'z'.repeat(20_000) }) })).initialMessage ?? '';
    expect(brief).toContain('(The description continues; read it with get_task.)');
    expect(brief.length).toBeLessThan(14_000);
  });

  it('names the recommended developer only when the card has one (PM-347)', () => {
    const line = (task: Task) =>
      (builder.build(input({ task })).initialMessage ?? '')
        .split('\n')
        .find((l) => l.startsWith('- Recommended developer: '));
    expect(line(makeTask({}))).toBeUndefined();
    const set = {
      level: 'senior' as const,
      reason: 'the runner',
      setBy: 'arch',
      setAt: '2026-10-05T06:00:00Z',
    };
    expect(line(makeTask({ developerLevel: set }))).toBe('- Recommended developer: senior (the runner)');
    expect(line(makeTask({ developerLevel: { ...set, level: 'any', reason: null } }))).toBe(
      '- Recommended developer: any',
    );
  });

  describe('repository', () => {
    const briefLine = (project: ProjectConfig, repo: string | null) =>
      (builder.build(input({ project, task: makeTask({ repo }) })).initialMessage ?? '')
        .split('\n')
        .find((line) => line.startsWith('- Repo: '));
    const statusLine = (project: ProjectConfig, repo: string | null) =>
      builder
        .build(input({ project, task: makeTask({ repo }) }))
        .appendSystemPrompt.split('\n')
        .find((line) => line.startsWith('- Status: '));

    it("names the task's own repository", () => {
      for (const project of [buildProject(), buildProjectWithTwoRepos(), buildProjectWithoutRepos()])
        expect(briefLine(project, 'app'), String(project.project.repos.length)).toBe('- Repo: `app`');
      expect(statusLine(buildProjectWithTwoRepos(), 'api')).toBe(
        '- Status: active; assignee: `fe-1`; repo: `api`.',
      );
    });

    it('names the only repository of the project when the task has none of its own', () => {
      expect(briefLine(buildProject(), null)).toBe('- Repo: `app`');
      expect(statusLine(buildProject(), null)).toBe('- Status: active; assignee: `fe-1`; repo: `app`.');
    });

    it('says that none is chosen yet when the project has several', () => {
      const none =
        'none chosen yet (the project has several repositories; ask a human which one if you need to know)';
      expect(briefLine(buildProjectWithTwoRepos(), null)).toBe(`- Repo: ${none}`);
      expect(statusLine(buildProjectWithTwoRepos(), null)).toBe(
        `- Status: active; assignee: \`fe-1\`; repo: ${none}.`,
      );
    });

    it('names the workspace root when the project has no repository', () => {
      expect(briefLine(buildProjectWithoutRepos(), null)).toBe('- Repo: the workspace root');
      expect(statusLine(buildProjectWithoutRepos(), null)).toBe(
        '- Status: active; assignee: `fe-1`; repo: the workspace root.',
      );
    });
  });
});

describe('expected steps', () => {
  it.each(['developer', 'maintainer'])(
    'asks %s for targeted checks at hand-over and in fix rounds when merge owns the full test',
    (role) => {
      const project = buildProject();
      const handle = role === 'developer' ? 'fe-1' : 'maintainer';
      if (role === 'maintainer') {
        addMember(project, handle, role);
        (project.pipeline.stages.find((stage) => stage.id === 'dev')!.owners ??= []).push(handle);
      }
      project.project.repos[0]!.fullTestAtMerge = true;
      for (const stageId of ['dev', 'qa']) {
        const source = input({ project, handle, task: makeTask({ stageId, assignee: handle }) });
        const steps = doneSteps(builder.build(source).appendSystemPrompt);
        expect(steps).toContain('before hand-over and in fix rounds, run only the tests');
        expect(steps).toContain('the type check of the workspaces you touched');
        expect(steps).toContain('the integrator or merge step runs the full check once');
        expect(steps).not.toContain("run the project's full tests and type check once");
      }
    },
  );

  it('preserves the default steps when merge testing is explicitly disabled', () => {
    const project = buildProject();
    const task = makeTask({ stageId: 'dev', assignee: 'fe-1' });
    const original = doneSteps(builder.build(input({ project, task, handle: 'fe-1' })).appendSystemPrompt);
    project.project.repos[0]!.fullTestAtMerge = false;
    expect(doneSteps(builder.build(input({ project, task, handle: 'fe-1' })).appendSystemPrompt)).toBe(
      original,
    );
  });

  it('uses the task repository rather than another repository merge policy', () => {
    const project = buildProjectWithTwoRepos();
    project.project.repos.find((repo) => repo.name === 'app')!.fullTestAtMerge = true;
    for (const repo of project.project.repos) {
      const steps = doneSteps(
        builder.build(
          input({
            project,
            handle: 'fe-1',
            task: makeTask({ repo: repo.name, stageId: 'dev', assignee: 'fe-1' }),
          }),
        ).appendSystemPrompt,
      );
      expect(steps.includes('the integrator or merge step runs the full check once')).toBe(
        repo.name === 'app',
      );
    }
  });

  it('keeps the server review test first and falls back to merge testing when unavailable', () => {
    const project = buildProject();
    project.project.repos[0]!.fullTestAtMerge = true;
    project.project.repos[0]!.reviewTest = {
      command: 'custom-check --all',
      maxWorkers: 2,
      timeoutMinutes: 15,
    };
    const source = input({ project, handle: 'fe-1', task: makeTask({ stageId: 'dev', assignee: 'fe-1' }) });
    const server = doneSteps(builder.build({ ...source, serverFullTest: true }).appendSystemPrompt);
    expect(server).toContain('the server runs `custom-check --all` once');
    expect(server).not.toContain('the integrator or merge step');
    expect(doneSteps(builder.build(source).appendSystemPrompt)).toContain(
      'the integrator or merge step runs the full check once',
    );
  });

  it('asks reviewers for targeted tests only in merge mode without a server result', () => {
    const project = buildProject();
    project.project.repos[0]!.fullTestAtMerge = true;
    const task = makeTask({ stageId: 'code_review' });
    const source = input({ project, task, handle: 'code-review' });
    expect(doneSteps(builder.build(source).appendSystemPrompt)).toContain(
      'Run only targeted tests if needed for this review',
    );
    task.reviewPin = {
      commit: 'c1',
      branch: 'task/AR-1',
      pinnedAt: '2026-10-06T10:00:00Z',
      fullTest: { status: 'passed', at: '2026-10-06T10:01:00Z' },
    };
    expect(doneSteps(builder.build(source).appendSystemPrompt)).not.toContain(
      'Run only targeted tests if needed for this review',
    );
  });

  it.each(['developer', 'maintainer'])(
    'asks %s for targeted checks when the server runs the full test',
    (role) => {
      const project = buildProject();
      const handle = role === 'developer' ? 'fe-1' : 'maintainer';
      if (role === 'maintainer') {
        addMember(project, handle, role);
        (project.pipeline.stages.find((stage) => stage.id === 'dev')!.owners ??= []).push(handle);
      }
      project.project.repos[0]!.reviewTest = {
        command: 'custom-check --all',
        maxWorkers: 2,
        timeoutMinutes: 15,
      };
      const source = input({ project, handle, task: makeTask({ stageId: 'dev', assignee: handle }) });
      const steps = doneSteps(builder.build({ ...source, serverFullTest: true }).appendSystemPrompt);
      expect(steps).toContain('Install the dependencies only if they are missing');
      expect(steps).toContain(
        "run only the tests that cover your change (single test files, or your test runner's related or changed mode) and the type check of the parts you touched",
      );
      expect(steps).toContain(
        'Do not run the whole test suite: the server runs `custom-check --all` once on the commit you hand over, PTY tests included',
      );
      const fallback = doneSteps(builder.build(source).appendSystemPrompt);
      expect(fallback).toContain(
        "run the project's full tests and type check once, on the commit you hand over",
      );
      expect(fallback).not.toContain('Do not run the whole test suite');
    },
  );

  it('keeps code review steps unchanged by the server full test flag', () => {
    const source = input({ handle: 'code-review', task: makeTask({ stageId: 'code_review' }) });
    expect(doneSteps(builder.build({ ...source, serverFullTest: true }).appendSystemPrompt)).toBe(
      doneSteps(builder.build(source).appendSystemPrompt),
    );
  });

  const stepsOf = (overrides: Parameters<typeof input>[0]) =>
    doneSteps(builder.build(input(overrides)).appendSystemPrompt);

  it('asks a developer in the queue to start the work stage', () => {
    const steps = stepsOf({ handle: 'be-1', task: makeTask({ stageId: 'ready', assignee: 'be-1' }) });
    expect(steps).toContain('1. Move the task to Development (`dev`) with update_task as you start.');
    expect(steps).toContain(
      'Move the task to Code review (`code_review`) with update_task and hand over to `code-review`',
    );
  });

  it('mentions the worktree of the repository the task works in, the project’s only one included', () => {
    for (const repo of ['app', null]) {
      const steps = stepsOf({ handle: 'fe-1', task: makeTask({ stageId: 'dev', repo }) });
      expect(steps, String(repo)).toContain(
        "2. Install the dependencies only if they are missing from your working directory: they are often in place already. Implement the change in your working directory (the task's own worktree and branch). While you work, run the tests that cover your change; run the project's full tests and type check once, on the commit you hand over.",
      );
    }
  });

  it('does not mention a worktree when the task works in no repository', () => {
    // The project has no repository: its tasks work in the workspace root.
    const steps = stepsOf({
      project: buildProjectWithoutRepos(),
      handle: 'fe-1',
      task: makeTask({ stageId: 'dev', repo: null }),
    });
    expect(steps).toContain(
      "Implement the change in your working directory. While you work, run the tests that cover your change; run the project's full tests and type check once, on the commit you hand over.",
    );
  });

  it('sends feedback work back to the assignee', () => {
    const steps = stepsOf({ handle: 'fe-1', task: makeTask({ stageId: 'qa' }) });
    expect(steps).toContain('The task is past development (now in QA (`qa`)).');
  });

  it('tells a non-owner to do what was asked', () => {
    const steps = stepsOf({ handle: 'devops', task: makeTask({ stageId: 'code_review' }) });
    expect(steps).toContain('Do the deployment or operations work you were asked for');
  });

  it('has the reviewer move the task to done last, after the findings are sent (PM-190)', () => {
    const project = buildProject('small-team');
    delete project.pipeline.stages.find((s) => s.kind === 'done')!.gate;
    const steps = stepsOf({ project, handle: 'code-review' });
    expect(steps).toContain(
      'When the review passes, move the task to Done (`done`) with update_task as your very last step, after your messages and notes: once the task is done, its sessions stop.',
    );
    expect(steps.indexOf('Send "Blocking"')).toBeGreaterThan(-1);
    expect(steps.indexOf('Send "Blocking"')).toBeLessThan(steps.indexOf('When the review passes'));
  });

  it('requests an approval gate through update_task instead of approving', () => {
    const steps = stepsOf({ project: buildProject('small-team'), handle: 'code-review' });
    expect(steps).toContain(
      'When the review passes, request the move to Done (`done`) with update_task: it needs a human approval (`merge-approved` (Merge approved)), so the system opens a decision for `owner` and the task waits until they approve. Do not message them separately and never set that label yourself.',
    );
  });

  it('hands the client test draft to the human owners', () => {
    const steps = stepsOf({ handle: 'communication', task: makeTask({ stageId: 'client_test' }) });
    expect(steps).toContain('Hand the draft to a human with send_message');
    expect(steps).toContain('record the result with update_task as `client-accepted`');
  });

  it('has DevOps release exactly the approved change and tell the communication member', () => {
    const steps = stepsOf({
      handle: 'devops',
      task: makeTask({
        stageId: 'release',
        labels: ['code-review-ok', 'qa-ok', 'client-accepted', 'release-approved'],
      }),
    });
    expect(steps).toBe(
      [
        '1. The task passed its release gate: a human approved the release. Release exactly the approved change to production and verify it.',
        '2. If anything changed since the approval (new commits, another version), stop and ask with ask_human.',
        '3. Tell `communication` that the change is live.',
        '4. Move the task to Done (`done`) with update_task as your very last step, after your messages and notes: once the task is done, its sessions stop.',
      ].join('\n'),
    );
  });

  it('names the built-in designer role UI/UX designer in the system prompt', () => {
    const project = buildProject();
    const member = addMember(project, 'member', 'designer', { displayName: 'Member' });
    (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push(member.handle);
    const pack = builder.build(
      input({ project, handle: 'member', task: makeTask({ stageId: 'dev', assignee: 'member' }) }),
    );
    expect(roleLabel('designer')).toBe('UI/UX designer');
    expect(pack.appendSystemPrompt).toContain('the UI/UX designer of the Acme Web team');
  });

  it.each(AI_BUILT_IN_ROLE_IDS)('gives the %s concrete steps with the team tools', (role) => {
    const project = buildProject();
    const member = addMember(project, 'member', role, { displayName: 'Member' });
    (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push(member.handle);
    const pack = builder.build(
      input({ project, handle: 'member', task: makeTask({ stageId: 'dev', assignee: 'member' }) }),
    );
    expect(pack.appendSystemPrompt).toContain(`the ${roleLabel(role)} of the Acme Web team`);
    expect(doneSteps(pack.appendSystemPrompt)).toMatch(
      /send_message|update_task|ask_human|create_task|get_task|link_pull_request/,
    );
  });

  it('has the analyst, the architect and support leave queued work for the product owner to prioritise', () => {
    for (const [role, step] of [
      ['business_analyst', 'Rewrite the description with update_task'],
      ['architect', 'Add the technical plan to the description with update_task'],
      ['support', 'Complete the description with update_task'],
    ] as const) {
      const project = buildProject();
      addMember(project, 'member', role);
      const steps = stepsOf({
        project,
        handle: 'member',
        task: makeTask({ stageId: 'ready', assignee: null }),
      });
      expect(steps, role).toContain(step);
      expect(steps, role).toContain(
        'Tell `owner` with send_message that the task is ready to be prioritised; leave it in Ready (`ready`).',
      );
    }
  });

  it('builds maintenance work in the task worktree and hands it over', () => {
    const project = buildProject();
    addMember(project, 'maintainer', 'maintainer');
    (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push('maintainer');
    const steps = stepsOf({
      project,
      handle: 'maintainer',
      task: makeTask({ stageId: 'dev', assignee: 'maintainer' }),
    });
    expect(steps).toContain(
      "1. Install the dependencies only if they are missing from your working directory: they are often in place already. Make the maintenance change the task describes in your working directory (the task's own worktree and branch), small and focused. While you work, run the tests that cover your change; run the project's full tests and type check once, on the commit you hand over.",
    );
    expect(steps).toContain('2. Commit, push, open a pull request and attach it with link_pull_request.');
    expect(steps).toContain(
      '3. Move the task to Code review (`code_review`) with update_task and hand over to `code-review`',
    );
  });

  it('has the watchdog flag problems to the operator, and the project manager ask the product owner', () => {
    const project = buildProject();
    addMember(project, 'watchdog', 'watchdog');
    addMember(project, 'pm', 'project_manager');
    const owner = project.team.members[0]!;
    if (owner.kind === 'human') owner.roles = ['product_owner'];
    project.team.members.push({
      kind: 'human',
      handle: 'ops',
      displayName: 'Ops',
      access: 'admin',
      roles: ['operator'],
    });

    const watchdog = stepsOf({ project, handle: 'watchdog' });
    expect(watchdog).toContain('Flag anything wrong to `ops` with send_message');
    expect(watchdog).toContain('do not intervene');
    const pm = builder.build(input({ project, handle: 'pm' })).appendSystemPrompt;
    expect(doneSteps(pm)).toContain('ask `owner` with ask_human; do not reorder the work yourself');
    expect(pm).toContain('- `ops`: Ops (human, admin; roles: owner)');
  });
});

describe('steps by duty', () => {
  function customRole(id: string, duties: DutyId[], holders: 'human' | 'ai' | 'both' = 'both') {
    return { id, name: id, summary: `The ${id}.`, notTheirJob: '', holders, duties, instructions: '' };
  }

  it('finds prioritisers, monitors and client communicators by duty through overrides and custom roles', () => {
    const project = buildProject();
    project.team.roles.push(
      customRole('backlog_keeper', ['prioritization', 'monitoring'], 'human'),
      customRole('client_liaison', ['client_communication']),
    );
    // The owner keeps the operator and product owner roles, but neither holds these duties any more.
    project.team.roleOverrides = {
      product_owner: { duties: ['requirements_analysis', 'final_decision'], instructions: '' },
      operator: { duties: ['final_decision', 'release_approval'], instructions: '' },
      communication: { duties: ['support'], instructions: '' },
    };
    project.team.members.push({
      kind: 'human',
      handle: 'pat',
      displayName: 'Pat',
      access: 'admin',
      roles: ['backlog_keeper'],
    });
    addMember(project, 'liaison', 'client_liaison');
    addMember(project, 'analyst', 'business_analyst');
    addMember(project, 'watchdog', 'watchdog');
    addMember(project, 'pm', 'project_manager');

    const steps = (handle: string, task: Task = makeTask()) =>
      doneSteps(builder.build(input({ project, handle, task })).appendSystemPrompt);

    expect(steps('analyst', makeTask({ stageId: 'ready', assignee: null }))).toContain(
      'Tell `pat` with send_message that the task is ready to be prioritised',
    );
    expect(steps('pm')).toContain('ask `pat` with ask_human; do not reorder the work yourself');
    expect(steps('watchdog')).toContain('Flag anything wrong to `pat` with send_message');
    const release = steps('devops', makeTask({ stageId: 'release', labels: ['release-approved'] }));
    expect(release).toContain('Tell `liaison` that the change is live.');
    expect(release).not.toContain('`communication`');
  });

  it('falls back to the project owners when nobody holds the duty', () => {
    const project = buildProject();
    project.team.roleOverrides = {
      product_owner: { duties: ['requirements_analysis', 'final_decision'], instructions: '' },
    };
    addMember(project, 'analyst', 'business_analyst');
    const prompt = builder.build(
      input({ project, handle: 'analyst', task: makeTask({ stageId: 'ready', assignee: null }) }),
    ).appendSystemPrompt;
    expect(doneSteps(prompt)).toContain(
      'Tell `owner` with send_message that the task is ready to be prioritised',
    );
  });

  it('uses the steps of a duty with steps whatever order the role bundle lists its duties in', () => {
    const project = buildProject();
    project.team.roles.push(customRole('builder', ['triage', 'implementation']));
    addMember(project, 'builder-1', 'builder');
    // In the queue (a prioritisation stage) the member's own duties decide, not the first one listed.
    const prompt = builder.build(
      input({ project, handle: 'builder-1', task: makeTask({ stageId: 'ready', assignee: 'builder-1' }) }),
    ).appendSystemPrompt;
    const steps = doneSteps(prompt);
    expect(steps).toContain('1. Move the task to Development (`dev`) with update_task as you start.');
    expect(steps).toContain("Implement the change in your working directory (the task's own worktree");
  });

  it('follows the duty of the current stage when the member holds it', () => {
    const project = buildProject();
    // DevOps also monitors: at a monitoring stage it gets the monitoring steps, not the deployment ones.
    project.pipeline.stages.find((s) => s.id === 'integration')!.duty = 'monitoring';
    const prompt = builder.build(
      input({ project, handle: 'devops', task: makeTask({ stageId: 'integration' }) }),
    ).appendSystemPrompt;
    expect(doneSteps(prompt)).toContain("Check the task's progress with get_task");
  });

  it('describes a custom role with its own texts and falls back to generic steps', () => {
    const project = buildProject();
    project.team.roles.push(dataSteward);
    addMember(project, 'steward', 'data_steward', { displayName: 'Dora' });
    const prompt = builder.build(input({ project, handle: 'steward' })).appendSystemPrompt;
    expect(prompt).toContain('You are Dora (handle `steward`), the Data steward of the Acme Web team');
    expect(prompt).toContain('- `steward`: Dora (AI, Data steward) ← you');
    expect(prompt).toContain(dataSteward.instructions);
    expect(prompt).not.toContain(DUTIES.research.prompt);
    // A custom role owns no stage here: it reports back to whoever asked.
    expect(prompt).toContain('you do not own this stage');
    expect(doneSteps(prompt)).toContain('1. You do not own the current stage (Code review (`code_review`)');
  });
});

describe('refinement steps (PM-256)', () => {
  /**
   * A project whose gate in front of Development asks for `scope-ok` (the responsible's decision) and,
   * on the cards that carry the label that calls for it, one step more each: analysis, design, plan.
   */
  function refiningProject() {
    const project = buildProject();
    project.pipeline.labels.push(
      { id: 'refine', name: 'Refine', setBy: { duties: ['prioritization', 'task_breakdown'] } },
      {
        id: 'needs-analysis',
        name: 'Needs analysis',
        meaning: 'The request is unclear',
        setBy: { duties: ['task_breakdown'] },
      },
      { id: 'ui', name: 'UI', meaning: 'A screen changes', setBy: 'anyone' },
      {
        id: 'needs-plan',
        name: 'Needs plan',
        meaning: 'The change touches several parts',
        setBy: { duties: ['task_breakdown'] },
      },
      { id: 'scope-ok', name: 'Scope decided', setBy: { duties: ['task_breakdown'] } },
      { id: 'analysis-ok', name: 'Analysis ready', setBy: { duties: ['requirements_analysis'] } },
      { id: 'design-ok', name: 'Design ready', setBy: { duties: ['ux_design'] } },
      { id: 'plan-ok', name: 'Plan ready', setBy: { duties: ['technical_direction'] } },
    );
    const ready = project.pipeline.stages.find((s) => s.id === 'ready')!;
    ready.gate = {
      conditions: [
        { type: 'has_label', label: 'scope-ok' },
        { type: 'has_label', label: 'analysis-ok', when: 'needs-analysis' },
        { type: 'has_label', label: 'design-ok', when: 'ui' },
        { type: 'has_label', label: 'plan-ok', when: 'needs-plan' },
      ],
    };
    addMember(project, 'analyst', 'business_analyst');
    addMember(project, 'arch', 'architect');
    addMember(project, 'ux', 'designer');
    return project;
  }
  const cardWith = (...labels: string[]) =>
    makeTask({ stageId: 'ready', assignee: null, labels: ['refine', ...labels] });
  const stepsOf = (handle: string, task: Task, project = refiningProject()) =>
    doneSteps(builder.build(input({ project, handle, task })).appendSystemPrompt);
  const PRIORITISE = 'ready to be prioritised';

  it('gives the responsible the decision of the steps, with the labels and their meaning', () => {
    const steps = stepsOf('arch', cardWith());
    expect(steps).toContain('1. Read the card with get_task.');
    expect(steps).toContain(
      '`needs-analysis` (Needs analysis): The request is unclear; `ui` (UI): A screen changes; `needs-plan` (Needs plan): The change touches several parts',
    );
    expect(steps).toContain(
      'add the labels you chose and `scope-ok` (Scope decided) in one update_task call (add_labels), with your reasons as the note. A small card needs only `scope-ok` (Scope decided).',
    );
    expect(steps).toContain('Do not start the other steps');
    expect(steps).not.toContain('Rewrite the description');
  });

  it('leaves out of the decision the steps already called for', () => {
    const steps = stepsOf('arch', cardWith('ui'));
    expect(steps).toContain('`needs-analysis` (Needs analysis): The request is unclear; `needs-plan`');
    expect(steps).not.toContain('`ui` (UI): A screen changes');
  });

  it('gives the member on turn the step of its own duty when the label is set by named members', () => {
    const project = refiningProject();
    project.pipeline.labels.find((l) => l.id === 'design-ok')!.setBy = { members: ['ux'] };
    const steps = stepsOf('ux', cardWith('ui', 'scope-ok'), project);
    expect(steps).toContain('Write a short plan into the description with update_task');
    expect(steps).toContain('add label `design-ok` (Design ready) with update_task');
    expect(steps).not.toContain('now comes the step of');
  });

  it('offers the responsible only the labels it may set, and sends the rest to a person', () => {
    const project = refiningProject();
    project.pipeline.labels.find((l) => l.id === 'ui')!.setBy = { members: ['owner'] };
    const steps = stepsOf('arch', cardWith(), project);
    expect(steps).toContain('`needs-analysis` (Needs analysis): The request is unclear; `needs-plan`');
    expect(steps).toContain(
      'You may not set these labels yourself: `ui` (UI): A screen changes. If the card needs that step, ask a person with ask_human',
    );
    expect(steps).not.toContain('by the labels that call for them: `ui`');
  });

  it('names nobody when no one can set the label of the turn', () => {
    const project = refiningProject();
    project.pipeline.labels.find((l) => l.id === 'scope-ok')!.setBy = { members: [] };
    const task = cardWith();
    expect(stepsOf('arch', task, project)).toContain('now comes the step of nobody who could set it.');
    const brief = builder.build(input({ project, handle: 'arch', task })).initialMessage ?? '';
    expect(brief).toContain('- On turn: nobody who could set it, for');
  });

  it('gives the analyst the requirements steps, even though the analyst also holds task breakdown', () => {
    const steps = stepsOf('analyst', cardWith('needs-analysis', 'scope-ok'));
    expect(steps).toContain('Rewrite the description with update_task');
    expect(steps).toContain('add label `analysis-ok` (Analysis ready) with update_task');
    expect(steps).not.toContain('Do not start the other steps');
  });

  it('gives the designer the plan steps and the architect the technical plan', () => {
    const design = stepsOf('ux', cardWith('ui', 'scope-ok'));
    expect(design).toContain('Write a short plan into the description with update_task');
    expect(design).toContain('add label `design-ok` (Design ready) with update_task');
    const plan = stepsOf('arch', cardWith('needs-plan', 'scope-ok'));
    expect(plan).toContain('Add the technical plan to the description with update_task');
    expect(plan).toContain('add label `plan-ok` (Plan ready) with update_task');
  });

  it('sets the label only when the questions are answered, writes to nobody and never asks for priority', () => {
    for (const [handle, labels] of [
      ['arch', []],
      ['analyst', ['needs-analysis', 'scope-ok']],
      ['ux', ['ui', 'scope-ok']],
      ['arch', ['needs-plan', 'scope-ok']],
    ] as const) {
      const steps = stepsOf(handle, cardWith(...labels));
      expect(steps, handle).toContain('answers to your questions have come in');
      expect(steps, handle).toContain('While a question is open, end your turn without the label.');
      expect(steps, handle).toContain('Write about the card to no other member');
      expect(steps, handle).toContain('ask_human');
      expect(steps, handle).not.toContain(PRIORITISE);
      expect(steps, handle).not.toContain('send_message');
    }
  });

  it('tells a member who is not on turn whose step comes, and to write to nobody', () => {
    const steps = stepsOf('ux', cardWith());
    expect(steps).toContain(
      'The card is being worked out before development, now comes the step of `analyst`, `arch`. Do what you were asked, and write to no other member about the card.',
    );
    expect(steps).not.toContain('Write a short plan');
  });

  it('says so when the card is held back or every step is done', () => {
    expect(stepsOf('arch', cardWith('waiting-answer'))).toContain('is held back now (`waiting-answer`');
    expect(stepsOf('arch', cardWith('scope-ok'))).toContain('every step is done now');
  });

  it('keeps the steps unchanged outside refinement', () => {
    const project = refiningProject();
    const plain = makeTask({ stageId: 'ready', assignee: null, labels: [] });
    expect(stepsOf('analyst', plain, project)).toContain(PRIORITISE);
    expect(stepsOf('analyst', plain, project)).toContain('Rewrite the description with update_task');
    expect(stepsOf('arch', plain, project)).toContain('Add the technical plan to the description');
    expect(stepsOf('arch', plain, project)).not.toContain('Do not start the other steps');
  });

  it('shows the state of the working out in the opening message, and nothing outside it', () => {
    const project = refiningProject();
    const brief = (task: Task) => builder.build(input({ project, handle: 'ux', task })).initialMessage ?? '';
    const refining = brief(cardWith('ui', 'needs-analysis', 'scope-ok'));
    expect(refining).toContain('## Refinement');
    expect(refining).toContain(
      '- Steps needed: `scope-ok` (Scope decided) (done), `analysis-ok` (Analysis ready) (to do), `design-ok` (Design ready) (to do)',
    );
    expect(refining).toContain('- On turn: `analyst`, for `analysis-ok` (Analysis ready)');
    expect(brief(makeTask({ stageId: 'ready', labels: [] }))).not.toContain('## Refinement');
  });
});

describe('the designer round on a UI card (PM-235)', () => {
  /** A project where a UI card needs the designer's plan to start and the designer's review to leave dev. */
  function uiProject() {
    const project = buildProject();
    project.pipeline.labels.push(
      { id: 'ui', name: 'UI', setBy: 'anyone' },
      { id: 'design-ok', name: 'Design plan ready', setBy: { duties: ['ux_design'] } },
      {
        id: 'design-review-ok',
        name: 'Design review ok',
        setBy: { duties: ['ux_design'] },
        notByAuthor: true,
        clearedWhen: ['moved_back'],
      },
    );
    const gate = (stageId: string, label: string) => {
      const stage = project.pipeline.stages.find((s) => s.id === stageId)!;
      stage.gate = {
        conditions: [...(stage.gate?.conditions ?? []), { type: 'has_label', label, when: 'ui' }],
      };
    };
    gate('dev', 'design-ok');
    gate('code_review', 'design-review-ok');
    addMember(project, 'ux', 'designer');
    return project;
  }
  const stepsOf = (overrides: Parameters<typeof input>[0]) =>
    doneSteps(builder.build(input(overrides)).appendSystemPrompt);

  it('has the designer write a plan on a queued card and neither move nor commit', async () => {
    const steps = stepsOf({
      project: uiProject(),
      handle: 'ux',
      task: makeTask({ stageId: 'ready', assignee: null, labels: ['ui'] }),
    });
    await expect(`${steps}\n`).toMatchFileSnapshot('__snapshots__/designer-ready-ui.steps.txt');
    expect(steps).not.toContain('Move the task to');
    expect(steps).not.toContain('Commit');
  });

  it('has the designer set design-ok when the gate of the stage the card is in asks for it (PM-248)', () => {
    const project = uiProject();
    const ready = project.pipeline.stages.find((s) => s.id === 'ready')!;
    ready.gate = { conditions: [{ type: 'has_label', label: 'design-ok', when: 'ui' }] };
    project.pipeline.stages.find((s) => s.id === 'dev')!.gate = undefined;
    const steps = stepsOf({
      project,
      handle: 'ux',
      task: makeTask({ stageId: 'ready', assignee: null, labels: ['ui'] }),
    });
    expect(steps).toContain('`design-ok`');
    expect(steps).toContain('only you may set it');
  });

  it('has the designer review once in development and write nothing there', async () => {
    const steps = stepsOf({
      project: uiProject(),
      handle: 'ux',
      task: makeTask({ stageId: 'dev', assignee: 'fe-1', labels: ['ui', 'design-ok'] }),
    });
    await expect(`${steps}\n`).toMatchFileSnapshot('__snapshots__/designer-dev-ui.steps.txt');
    expect(steps).not.toContain('Move the task to');
  });

  it('has the designer add design-review-changes with a note when the project has the label (PM-262)', () => {
    const project = uiProject();
    const task = makeTask({ stageId: 'dev', assignee: 'fe-1', labels: ['ui', 'design-ok'] });
    expect(stepsOf({ project, handle: 'ux', task })).not.toContain('design-review-changes');
    project.pipeline.labels.push({
      id: 'design-review-changes',
      name: 'Design review: changes',
      setBy: { duties: ['ux_design'] },
      requiresComment: true,
    });
    const steps = stepsOf({ project, handle: 'ux', task });
    expect(steps).toContain('`design-review-changes`');
    expect(steps).toContain('with update_task and a note');
  });

  it('keeps the building steps for a card the designer is assigned to', () => {
    const steps = stepsOf({
      project: uiProject(),
      handle: 'ux',
      task: makeTask({ stageId: 'ready', assignee: 'ux', labels: ['ui'] }),
    });
    expect(steps).toContain('Move the task to Development (`dev`) with update_task as you start.');
    expect(steps).toContain('Create the designs or mockups the task asks for');
  });

  it('has the developer get the designer review before handing over a UI card', async () => {
    const steps = stepsOf({
      project: uiProject(),
      handle: 'fe-1',
      task: makeTask({ stageId: 'dev', assignee: 'fe-1', labels: ['ui', 'design-ok'] }),
    });
    await expect(`${steps}\n`).toMatchFileSnapshot('__snapshots__/developer-dev-ui.steps.txt');
    expect(steps).toContain('which `ux` set instead of you');
  });

  it('leaves the designer review out for a card that is not a UI card or already has it', () => {
    const base = { project: uiProject(), handle: 'fe-1' } as const;
    for (const labels of [['bug'], ['ui', 'design-ok', 'design-review-ok']]) {
      const steps = stepsOf({ ...base, task: makeTask({ stageId: 'dev', assignee: 'fe-1', labels }) });
      expect(steps, labels.join()).not.toContain('instead of you');
    }
  });

  it('does not count a conditional approval as an approval every card needs at the hand-over', () => {
    const project = uiProject();
    project.pipeline.labels.push({
      id: 'ui-approved',
      name: 'UI approved',
      setBy: { members: ['owner'], humansOnly: true },
    });
    const stage = project.pipeline.stages.find((s) => s.id === 'code_review')!;
    stage.gate!.conditions.push({ type: 'has_label', label: 'ui-approved', when: 'ui' });
    const steps = stepsOf({
      project,
      handle: 'fe-1',
      task: makeTask({ stageId: 'dev', assignee: 'fe-1', labels: ['bug'] }),
    });
    expect(steps).not.toContain('human approval');
    expect(steps).toContain('Move the task to Code review (`code_review`) with update_task and hand over');
  });

  it('names the condition in the gate text of the prompt', () => {
    const prompt = builder.build(
      input({
        project: uiProject(),
        handle: 'fe-1',
        task: makeTask({ stageId: 'ready', assignee: 'fe-1', labels: ['ui'] }),
      }),
    ).appendSystemPrompt;
    expect(prompt).toContain('label `design-ok` (Design plan ready), only on cards with label `ui` (UI)');
  });
});

describe('duty prompt composition', () => {
  it('orders duty fragments, role extra responsibilities and member instructions for overridden and custom bundles', () => {
    const project = buildProject();
    project.team.roleOverrides = {
      developer: { duties: ['docs', 'research'], instructions: 'Explain the examples.' },
    };
    const member = { ...aiMember(project, 'fe-1'), instructions: 'Use small examples.' };
    const prompt = builder
      .build(input({ project, member, handle: 'fe-1' }))
      .appendSystemPrompt.split('# Your role instructions')[1]!;
    expect(prompt.indexOf(DUTIES.docs.prompt)).toBeGreaterThan(-1);
    expect(prompt.indexOf(DUTIES.docs.prompt)).toBeLessThan(prompt.indexOf(DUTIES.research.prompt));
    expect(prompt.indexOf(DUTIES.research.prompt)).toBeLessThan(prompt.indexOf('Explain the examples.'));
    expect(prompt.indexOf('Explain the examples.')).toBeLessThan(prompt.indexOf('Use small examples.'));
    expect(prompt).not.toContain(DUTIES.implementation.prompt);
    project.team.roles.push({
      id: 'example_writer',
      name: 'Example writer',
      summary: 'Writes examples.',
      notTheirJob: '',
      holders: 'both',
      duties: ['docs'],
      instructions: 'Keep a glossary.',
    });
    const custom = builder.build(
      input({ project, member: { ...member, role: 'example_writer' }, handle: 'fe-1' }),
    ).appendSystemPrompt;
    expect(custom).toContain(DUTIES.docs.prompt);
    expect(custom).toContain('Keep a glossary.');
  });
});

/**
 * A repository without a `github` block is local-only (PM-67): nothing goes to GitHub, so the
 * developer commits on the task's branch and hands the branch over, the reviewer reads it against the
 * default branch, and the owner merges. Repositories on GitHub keep the pull request wording.
 */
describe('repositories without GitHub', () => {
  const localTask = (overrides: Partial<Task> = {}) =>
    makeTask({ links: [{ kind: 'branch', ref: 'AR-21-fix-the-booking-confirmation-email' }], ...overrides });
  const stepsOf = (overrides: Parameters<typeof input>[0]) =>
    doneSteps(builder.build(input(overrides)).appendSystemPrompt);
  const roleInstructions = (overrides: Parameters<typeof input>[0]) =>
    section(builder.build(input(overrides)).appendSystemPrompt, '# Your role instructions');

  describe('developer', () => {
    it('commits on the task branch, never pushes, and hands over the branch and its last commit', () => {
      const steps = stepsOf({
        project: buildLocalOnlyProject(),
        handle: 'fe-1',
        task: localTask({ stageId: 'dev' }),
      });
      expect(steps).toBe(
        [
          '1. Read the task, its links and relations to other cards; ask with ask_human if the goal or a decision is unclear.',
          "2. Install the dependencies only if they are missing from your working directory: they are often in place already. Implement the change in your working directory (the task's own worktree and branch). While you work, run the tests that cover your change; run the project's full tests and type check once, on the commit you hand over.",
          "3. Commit the work on the task's own branch in your worktree. Never push and never open a pull request: the repository is local-only (the owner has not allowed publishing from it). Before you hand over, make sure everything is committed: `git status` shows nothing left to commit.",
          '4. Move the task to Code review (`code_review`) with update_task and hand over to `code-review` with send_message: the facts they need (the branch and its last commit, what changed, what to check).',
        ].join('\n'),
      );
    });

    it('opens and links a pull request when the repository is on GitHub', () => {
      const steps = stepsOf({ handle: 'fe-1', task: makeTask({ stageId: 'dev' }) });
      expect(steps).toBe(
        [
          '1. Read the task, its links and relations to other cards; ask with ask_human if the goal or a decision is unclear.',
          "2. Install the dependencies only if they are missing from your working directory: they are often in place already. Implement the change in your working directory (the task's own worktree and branch). While you work, run the tests that cover your change; run the project's full tests and type check once, on the commit you hand over.",
          '3. Commit, push, open a pull request and attach it with link_pull_request.',
          '4. Move the task to Code review (`code_review`) with update_task and hand over to `code-review` with send_message: the facts they need (links, what changed, what to check).',
        ].join('\n'),
      );
    });

    it('works the same way when it starts a task from the queue', () => {
      const steps = stepsOf({
        project: buildLocalOnlyProject(),
        handle: 'be-1',
        task: localTask({ stageId: 'ready', assignee: 'be-1' }),
      }).split('\n');
      expect(steps).toHaveLength(5);
      expect(steps[0]).toBe('1. Move the task to Development (`dev`) with update_task as you start.');
      expect(steps[3]).toContain("4. Commit the work on the task's own branch in your worktree. Never push");
      expect(steps[4]).toContain(
        '5. Move the task to Code review (`code_review`) with update_task and hand over to `code-review`',
      );
      expect(steps[4]).toContain('(the branch and its last commit, what changed, what to check)');
    });

    it('keeps the pull request out of every duty that changes files', () => {
      for (const role of ['maintainer', 'docs', 'content', 'translator', 'designer']) {
        const project = buildLocalOnlyProject();
        addMember(project, 'member', role);
        (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push('member');
        const steps = stepsOf({
          project,
          handle: 'member',
          task: localTask({ stageId: 'dev', assignee: 'member' }),
        });
        expect(steps, role).toContain(
          "Commit the work on the task's own branch in your worktree. Never push",
        );
        expect(steps, role).not.toMatch(/link_pull_request|open a pull request and/);
      }
    });

    it('fixes what teammates report with new commits and names them in the request for a re-review', () => {
      const steps = stepsOf({
        project: buildLocalOnlyProject(),
        handle: 'fe-1',
        task: localTask({ stageId: 'qa' }),
      });
      expect(steps).toBe(
        '1. The task is past development (now in QA (`qa`)). Fix what teammates report on the same branch and commit the fixes; never push, because the repository is local-only (the owner has not allowed publishing from it). Then ask the reporter for a re-review or a retest with send_message, naming the new commits.',
      );
    });

    it('fixes what teammates report in the same pull request when the repository is on GitHub', () => {
      const steps = stepsOf({ handle: 'fe-1', task: makeTask({ stageId: 'qa' }) });
      expect(steps).toBe(
        '1. The task is past development (now in QA (`qa`)). Fix what teammates report in the same branch and pull request, push, and ask the reporter for a re-review or a retest with send_message.',
      );
    });
  });

  describe('reviewer', () => {
    const reviewSteps = (project: ProjectConfig, handle = 'code-review') =>
      stepsOf({ project, handle, task: localTask() }).split('\n');

    it('reads the task branch against the default branch instead of a pull request', () => {
      const local = reviewSteps(buildLocalOnlyProject('.'));
      const github = stepsOf({ handle: 'code-review', task: makeTask() }).split('\n');
      expect(github[0]).toBe('1. Review the pull requests linked to the task; do not edit, commit or push.');
      expect(local[0]).toBe(
        "1. Review the task's branch against `main`: there is no pull request, because the repository is local-only (the owner has not allowed publishing from it). Every worktree shares one git repository, so you can read the task's branch from your working directory: find it with `git branch --list 'AR-21-*'` (it is named `AR-21-` followed by the title as a lowercase slug), then read `git log main..<branch>` and `git diff main...<branch>`. Do not edit, commit, merge or push.",
      );
      // Recording the result and sending the findings are the same.
      expect(local.slice(1, 3)).toEqual(github.slice(1, 3));
    });

    it('leaves the merge to the owner where it says what happens after the review', () => {
      const local = reviewSteps(buildLocalOnlyProject('.'));
      const github = stepsOf({ handle: 'code-review', task: makeTask() }).split('\n');
      expect(github[3]).toMatch(/^4\. When the review passes, move the task to Integration/);
      expect(local[3]).toBe(`${github[3]} The owner merges the branch into \`main\`.`);
      // Also when the review ends in a request for a human approval.
      const small = reviewSteps(buildLocalOnlyProject('.', 'small-team'));
      expect(small.at(-1)).toMatch(
        /never set that label yourself\. The owner merges the branch into `main`\.$/,
      );
    });

    it("names the repository's default branch and enters a repository in a folder of the workspace", () => {
      const project = buildLocalOnlyProject('app');
      project.project.repos.find((r) => r.name === 'app')!.defaultBranch = 'develop';
      const steps = reviewSteps(project);
      expect(steps[0]).toBe(
        "1. Review the task's branch against `develop`: there is no pull request, because the repository is local-only (the owner has not allowed publishing from it). Every worktree shares one git repository, so you can read the task's branch from the folder `app` of your working directory: find it with `cd app && git branch --list 'AR-21-*'` (it is named `AR-21-` followed by the title as a lowercase slug), then read `cd app && git log develop..<branch>` and `cd app && git diff develop...<branch>`. Do not edit, commit, merge or push.",
      );
      expect(steps[3]).toMatch(/ The owner merges the branch into `develop`\.$/);
    });

    it('reviews the commit checked out in its own workspace when it has one (PM-138)', () => {
      const project = buildLocalOnlyProject('.');
      const task = localTask();
      const [review] = stepsOf({
        project,
        handle: 'code-review',
        task,
        sessionPolicy: reviewPolicy(project, task),
      }).split('\n');
      expect(review).toBe(
        '1. Review the handed-over commit checked out in your workspace against its review base (see "Review round"): there is no pull request, because the repository is local-only (the owner has not allowed publishing from it). Do not commit, merge or push.',
      );
    });

    it.each(['.', './', ''])(
      'reads a repository at the workspace root (%j) from the working directory',
      (repoPath) => {
        const [review] = reviewSteps(buildLocalOnlyProject(repoPath));
        expect(review).toContain('from your working directory: find it with `git branch --list');
        expect(review).not.toContain('cd ');
      },
    );

    it.each([
      ['app/', 'app'],
      ['./app', 'app'],
      ['services/app', 'services/app'],
    ])('enters the repository folder %j as %j', (repoPath, folder) => {
      const [review] = reviewSteps(buildLocalOnlyProject(repoPath));
      expect(review).toContain(`from the folder \`${folder}\` of your working directory`);
      expect(review).toContain(`\`cd ${folder} && git branch --list 'AR-21-*'\``);
    });

    it('gives a security reviewer the same steps', () => {
      const project = buildLocalOnlyProject('.');
      addMember(project, 'security', 'security_review');
      (project.pipeline.stages.find((s) => s.id === 'code_review')!.owners ??= []).push('security');
      const steps = reviewSteps(project, 'security');
      expect(steps[0]).toContain("Review the task's branch against `main`: there is no pull request");
      expect(steps[3]).toMatch(/ The owner merges the branch into `main`\.$/);
    });

    it('asks a member who does not own the review stage what it was asked, as before', () => {
      const project = buildLocalOnlyProject('.');
      addMember(project, 'security', 'security_review');
      const steps = reviewSteps(project, 'security');
      expect(steps).toHaveLength(1);
      expect(steps[0]).toMatch(/^1\. Review what you were asked to review\./);
    });

    it('tells the reviewer only commands that the server allows without asking', () => {
      for (const repoPath of ['.', 'app']) {
        const project = buildLocalOnlyProject(repoPath);
        const [review] = reviewSteps(project);
        const commands = [...review!.matchAll(/`([^`]+)`/g)]
          .map((match) => match[1]!.replace('<branch>', 'AR-21-fix-the-booking-confirmation-email'))
          .filter((text) => /\bgit (branch|log|diff)\b/.test(text));
        expect(commands, repoPath).toHaveLength(3);
        // The reviewer starts in the workspace root and may read the task's worktree.
        const task = { key: 'AR-21', repo: 'app' };
        const readableRoots = readableRootsFor({
          config: project,
          cwd: '/work/acme',
          projectKey: 'AR',
          task,
          worktreesRootDir: '/worktrees',
        });
        for (const command of commands) {
          expect(
            commandVerdict({
              config: project,
              session: { cwd: '/work/acme', role: 'code_review' },
              task,
              toolName: 'Bash',
              toolInput: { command },
              readableRoots,
            }),
            command,
          ).toEqual({ behavior: 'allow' });
        }
      }
    });
  });

  describe('other members', () => {
    it('has DevOps deploy the task branch, not a pull request', () => {
      const deploy = (project: ProjectConfig) =>
        stepsOf({ project, handle: 'devops', task: makeTask({ stageId: 'integration' }) });
      expect(deploy(buildLocalOnlyProject())).toContain(
        "1. Deploy the task's branch to the test environment and verify that it works.",
      );
      expect(deploy(buildProject())).toContain(
        "1. Deploy the task's branch or pull request to the test environment and verify that it works.",
      );
    });

    it('has the architect size the work by branch, not by pull request', () => {
      const plan = (project: ProjectConfig) => {
        addMember(project, 'architect-1', 'architect');
        return stepsOf({
          project,
          handle: 'architect-1',
          task: makeTask({ stageId: 'ready', assignee: null }),
        });
      };
      expect(plan(buildLocalOnlyProject())).toContain(
        'If the work is bigger than one branch, create the parts with create_task',
      );
      expect(plan(buildProject())).toContain(
        'If the work is bigger than one pull request, create the parts with create_task',
      );
    });
  });

  describe('role instructions', () => {
    it('ask a developer to commit on the task branch instead of opening a pull request', () => {
      const local = roleInstructions({ project: buildLocalOnlyProject(), handle: 'fe-1', task: localTask() });
      expect(local).toContain(
        "Implement the task and tests only in its worktree; run checks and commit the work on the task's branch. The repository is local-only: never push or open a pull request.",
      );
      expect(local).not.toContain(DUTIES.implementation.prompt);
      expect(roleInstructions({ handle: 'fe-1' })).toContain(DUTIES.implementation.prompt);
    });

    it('ask a technical writer to commit on the task branch instead of linking a pull request', () => {
      const local = buildLocalOnlyProject();
      const github = buildProject();
      for (const project of [local, github]) addMember(project, 'writer', 'docs');
      const localRole = roleInstructions({ project: local, handle: 'writer', task: localTask() });
      expect(localRole).toContain(
        "Write accurate documentation in the task worktree; verify examples against the code and commit it on the task's branch. The repository is local-only: never push or open a pull request.",
      );
      expect(localRole).not.toContain(DUTIES.docs.prompt);
      expect(roleInstructions({ project: github, handle: 'writer' })).toContain(DUTIES.docs.prompt);
    });

    it('leave no duty fragment about pull requests for a member working in a local-only repository', () => {
      // A new fragment that mentions a pull request or a push needs a local-only variant.
      const mentioning = DUTY_IDS.filter((id) => /pull request|\bpush/i.test(DUTIES[id].prompt));
      expect(mentioning).toContain('implementation');
      for (const id of mentioning) {
        const project = buildLocalOnlyProject();
        project.team.roles.push({
          id: `only_${id}`,
          name: `Only ${id}`,
          summary: 'Holds a single duty.',
          notTheirJob: '',
          holders: 'both',
          duties: [id],
          instructions: '',
        });
        addMember(project, 'member', `only_${id}`);
        const role = roleInstructions({
          project,
          handle: 'member',
          task: localTask({ stageId: 'dev', assignee: 'member' }),
        });
        expect(role, id).not.toContain(DUTIES[id].prompt);
        expect(role, id).toContain('The repository is local-only');
      }
    });

    it('stay as they are outside a task', () => {
      const project = buildLocalOnlyProject();
      const role = roleInstructions({
        project,
        handle: 'fe-1',
        workItem: { type: 'general' },
        task: null,
        stage: null,
        timeline: [],
      });
      expect(role).toContain(DUTIES.implementation.prompt);
    });
  });

  describe('what stays as it is', () => {
    it('keeps the pull request wording for a task that works in no repository and for one the configuration does not know', () => {
      // Nothing says the work is local-only: the project has no repository, or several and none is
      // chosen, or the task names one the configuration does not know.
      const cases: Array<[string, ProjectConfig, string | null]> = [
        ['no repository in the project', buildProjectWithoutRepos(), null],
        ['several repositories, none chosen', buildProjectWithTwoRepos(buildLocalOnlyProject), null],
        ['an unknown repository', buildLocalOnlyProject(), 'missing'],
      ];
      for (const [name, project, repo] of cases) {
        const steps = stepsOf({ project, handle: 'fe-1', task: makeTask({ stageId: 'dev', repo }) });
        expect(steps, name).toContain(
          '3. Commit, push, open a pull request and attach it with link_pull_request.',
        );
        expect(roleInstructions({ project, handle: 'fe-1', task: makeTask({ repo }) }), name).toContain(
          DUTIES.implementation.prompt,
        );
        const review = stepsOf({ project, handle: 'code-review', task: makeTask({ repo }) });
        expect(review, name).toContain('1. Review the pull requests linked to the task;');
      }
    });

    it('uses the local-only wording for a task without a repository when the only repository is local-only', () => {
      // The repository the task works in is the project's only one (PM-68), which is local-only.
      const project = buildLocalOnlyProject();
      const own = makeTask({ stageId: 'dev', repo: 'app' });
      const none = makeTask({ stageId: 'dev', repo: null });
      for (const handle of ['fe-1', 'code-review'] as const) {
        expect(stepsOf({ project, handle, task: none }), handle).toBe(
          stepsOf({ project, handle, task: own }),
        );
        expect(roleInstructions({ project, handle, task: none }), handle).toBe(
          roleInstructions({ project, handle, task: own }),
        );
      }
      expect(stepsOf({ project, handle: 'fe-1', task: none })).toContain('the repository is local-only');
    });

    it('changes only the steps and the role instructions of the pack, and leaves the brief alone', () => {
      const cases = [
        ['fe-1', 'ready'],
        ['fe-1', 'dev'],
        ['fe-1', 'qa'],
        ['code-review', 'code_review'],
        ['devops', 'integration'],
        ['qa', 'qa'],
        ['communication', 'client_test'],
      ] as const;
      const differing: string[] = [];
      for (const [handle, stageId] of cases) {
        const task = makeTask({ stageId });
        const github = builder.build(input({ handle, task }));
        const local = builder.build(input({ project: buildLocalOnlyProject(), handle, task }));
        expect(withoutLocalOnlyParts(local.appendSystemPrompt), `${handle} in ${stageId}`).toBe(
          withoutLocalOnlyParts(github.appendSystemPrompt),
        );
        expect(local.initialMessage, `${handle} in ${stageId}`).toBe(github.initialMessage);
        if (localOnlyParts(local.appendSystemPrompt) !== localOnlyParts(github.appendSystemPrompt)) {
          differing.push(`${handle} in ${stageId}`);
        }
      }
      // Only where a pull request plays a part: building, fixing, reviewing and deploying.
      expect(differing).toEqual([
        'fe-1 in ready',
        'fe-1 in dev',
        'fe-1 in qa',
        'code-review in code_review',
        'devops in integration',
      ]);
    });
  });
});

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

/** The policy of a reviewer in its own member workspace, round 2 of the task's review. */
function reviewPolicy(project: ProjectConfig, task: Task) {
  return buildSessionPolicy({
    config: project,
    role: 'code_review',
    task,
    placement: {
      kind: 'review_copy',
      path: '/workspaces/AR/code-review/app/repo',
      gitDir: '/workspaces/AR/code-review/app/repo/.git',
      sourceCommit: COMMIT_B,
      roundId: '2',
      sourceBranch: 'AR-21-fix-the-booking-confirmation-email',
      baseBranch: 'main',
      baseCommit: COMMIT_A,
    },
  });
}

describe("the CLI's own sandbox (PM-167)", () => {
  const project = buildLocalOnlyProject('.');
  const task = makeTask({ stageId: 'review', repo: 'app' });
  const readerPolicy = buildSessionPolicy({
    config: project,
    role: 'code_review',
    task,
    permissionMode: 'auto',
    placement: { kind: 'read_only', path: '/work/acme' },
    readableRoots: ['/worktrees/AR/AR-21-app'],
    deniedPaths: ['/home/anna/.ssh', '/pm/db.sqlite*'],
  });
  const sandboxPaths = { userHome: '/home/anna', appHome: '/pm', defaultBranch: 'main' };
  const sandbox = sessionSandbox(readerPolicy, sandboxPaths)!;

  it('tells a sandboxed Claude reader its boundary instead of the command forms', () => {
    const prompt = builder.build(
      input({ project, handle: 'code-review', task, sessionPolicy: readerPolicy, sandbox }),
    ).appendSystemPrompt;
    expect(prompt).not.toContain('# Commands that run without asking');
    expect(prompt).not.toContain('waits in a human inbox');
    const text = section(prompt, '# Your sandbox');
    expect(text).toContain('Writing: only the temp directory');
    expect(text).toContain('`/work/acme` and `/worktrees/AR/AR-21-app` are read-only');
    expect(text).toContain('`/home/anna/.ssh`');
    expect(text).toContain('any outbound host except `localhost`, `127.0.0.1`');
    // A local-only repository has no pull request to read with `gh` (PM-188).
    expect(text).not.toContain('`gh pr view`');
    expect(text).toContain('Refused outright: `git push`');
    expect(text).toContain('ask_human');
  });

  it('tells a reader of a repository on GitHub to run gh as a command of its own (PM-188)', () => {
    const github = buildProject();
    const policy = buildSessionPolicy({
      config: github,
      role: 'code_review',
      task,
      permissionMode: 'auto',
      placement: { kind: 'read_only', path: '/work/acme' },
    });
    const text = section(
      builder.build(
        input({
          project: github,
          handle: 'code-review',
          task,
          sessionPolicy: policy,
          sandbox: sessionSandbox(policy, { github: true })!,
        }),
      ).appendSystemPrompt,
      '# Your sandbox',
    );
    expect(text).toContain(
      "`gh pr view` and `gh pr diff` with their arguments run outside the sandbox (they need the GitHub CLI's login), allowed by your permission rules, but only as a command of their own: `gh pr view 12`.",
    );
    expect(text).toContain(
      'In a chain, a pipe, a substitution or with a redirection into a file they run inside',
    );
    expect(text).not.toContain('Refused outright');
  });

  it('tells a sandboxed developer where it writes, in a chat too', () => {
    const developerPolicy = buildSessionPolicy({
      config: project,
      role: 'developer',
      task,
      permissionMode: 'auto',
      placement: { kind: 'task_worktree', path: '/pm/worktrees/AR/AR-21-app', gitDir: '/src/app/.git' },
      deniedPaths: ['/home/anna/.ssh', '/pm/secret'],
    });
    const text = section(
      builder.build(
        input({
          project,
          handle: 'fe-1',
          task,
          sessionPolicy: developerPolicy,
          sandbox: sessionSandbox(developerPolicy, {
            ...sandboxPaths,
            memberDir: '/pm/member-caches/AR/fe-1',
          })!,
        }),
      ).appendSystemPrompt,
      '# Your sandbox',
    );
    expect(text).toContain('Writing: your working directory `/pm/worktrees/AR/AR-21-app`');
    expect(text).toContain(
      'and `/pm/member-caches/AR/fe-1/npm-cache`, `/pm/member-caches/AR/fe-1/projectman-dev`',
    );
    // PM-193: npm and the development instance use the member's own directories.
    expect(text).toContain(
      '`npm_config_cache` is `/pm/member-caches/AR/fe-1/npm-cache`, `PROJECTMAN_HOME` is `/pm/member-caches/AR/fe-1/projectman-dev`',
    );
    // PM-194: the PTY tests are left out on this signal, which is not one of its own directories.
    expect(text).not.toContain('`PROJECTMAN_SKIP_PTY_TESTS` is');
    expect(text).toContain('`PROJECTMAN_SKIP_PTY_TESTS=1` is set here');
    expect(text).toContain(
      'Never these paths of the shared git directory (the default branch, the integrating checkout, replacements and grafts): `/src/app/.git/refs/heads/main`, `/src/app/.git/HEAD`, `/src/app/.git/index`, `/src/app/.git/packed-refs`, `/src/app/.git/refs/replace`, `/src/app/.git/info/grafts` (and their lock files)',
    );
    expect(text).toContain(
      'Reading: nothing below `/home/anna` and `/pm` except `/pm/worktrees/AR/AR-21-app`, `/pm/member-caches/AR/fe-1/npm-cache`, `/pm/member-caches/AR/fe-1/projectman-dev`, `/pm/member-caches/AR/fe-1/gitconfig`, `/src/app/.git`, `/home/anna/.gitconfig`',
    );
    // PM-216: git's settings file is told apart from the npm cache and the development data.
    expect(text).not.toContain('`GIT_CONFIG_SYSTEM` is');
    expect(text).toContain('its system settings come from `/pm/member-caches/AR/fe-1/gitconfig`');
    expect(text).toContain("`Unable to create '…/packed-refs.lock'`: the commit exists");
    expect(text).toContain(
      '`GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `SSH_AUTH_SOCK` are unset',
    );
    expect(text).toContain('a here-document (`<<`)');
    const chat = builder.build(
      input({
        project,
        handle: 'fe-1',
        task: null,
        workItem: { type: 'general' },
        sessionPolicy: readerPolicy,
        sandbox,
      }),
    ).appendSystemPrompt;
    expect(section(chat, '# Your sandbox')).toContain('Writing: only the temp directory');
  });

  it("keeps Codex's text: its own sandbox escalates to the server's rules", () => {
    const member: AiMemberConfig = { ...aiMember(project, 'code-review'), provider: 'codex' };
    const prompt = builder.build(
      input({ project, member, handle: 'code-review', task, sessionPolicy: readerPolicy, sandbox }),
    ).appendSystemPrompt;
    expect(prompt).toContain('# Commands that run without asking');
    expect(prompt).not.toContain('# Your sandbox');
    // No folder in its sandbox (a read-only one has none): no folder text.
    expect(prompt).not.toContain('# Your session folder');
  });

  it('tells a Codex developer its session folder and its own TMPDIR (PM-339)', () => {
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'codex' };
    const developerPolicy = buildSessionPolicy({
      config: project,
      role: 'developer',
      task,
      permissionMode: 'acceptEdits',
      placement: { kind: 'task_worktree', path: '/pm/worktrees/AR/AR-21-app', gitDir: '/src/app/.git' },
      deniedPaths: ['/home/anna/.ssh', '/pm/secret'],
    });
    const folder = '/tmp/projectman-sessions/abc123/ses_1.0123456789abcdef';
    const tmpDir = '/tmp/projectman-501-tmp/0123abcd/ses_1.abcdef';
    const prompt = builder.build(
      input({
        project,
        member,
        handle: 'fe-1',
        task,
        sessionPolicy: developerPolicy,
        sandbox: sessionSandbox(developerPolicy, { ...sandboxPaths, sessionDir: folder, tmpDir })!,
      }),
    ).appendSystemPrompt;
    const text = section(prompt, '# Your session folder');
    expect(text).toContain(`Your session folder: \`${folder}\` (\`$PROJECTMAN_SESSION_DIR\`)`);
    expect(text).toContain('`attach_file`');
    expect(text).toContain('`view_image`');
    expect(text).toContain('`/tmp/projectman-sessions/abc123`');
    expect(text).toContain(`\`$TMPDIR\` (\`${tmpDir}\`) is your own, deleted with the session`);
    expect(text).toContain('The shared `/tmp` is not writable');
    // The screenshots are the server's (PM-351): the tools, never a shell command or the sandbox paths.
    expect(text).toContain('`take_screenshots`');
    expect(text).toContain('`get_screenshot_run`');
    expect(prompt).toContain('# Commands that run without asking');
    expect(section(prompt, '# Your session folder')).not.toContain('npm run shots');
    expect(prompt).not.toContain('# Your sandbox');
    expect(prompt).not.toContain('Browsers:');
  });

  it('does not give a Claude developer the Codex folder section', () => {
    const developerPolicy = buildSessionPolicy({
      config: project,
      role: 'developer',
      task,
      permissionMode: 'auto',
      placement: { kind: 'task_worktree', path: '/pm/worktrees/AR/AR-21-app', gitDir: '/src/app/.git' },
    });
    const prompt = builder.build(
      input({
        project,
        handle: 'fe-1',
        task,
        sessionPolicy: developerPolicy,
        sandbox: sessionSandbox(developerPolicy, { ...sandboxPaths, sessionDir: '/tmp/s/ses_1.0123' })!,
      }),
    ).appendSystemPrompt;
    expect(prompt).not.toContain('# Your session folder');
    expect(section(prompt, '# Your sandbox')).toContain('put screenshots and other files to attach there');
  });
});

describe('who decides a permission question (the approver, PM-165)', () => {
  const project = buildLocalOnlyProject('.');
  const task = makeTask({ stageId: 'dev', repo: 'app' });
  const policySection = (approver: 'human' | 'ai' | 'none' | undefined) => {
    const member = aiMember(project, 'fe-1');
    const withApprover = { ...member, ...(approver ? { approver } : { approver: undefined }) };
    const sessionPolicy = buildSessionPolicy({
      config: project,
      role: 'developer',
      task,
      placement: { kind: 'task_worktree', path: '/work' },
      deniedPaths: ['/Users/anna/.ssh'],
    });
    return section(
      builder.build({ ...input({ project, handle: 'fe-1', task, sessionPolicy }), member: withApprover })
        .appendSystemPrompt,
      '# Session policy',
    );
  };

  it('says the refusal is final and ask_human is the way forward, when nobody decides', () => {
    const text = policySection('none');
    expect(text).toContain('nobody approves them in this session');
    expect(text).toContain('the refusal is final');
    expect(text).toContain('ask_human');
  });

  it('says a human decides for a member with no approver set, and a teammate or a human for the AI approver', () => {
    expect(policySection(undefined)).toContain('a human decides in their inbox');
    expect(policySection('human')).toContain('a human decides in their inbox');
    expect(policySection('ai')).toContain('a teammate or a human decides');
  });

  it('names what the file tools and web fetch never reach', () => {
    expect(policySection('none')).toContain('`/Users/anna/.ssh`');
    expect(policySection('none')).toContain('web fetch never reaches `localhost`, `127.0.0.1`');
  });

  it('explains automatic dependency refresh and the missing-reference fallback', () => {
    const text = policySection('none');
    expect(text).toContain("projectman refreshes the worktree's node_modules");
    expect(text).toContain('do not install it or work around it');
    expect(text).toContain('ask the owner with ask_human');
    expect(text).toContain('within a minute');
  });
});

describe('member workspaces (PM-138)', () => {
  it('tells a developer which branch of its own workspace it works on, and that switching needs committed work', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const sessionPolicy = buildSessionPolicy({
      config: project,
      role: 'developer',
      task,
      placement: {
        kind: 'task_worktree',
        path: '/workspaces/AR/fe-1/app/repo',
        workspace: { branch: 'AR-21-fix-the-booking-confirmation-email', baseCommit: COMMIT_A },
      },
    });
    const prompt = builder.build(input({ project, handle: 'fe-1', task, sessionPolicy })).appendSystemPrompt;
    expect(section(prompt, '# Your workspace').trim()).toBe(
      [
        '# Your workspace',
        `You work in your own durable workspace for this repository, an independent clone at \`/workspaces/AR/fe-1/app/repo\`, on the task's branch \`AR-21-fix-the-booking-confirmation-email\` (it started from \`${COMMIT_A}\`).`,
        'It stays yours across tasks: the branches of your other tasks are kept in it, and nothing is ever reset, stashed or cleaned for you. Commit your work before you hand over: you move to another task here only when nothing is left uncommitted and no git operation (merge, rebase, cherry-pick) is unfinished.',
        'It has no remote. Teammates who review or test your work get your committed branch from here; uncommitted files never reach them.',
      ].join('\n'),
    );
    // The sandbox may write the clone's own git directory: it is inside the workspace.
    expect(sessionPolicy.filesystem.protectedPaths).toEqual([]);
  });

  it('tells a reviewer the round, the pinned commit and the review base', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask();
    const prompt = builder.build(
      input({ project, handle: 'code-review', task, sessionPolicy: reviewPolicy(project, task) }),
    ).appendSystemPrompt;
    expect(section(prompt, '# Review round').trim()).toBe(
      [
        '# Review round',
        `Round 2: your own workspace at \`/workspaces/AR/code-review/app/repo\` has the handed-over commit \`${COMMIT_B}\` of \`AR-21-fix-the-booking-confirmation-email\` checked out (detached HEAD); the developer's uncommitted files are not in it.`,
        `The review base is \`main\` at \`${COMMIT_A}\`: read the change with \`git log ${COMMIT_A}..HEAD\` and \`git diff ${COMMIT_A}...HEAD\`.`,
        'You keep this commit while the round lasts. A new round with the latest commit starts when the task enters a stage or its developer asks you for a re-review; you are restarted on it then.',
      ].join('\n'),
    );
  });

  describe('the commit pinned when the task entered review (PM-183)', () => {
    const pin = {
      commit: COMMIT_B,
      branch: 'AR-21-fix-the-booking-confirmation-email',
      pinnedAt: '2026-10-01T10:00:00.000Z',
    };

    it('names it to a reviewer who reads the developer’s worktree, and warns that it is live', () => {
      const project = buildLocalOnlyProject('.');
      const task = makeTask({ reviewPin: pin });
      const pack = builder.build(input({ project, handle: 'code-review', task }));
      const round = section(pack.appendSystemPrompt, '# Review round');
      expect(round).toContain(`handed over at commit \`${COMMIT_B}\` of the branch \`${pin.branch}\``);
      expect(round).toContain("not the files in the developer's working directory");
      expect(round).toContain('sends the task back to development');
      // The reviewer's opening message and its steps name the commit too.
      expect(pack.initialMessage).toContain(
        `- Handed over for review: commit \`${COMMIT_B}\` of branch \`${pin.branch}\``,
      );
      expect(pack.appendSystemPrompt).toContain(
        `The commit handed over for this review is \`${COMMIT_B}\` on the branch \`${pin.branch}\``,
      );
    });

    it('adds the send-back rule to the round of a reviewer in a workspace of its own', () => {
      const project = buildLocalOnlyProject('.');
      const task = makeTask({ reviewPin: pin });
      const prompt = builder.build(
        input({ project, handle: 'code-review', task, sessionPolicy: reviewPolicy(project, task) }),
      ).appendSystemPrompt;
      expect(section(prompt, '# Review round')).toContain('sends the task back to development');
    });

    it("says in the reviewer's brief and resume message what the server's full test found (PM-217)", () => {
      const project = buildLocalOnlyProject('.');
      project.project.repos.find((r) => r.name === 'app')!.reviewTest = {
        command: 'npm run typecheck && npm test',
        maxWorkers: 2,
        timeoutMinutes: 15,
      };
      const at = '2026-10-01T10:05:00.000Z';
      const pack = (fullTest?: NonNullable<Task['reviewPin']>['fullTest']) => {
        const task = makeTask({ repo: 'app', reviewPin: { ...pin, ...(fullTest ? { fullTest } : {}) } });
        return builder.build(input({ project, handle: 'code-review', task }));
      };
      const passed = pack({ status: 'passed', at });
      expect(passed.initialMessage).toContain(
        `- The full test (\`npm run typecheck && npm test\`, PTY tests included) passed on this commit at ${at}: you need not run the tests or the type check again.`,
      );
      expect(passed.continueMessage).toContain('you need not run the tests or the type check again.');
      const error = pack({ status: 'error', at, reason: 'timeout' });
      expect(error.initialMessage).toContain(
        'The full test could not run on this commit (`timeout`): run the checks yourself as usual; your sandbox leaves out the PTY tests.',
      );
      // No result (not asked for, queued, running, failed and sent back): no line.
      for (const none of [undefined, { status: 'running' as const, at }, { status: 'failed' as const, at }])
        expect(pack(none).initialMessage).not.toContain('full test');
      project.project.repos[0]!.fullTestAtMerge = true;
      const mergeError = pack({ status: 'error', at, reason: 'timeout' });
      for (const message of [mergeError.initialMessage, mergeError.continueMessage]) {
        expect(message).toContain('run only targeted checks if needed for this review');
        expect(message).toContain('the integrator or merge step runs the full check before merge');
        expect(message).not.toContain('run the checks yourself as usual');
      }
      const mergePassed = pack({ status: 'passed', at });
      expect(mergePassed.initialMessage).toBe(passed.initialMessage);
      expect(mergePassed.continueMessage).toBe(passed.continueMessage);
    });

    it("tells the task's developer nothing about it", () => {
      const project = buildLocalOnlyProject('.');
      const task = makeTask({ reviewPin: pin, assignee: 'fe-1' });
      const prompt = builder.build(input({ project, handle: 'fe-1', task })).appendSystemPrompt;
      expect(section(prompt, '# Review round')).toBe('');
    });
  });

  it('adds nothing for sessions in a per-task worktree or the workspace root', () => {
    const prompt = builder.build(input({ handle: 'code-review' })).appendSystemPrompt;
    expect(section(prompt, '# Review round')).toBe('');
    expect(section(prompt, '# Your workspace')).toBe('');
  });
});

describe('the managed VM profile (PM-141)', () => {
  const boundary = { name: 'managed-vm', version: 1 };
  const managedPolicy = (
    project: ProjectConfig,
    task: Task | null,
    placement: SessionPolicy['placement'],
    mode = 'default',
    role = 'developer',
  ) =>
    buildSessionPolicy({
      config: project,
      role,
      task,
      placement,
      permissionMode: mode,
      managedVm: { boundary },
    });
  const WORK = {
    kind: 'member_workspace',
    path: '/vm/workspaces/AR/fe-1/app/repo',
    use: 'work',
    workspace: { branch: 'AR-21-fix-the-booking-confirmation-email', baseCommit: COMMIT_A },
  } satisfies SessionPolicy['placement'];

  it('tells the member it works without asking, in any command form, and where the limits are', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const sessionPolicy = managedPolicy(project, task, WORK);
    const prompt = builder.build(input({ project, handle: 'fe-1', task, sessionPolicy })).appendSystemPrompt;
    const policy = section(prompt, '# Session policy');
    expect(policy).toContain('Execution profile: managed VM');
    expect(policy).toContain('run without asking, in any form');
    expect(policy).toContain('the network gate');
    expect(policy).toContain('submit_boundary_request');
    // The legacy wording about the command policy and a sandbox that is not strict is not here.
    expect(policy).not.toContain('Enforcement is the existing provider and command policy');
  });

  it('sends a developer on GitHub to the publishing gate, not to git push and gh (PM-142)', () => {
    const project = buildProject();
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const managed = builder.build(
      input({ project, handle: 'fe-1', task, sessionPolicy: managedPolicy(project, task, WORK) }),
    ).appendSystemPrompt;
    expect(managed).toContain('publish it with publish_task_branch');
    expect(managed).not.toContain('Commit, push, open a pull request and attach it with link_pull_request.');
    expect(section(managed, '# Session policy')).toContain('only through publish_task_branch');
    expect(section(managed, '# Session policy')).toContain('hold no GitHub credentials');
    // Everywhere else the member opens and links the pull request as before.
    const legacy = builder.build(input({ project, handle: 'fe-1', task })).appendSystemPrompt;
    expect(legacy).toContain('Commit, push, open a pull request and attach it with link_pull_request.');
    expect(legacy).not.toContain('publish it with publish_task_branch');
  });

  it('leaves out the command forms: nothing waits for a human, so there is nothing to write them for', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const managed = builder.build(
      input({ project, handle: 'fe-1', task, sessionPolicy: managedPolicy(project, task, WORK) }),
    ).appendSystemPrompt;
    expect(managed).not.toContain('# Commands that run without asking');
    expect(managed).not.toContain('waits in a human inbox');
    // The same member in the legacy profile keeps them.
    const legacy = builder.build(input({ project, handle: 'fe-1', task })).appendSystemPrompt;
    expect(legacy).toContain('# Commands that run without asking');
  });

  it('keeps the workspace and review round text for the new placement', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const prompt = builder.build(
      input({ project, handle: 'fe-1', task, sessionPolicy: managedPolicy(project, task, WORK) }),
    ).appendSystemPrompt;
    expect(section(prompt, '# Your workspace')).toContain(
      "on the task's branch `AR-21-fix-the-booking-confirmation-email`",
    );
    const reviewTask = makeTask();
    const reviewPrompt = builder.build(
      input({
        project,
        handle: 'code-review',
        task: reviewTask,
        sessionPolicy: managedPolicy(
          project,
          reviewTask,
          {
            kind: 'member_workspace',
            path: '/vm/workspaces/AR/code-review/app/repo',
            use: 'review',
            review: {
              sourceCommit: COMMIT_B,
              roundId: '2',
              sourceBranch: 'AR-21-fix-the-booking-confirmation-email',
              baseBranch: 'main',
              baseCommit: COMMIT_A,
            },
          },
          'default',
          'code_review',
        ),
      }),
    ).appendSystemPrompt;
    expect(section(reviewPrompt, '# Review round')).toContain(`Round 2: your own workspace at`);
    expect(section(reviewPrompt, '# Review round')).toContain(COMMIT_B);
    // The local-only review step relies on the checked-out commit, as for a PM-138 review copy.
    expect(reviewPrompt).toContain('Review the handed-over commit checked out in your workspace');
  });

  it('describes a session with no repository by its own directory', () => {
    const project = buildLocalOnlyProject('.');
    const prompt = builder.build(
      input({
        project,
        handle: 'fe-1',
        task: null,
        workItem: { type: 'general' },
        sessionPolicy: managedPolicy(project, null, {
          kind: 'member_workspace',
          path: '/vm/workspaces/AR/fe-1/.home',
          use: 'home',
        }),
      }),
    ).appendSystemPrompt;
    expect(section(prompt, '# Your workspace')).toContain('/vm/workspaces/AR/fe-1/.home');
  });

  it('tells a research-only member to read and report', () => {
    const project = buildLocalOnlyProject('.');
    const task = makeTask({ stageId: 'dev', repo: 'app' });
    const prompt = builder.build(
      input({ project, handle: 'fe-1', task, sessionPolicy: managedPolicy(project, task, WORK, 'plan') }),
    ).appendSystemPrompt;
    expect(section(prompt, '# Session policy')).toContain('research-only (plan)');
    expect(section(prompt, '# Session policy')).not.toContain('run without asking, in any form');
  });
});

describe('sub-cards that stand on their own (PM-230)', () => {
  const RULE = 'A sub-card you create must stand on its own';
  const roleText = (prompt: string) => section(prompt, '# Your role instructions');

  it('gives the rule to every role that splits work, once', async () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    addMember(project, 'analyst', 'business_analyst');
    addMember(project, 'designer', 'designer');
    for (const handle of ['architect', 'analyst', 'designer']) {
      const pack = builder.build(input({ project, handle, task: makeTask({ stageId: 'dev' }) }));
      const role = roleText(pack.appendSystemPrompt);
      expect(role).toContain(RULE);
      expect(role.split(RULE)).toHaveLength(2);
    }
    const analyst = builder.build(input({ project, handle: 'analyst', task: makeTask({ stageId: 'dev' }) }));
    await expect(`${roleText(analyst.appendSystemPrompt)}\n`).toMatchFileSnapshot(
      '__snapshots__/analyst.role-instructions.txt',
    );
  });

  it('leaves the rule out for the roles that do not split work', () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    for (const handle of ['fe-1', 'code-review', 'qa']) {
      const pack = builder.build(input({ project, handle, task: makeTask({ stageId: 'dev' }) }));
      expect(pack.appendSystemPrompt).not.toContain(RULE);
    }
  });

  it('shows the parent files the description names first and marked, and only counts the rest', async () => {
    const files = [
      screenshot({ id: 'att_parent00', fileName: '01-first.jpg' }),
      screenshot({ id: 'att_parent01', fileName: '06-rad-var-asztali.jpg' }),
      screenshot({ id: 'att_parent02', fileName: '07-other.jpg' }),
      screenshot({ id: 'att_parent03', fileName: '08-other.jpg' }),
    ];
    const brief =
      builder.build(
        input({
          task: makeTask({
            stageId: 'dev',
            parentKey: 'AR-7',
            description: 'Restyle the table. See AR-7: 06-rad-var-asztali.jpg and AR-7: 01-first.jpg.',
          }),
          parentAttachments: { taskKey: 'AR-7', attachments: files },
        }),
      ).initialMessage ?? '';
    const start = brief.indexOf('## Attachments');
    const end = brief.indexOf('\n\n## ', start + 1);
    const section = brief.slice(start, end === -1 ? undefined : end);
    await expect(section).toMatchFileSnapshot('__snapshots__/developer-dev-parent-references.section.txt');
    expect(section.indexOf('01-first.jpg')).toBeLessThan(section.indexOf('06-rad-var-asztali.jpg'));
    expect(section).not.toContain('07-other.jpg');
    expect(section).not.toContain('08-other.jpg');
  });

  it('keeps the plain parent list when the description names none of the files', () => {
    const brief =
      builder.build(
        input({
          task: makeTask({ stageId: 'dev', parentKey: 'AR-7', description: 'Restyle the table.' }),
          parentAttachments: {
            taskKey: 'AR-7',
            attachments: [screenshot({ id: 'att_parent00', fileName: 'parent-0.png' })],
          },
        }),
      ).initialMessage ?? '';
    expect(brief).toContain('Parent `AR-7` has 1 attachment:');
    expect(brief).toContain('"parent-0.png"');
    expect(brief).not.toContain('referenced by this card');
  });
});

describe('structural decisions (PM-223)', () => {
  const RULE = 'Structural decisions are not yours to make.';
  const roleText = (prompt: string) => section(prompt, '# Your role instructions');

  it('names the architect to a developer when the team has one', async () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    const pack = builder.build(input({ project, handle: 'fe-1', task: makeTask({ stageId: 'dev' }) }));
    await expect(`${roleText(pack.appendSystemPrompt)}\n`).toMatchFileSnapshot(
      '__snapshots__/developer-dev-architect.role-instructions.txt',
    );
  });

  it('names every holder of the technical direction duty', () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    addMember(project, 'architect-2', 'architect');
    const pack = builder.build(input({ project, handle: 'fe-1', task: makeTask({ stageId: 'dev' }) }));
    expect(roleText(pack.appendSystemPrompt)).toContain('ask `architect` or `architect-2` with send_message');
  });

  it('sends the question to a human with ask_human when nobody holds the duty', () => {
    const pack = builder.build(input({ handle: 'fe-1', task: makeTask({ stageId: 'dev' }) }));
    const role = roleText(pack.appendSystemPrompt);
    expect(role).toContain(RULE);
    expect(role).toContain('ask the human responsible with ask_human');
    expect(role).not.toContain('ask `');
  });

  it('skips a retired architect', () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    const team = teamOf(project).map((m) => (m.handle === 'architect' ? { ...m, status: 'retired' } : m));
    const pack = builder.build(
      input({ project, team: team as MemberView[], handle: 'fe-1', task: makeTask({ stageId: 'dev' }) }),
    );
    expect(roleText(pack.appendSystemPrompt)).toContain('ask the human responsible with ask_human');
  });

  it('leaves the rule out for a member who does not implement', () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    for (const handle of ['code-review', 'qa', 'architect']) {
      const pack = builder.build(input({ project, handle, task: makeTask({ stageId: 'dev' }) }));
      expect(pack.appendSystemPrompt).not.toContain(RULE);
    }
  });

  it('tells the architect to answer a structural question briefly and record the decision', async () => {
    const project = buildProject();
    addMember(project, 'architect', 'architect');
    const pack = builder.build(input({ project, handle: 'architect', task: makeTask({ stageId: 'dev' }) }));
    await expect(`${roleText(pack.appendSystemPrompt)}\n`).toMatchFileSnapshot(
      '__snapshots__/architect.role-instructions.txt',
    );
  });
});

describe('handover and previous conversation (PM-342)', () => {
  const summary = (overrides: Partial<HandoffSummary> = {}): HandoffSummary => ({
    source: 'last_replies',
    text: 'I finished the form.\nThe tests are next.',
    at: '2026-10-05T09:30:00.000Z',
    ...overrides,
  });
  const takeover = (overrides: Partial<HandoffTakeover> = {}): HandoffTakeover => ({
    handoffId: 'hnd_1',
    from: 'dev',
    fromProvider: 'claude',
    toProvider: 'codex',
    endedAt: '2026-10-05T10:00:00.000Z',
    outcome: 'note',
    note: 'Done: the form. Left: tests.',
    branch: 'AR-21-fix-email',
    lastCommit: 'abc1234',
    uncommitted: false,
    summary: null,
    ...overrides,
  });
  const brief = (overrides: Partial<ContextPackInput> = {}) =>
    builder.build(input({ handle: 'fe-1', ...overrides })).initialMessage!;

  it('has neither part without a handover or a previous conversation', () => {
    const text = brief();
    expect(text).not.toContain('## Handoff');
    expect(text).not.toContain('## Previous conversation');
  });

  it('puts the handover with the note after the description and before the links', () => {
    const text = brief({ handoff: takeover({ uncommitted: true }) });
    expect(text).toContain(
      '## Handoff\nThis card was handed over to you by `dev` (Claude) at 2026-10-05T10:00:00.000Z. You run on Codex.',
    );
    expect(text).toContain('Their work tree: branch `AR-21-fix-email`, last commit `abc1234`.');
    expect(text).toContain('Uncommitted changes were left in the worktree.');
    expect(text).toContain('Their handoff note:\n> Done: the form. Left: tests.');
    expect(text.indexOf('## Description')).toBeLessThan(text.indexOf('## Handoff'));
    expect(text.indexOf('## Handoff')).toBeLessThan(text.indexOf('## Links'));
  });

  it('says why there is no note and gives the summary of their conversation', () => {
    const text = brief({
      handoff: takeover({
        outcome: 'fallback',
        fallbackReason: 'timeout',
        note: null,
        uncommitted: null,
        summary: summary({ source: 'compact' }),
      }),
    });
    expect(text).toContain('There is no handoff note: the member did not write a note in time.');
    expect(text).toContain("the conversation's own compaction summary and the replies after it");
    expect(text).toContain('up to 2026-10-05T09:30:00.000Z');
    expect(text).toContain('It may be incomplete');
    expect(text).toContain('> I finished the form.\n> The tests are next.');
    expect(text).not.toContain('Uncommitted changes');
  });

  it('says so when there is no note and no summary either', () => {
    const text = brief({
      handoff: takeover({ outcome: 'fallback', fallbackReason: 'member_removed', note: null }),
    });
    expect(text).toContain('There is no handoff note: the member was removed from the team.');
    expect(text).toContain('No summary of their conversation is available.');
  });

  it('is told first in the message a resumed conversation gets', () => {
    const standing = builder.build(input({ handle: 'fe-1', handoff: takeover() })).standing!;
    expect(standing.startsWith('Now on AR-21:\n\n## Handoff\n')).toBe(true);
    expect(standing).toContain('> Done: the form. Left: tests.');
  });

  it('tells a provider change with the summary of the old conversation', () => {
    const project = buildProject();
    const member: AiMemberConfig = { ...aiMember(project, 'fe-1'), provider: 'codex' };
    const text = builder.build(
      input({
        project,
        member,
        previousConversation: {
          reason: 'provider_changed',
          fromProvider: 'claude',
          summary: summary(),
          lastNote: null,
        },
      }),
    ).initialMessage!;
    expect(text).toContain(
      '## Previous conversation\nYour provider changed from Claude to Codex. A conversation cannot be carried on by another provider, so this one is new.',
    );
    expect(text).toContain('> I finished the form.\n> The tests are next.');
    expect(text.indexOf('## Description')).toBeLessThan(text.indexOf('## Previous conversation'));
  });

  it('tells a lost conversation and a relocated one, with and without a summary', () => {
    const lost = brief({
      previousConversation: { reason: 'lost', fromProvider: null, summary: null, lastNote: null },
    });
    expect(lost).toContain('Your earlier conversation on this card was lost');
    expect(lost).toContain('No summary of the earlier conversation is available.');
    const relocated = brief({
      previousConversation: { reason: 'relocated', fromProvider: null, summary: summary(), lastNote: null },
    });
    expect(relocated).toContain('ran in another working directory');
    expect(relocated).toContain('> I finished the form.');
  });

  it('adds the latest handoff note of the card to the previous conversation', () => {
    const text = brief({
      previousConversation: {
        reason: 'lost',
        fromProvider: null,
        summary: null,
        lastNote: { from: 'dev', endedAt: '2026-10-05T10:00:00.000Z', text: 'Left: tests.' },
      },
    });
    expect(text).toContain(
      'The latest handoff note on this card, from `dev` at 2026-10-05T10:00:00.000Z:\n> Left: tests.',
    );
  });

  it('keeps the previous conversation out of the first message of a resumed conversation', () => {
    const standing = builder.build(
      input({
        handle: 'fe-1',
        handoff: takeover(),
        previousConversation: { reason: 'lost', fromProvider: null, summary: null, lastNote: null },
      }),
    ).standing!;
    expect(standing).not.toContain('Previous conversation');
  });

  it('words the instruction to hand over and the call-off', () => {
    const instruction = builder.handoffInstruction({
      taskKey: 'AR-21',
      to: 'dev',
      toProvider: 'codex',
      deadlineAt: '2026-10-05T10:10:00.000Z',
    });
    expect(instruction).toContain('AR-21 is being handed over to `dev` (Codex)');
    expect(instruction).toContain('Do not start new work');
    expect(instruction).toContain('hand_off');
    expect(instruction).toContain('Name anything that stays uncommitted');
    expect(instruction).toContain('due by 2026-10-05T10:10:00.000Z');
    expect(instruction).toContain('only your note');
    const nobody = builder.handoffInstruction({
      taskKey: 'AR-21',
      to: null,
      toProvider: null,
      deadlineAt: null,
    });
    expect(nobody).toContain('handed over to nobody');
    expect(nobody).not.toContain('due by');
    expect(builder.handoffCancelled({ taskKey: 'AR-21' })).toBe(
      'The handover of AR-21 is called off: the card stays with you. Carry on where you left off.',
    );
  });
});
