import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS } from '@projectman/shared';
import type {
  Actor,
  AiMemberConfig,
  MemberView,
  ProjectConfig,
  Task,
  TimelineEvent,
  TimelineEventType,
  WorkItemRef,
} from '@projectman/shared';
import { aiMemberDefaults, getTemplate } from '@projectman/templates';
import type { ContextPackInput } from '../contracts';
import { createContextPackBuilder } from './context-pack';
import { formatMemoryEntry, MEMORY_LIMIT_BYTES } from './memory';
import { roleLabel } from './system-prompt';

const builder = createContextPackBuilder();

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
    priority: 2,
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
  event('2026-09-28T11:32:00.000Z', 'fe-1', 'task_check_changed', {
    check: 'code_review',
    from: null,
    to: 'pending',
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
    ...rest,
  };
}

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
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot(
      '__snapshots__/developer-dev.system-prompt.txt',
    );
    await expect(pack.initialMessage).toMatchFileSnapshot('__snapshots__/developer-dev.brief.txt');
  });

  it('code reviewer reviewing a pull request', async () => {
    const pack = builder.build(input({ handle: 'code-review' }));
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot(
      '__snapshots__/code-review-code_review.system-prompt.txt',
    );
    await expect(pack.initialMessage).toMatchFileSnapshot('__snapshots__/code-review-code_review.brief.txt');
  });

  it('DevOps releasing an approved task', async () => {
    const pack = builder.build(
      input({
        handle: 'devops',
        task: makeTask({
          stageId: 'release',
          labels: ['code-review-ok', 'qa-ok', 'client-accepted', 'release-approved'],
          links: makeTask().links.map((l) => (l.kind === 'pull_request' ? { ...l, state: 'merged' } : l)),
        }),
        memory: '',
      }),
    );
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot(
      '__snapshots__/devops-release.system-prompt.txt',
    );
    await expect(pack.initialMessage).toMatchFileSnapshot('__snapshots__/devops-release.brief.txt');
  });

  it('QA in a general chat', async () => {
    const pack = builder.build(
      input({ handle: 'qa', workItem: { type: 'general' }, task: null, stage: null, timeline: [] }),
    );
    expect(pack.initialMessage).toBeNull();
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot('__snapshots__/qa-general.system-prompt.txt');
  });
});

describe('context pack builder', () => {
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

  it('is deterministic', () => {
    const first = builder.build(input());
    const second = builder.build(structuredClone(input()));
    expect(second).toEqual(first);
  });

  it('introduces the member, the team and the sponsor', () => {
    const prompt = builder.build(input({ handle: 'fe-1' })).appendSystemPrompt;
    expect(prompt).toContain(
      "You are Frontend developer (handle `fe-1`), the developer (Frontend) of the Acme Web team (project key `AR`); you run on Anna Example's Claude subscription.",
    );
    expect(prompt).toContain('- `owner`: Anna Example (human, owner; roles: operator, product owner)');
    expect(prompt).toContain('- `fe-1`: Frontend developer (AI, developer, Frontend) ← you');
    expect(prompt.match(/← you/g)).toHaveLength(1);
  });

  it('tells the member to write in the project language', () => {
    const hungarian = builder.build(input({ project: buildProject('web-client-project', 'hu') }));
    expect(hungarian.appendSystemPrompt).toContain("in Hungarian (`hu`), the project's language");
    const english = builder.build(input());
    expect(english.appendSystemPrompt).toContain("in English (`en`), the project's language");
  });

  it('keeps the guardrails for every member', () => {
    for (const handle of ['fe-1', 'qa', 'devops', 'communication']) {
      const prompt = builder.build(input({ handle })).appendSystemPrompt;
      expect(prompt).toContain('- Never approve a gate');
      expect(prompt).toContain('- Never release to production');
      expect(prompt).toContain('ask with ask_human instead of guessing');
      expect(prompt).toContain('- Never put secrets');
    }
    expect(builder.build(input({ handle: 'code-review' })).appendSystemPrompt).toContain(
      '- You never edit code, commit or push: you only report.',
    );
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
    const section = prompt.slice(prompt.indexOf('# Your memory'));
    expect(section).toContain('(Older entries are not shown.)');
    expect(section).toContain('Learning 59:');
    expect(section).not.toContain('Learning 0:');
    const shown = section.slice(section.indexOf('## '));
    expect(shown.startsWith('## 2026-01-01T')).toBe(true);
    expect(Buffer.byteLength(shown)).toBeLessThanOrEqual(MEMORY_LIMIT_BYTES);
  });

  it('says so when the memory is empty', () => {
    const prompt = builder.build(input({ memory: '  \n' })).appendSystemPrompt;
    expect(prompt).toContain('# Your memory\nNothing saved yet');
  });

  it('writes a brief only for known tasks', () => {
    expect(
      builder.build(input({ workItem: { type: 'general' }, task: null, stage: null })).initialMessage,
    ).toBeNull();
    const meeting: WorkItemRef = { type: 'meeting', meetingId: 'standup-2026-09-29' };
    const inMeeting = builder.build(input({ workItem: meeting, task: null, stage: null }));
    expect(inMeeting.initialMessage).toBeNull();
    expect(inMeeting.appendSystemPrompt).toContain('A team meeting (`standup-2026-09-29`)');
    const unknown = builder.build(input({ task: null, stage: null }));
    expect(unknown.initialMessage).toBeNull();
    expect(unknown.appendSystemPrompt).toContain('Task `AR-21`. Its details were not available');
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
    expect(noteLine.length).toBeLessThan(360);
  });

  it('cuts very long descriptions', () => {
    const brief =
      builder.build(input({ task: makeTask({ description: 'z'.repeat(20_000) }) })).initialMessage ?? '';
    expect(brief).toContain('(The description continues; read it with get_task.)');
    expect(brief.length).toBeLessThan(14_000);
  });

  it('asks a developer in the queue to start the work stage', () => {
    const pack = builder.build(
      input({ handle: 'be-1', task: makeTask({ stageId: 'ready', assignee: 'be-1' }) }),
    );
    expect(pack.initialMessage).toContain(
      '1. Move the task to Development (`dev`) with update_task as you start.',
    );
    expect(pack.initialMessage).toContain(
      'Move the task to Code review (`code_review`) with update_task and hand over to `code-review`',
    );
  });

  it('does not mention a worktree when the task has no repo', () => {
    const pack = builder.build(input({ handle: 'fe-1', task: makeTask({ stageId: 'dev', repo: null }) }));
    expect(pack.initialMessage).toContain(
      "2. Implement the change in your working directory and run the project's tests.",
    );
    expect(pack.initialMessage).toContain('- Repo: the workspace root');
  });

  it('sends feedback work back to the assignee', () => {
    const pack = builder.build(input({ handle: 'fe-1', task: makeTask({ stageId: 'qa' }) }));
    expect(pack.initialMessage).toContain('The task is past development (now in QA (`qa`)).');
  });

  it('tells a non-owner to do what was asked', () => {
    const pack = builder.build(input({ handle: 'devops', task: makeTask({ stageId: 'code_review' }) }));
    expect(pack.appendSystemPrompt).toContain('you do not own this stage');
    expect(pack.initialMessage).toContain('Do the deployment or operations work you were asked for');
  });

  it('requests an approval gate through update_task instead of approving', () => {
    const project = buildProject('small-team');
    const pack = builder.build(input({ project, handle: 'code-review' }));
    expect(pack.initialMessage).toContain(
      'When the review passes, request the move to Done (`done`) with update_task: it needs a human approval (`merge-approved` (Merge approved)), so the system opens a decision for `owner` and the task waits until they approve. Do not message them separately and never set that label yourself.',
    );
  });

  it('hands the client test draft to the human owners', () => {
    const pack = builder.build(
      input({ handle: 'communication', task: makeTask({ stageId: 'client_test' }) }),
    );
    expect(pack.initialMessage).toContain('Hand the draft to a human with send_message');
    expect(pack.initialMessage).toContain('record the result with update_task as `client-accepted`');
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
    expect(prompt).toContain('- `owner`: Anna Example (human, owner; roles: operator, product owner)');
  });
});

describe('context pack for the role catalogue', () => {
  const dataSteward = {
    id: 'data_steward',
    name: 'Data steward',
    summary: 'Keeps the reference data clean.',
    notTheirJob: 'Does not change the database schema.',
    holders: 'both' as const,
    instructions: 'Check the reference tables for duplicates and report them to the owner.',
  };

  it('business analyst refining a task in the queue', async () => {
    const project = buildProject();
    addMember(project, 'analyst', 'business_analyst', { displayName: 'Business analyst' });
    const pack = builder.build(
      input({
        project,
        handle: 'analyst',
        task: makeTask({ stageId: 'ready', assignee: null, links: [] }),
        timeline: timeline.slice(0, 1),
        memory: '',
      }),
    );
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot(
      '__snapshots__/business-analyst-ready.system-prompt.txt',
    );
    await expect(pack.initialMessage).toMatchFileSnapshot('__snapshots__/business-analyst-ready.brief.txt');
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
    await expect(pack.appendSystemPrompt).toMatchFileSnapshot(
      '__snapshots__/custom-role-general.system-prompt.txt',
    );
  });

  it('describes a custom role with its own texts and follows its instructions', () => {
    const project = buildProject();
    project.team.roles.push(dataSteward);
    addMember(project, 'steward', 'data_steward', { displayName: 'Dora' });
    const prompt = builder.build(input({ project, handle: 'steward' })).appendSystemPrompt;
    expect(prompt).toContain('You are Dora (handle `steward`), the Data steward of the Acme Web team');
    expect(prompt).toContain('- `steward`: Dora (AI, Data steward) ← you');
    expect(prompt).toContain(dataSteward.instructions);
    expect(prompt).not.toContain('Research a focused question');
    // A custom role owns no stage here: it reports back to whoever asked.
    expect(prompt).toContain('you do not own this stage');
  });

  it.each(AI_BUILT_IN_ROLE_IDS)('gives the %s concrete steps with the team tools', (role) => {
    const project = buildProject();
    const member = addMember(project, 'member', role, { displayName: 'Member' });
    (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push(member.handle);
    const pack = builder.build(
      input({ project, handle: 'member', task: makeTask({ stageId: 'dev', assignee: 'member' }) }),
    );
    expect(pack.appendSystemPrompt).toContain(`the ${roleLabel(role)} of the Acme Web team`);
    const expected = (pack.initialMessage ?? '').split('## What is expected next\n')[1] ?? '';
    expect(expected).toMatch(/send_message|update_task|ask_human|create_task|get_task|link_pull_request/);
  });

  it('has the analyst, the architect and support leave queued work for the product owner to prioritise', () => {
    for (const [role, step] of [
      ['business_analyst', 'Rewrite the description with update_task'],
      ['architect', 'Add the technical plan to the description with update_task'],
      ['support', 'Complete the description with update_task'],
    ] as const) {
      const project = buildProject();
      addMember(project, 'member', role);
      const brief =
        builder.build(
          input({ project, handle: 'member', task: makeTask({ stageId: 'ready', assignee: null }) }),
        ).initialMessage ?? '';
      expect(brief, role).toContain(step);
      expect(brief, role).toContain(
        'Tell `owner` with send_message that the task is ready to be prioritised; leave it in Ready (`ready`).',
      );
    }
  });

  it('builds maintenance work in the task worktree and hands it over', () => {
    const project = buildProject();
    addMember(project, 'maintainer', 'maintainer');
    (project.pipeline.stages.find((s) => s.id === 'dev')!.owners ??= []).push('maintainer');
    const brief =
      builder.build(
        input({ project, handle: 'maintainer', task: makeTask({ stageId: 'dev', assignee: 'maintainer' }) }),
      ).initialMessage ?? '';
    expect(brief).toContain(
      "1. Make the maintenance change the task describes in your working directory (the task's own worktree and branch), small and focused, and run the project's tests.",
    );
    expect(brief).toContain('2. Commit, push, open a pull request and attach it with link_pull_request.');
    expect(brief).toContain(
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

    const watchdog = builder.build(input({ project, handle: 'watchdog' })).initialMessage ?? '';
    expect(watchdog).toContain('Flag anything wrong to `ops` with send_message');
    expect(watchdog).toContain('do not intervene');
    const pm = builder.build(input({ project, handle: 'pm' })).initialMessage ?? '';
    expect(pm).toContain('ask `owner` with ask_human; do not reorder the work yourself');
    expect(builder.build(input({ project, handle: 'pm' })).appendSystemPrompt).toContain(
      '- `ops`: Ops (human, admin; roles: operator)',
    );
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
    expect(prompt.indexOf('Write accurate documentation')).toBeLessThan(
      prompt.indexOf('Research a focused question'),
    );
    expect(prompt.indexOf('Research a focused question')).toBeLessThan(
      prompt.indexOf('Explain the examples.'),
    );
    expect(prompt.indexOf('Explain the examples.')).toBeLessThan(prompt.indexOf('Use small examples.'));
    expect(prompt).not.toContain('Implement the task');
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
    expect(custom).toContain('Write accurate documentation');
    expect(custom).toContain('Keep a glossary.');
  });
});
