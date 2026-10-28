import { describe, expect, it } from 'vitest';
import { priorityRefusal } from '../domain/task';
import { integratorConfigRefusal } from './integrator';
import { applyConfigPatch, PatchConfigRequest } from './edit';
import { OPERATOR_WATCH_LEVELS, operatorWatchOf } from './operator-watch';
import { ownerOnlyChanges } from './owner-only';
import { ConfigChangeRow, OperatorLevel, operatorAutonomousLevel, operatorConfigVerdict } from './operator';
import type { OperatorConfigVerdict } from './operator';
import { actorMoveRefusal } from './project-manager';
import { AiMemberConfig, ProjectConfig } from './schema';
import { DEFAULT_NEW_MEMBER_APPROVER, DEFAULT_PERMISSION_MODE } from '../domain/member';
import { cardMerger, mergerOf } from './merger';
import { integratorSideAvailable } from '../domain/member-queue';

/** The member the verdicts treat as the acting one: it has a role of its own, so its own rows can be told apart. */
const ACTING = 'operator';
const ACTING_ROLE = 'business_analyst';

describe('integratorSideAvailable (PM-1045)', () => {
  it('is available while an owner has a live super key, whatever members the team has', () => {
    const c = config();
    expect(integratorSideAvailable(c, (email) => email === 'owner@example.com')).toBe(true);
    c.team.members = c.team.members.filter((member) => member.handle !== ACTING);
    expect(integratorSideAvailable(c, (email) => email === 'owner@example.com')).toBe(true);
  });

  it('is not available when no owner has a live (not revoked, not expired) super key', () => {
    expect(integratorSideAvailable(config(), () => false)).toBe(false);
  });

  it('asks only about owners: another person with a key does not count', () => {
    expect(integratorSideAvailable(config(), (email) => email === 'ann@example.com')).toBe(false);
  });
});

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'AC',
      name: 'Acme',
      workspacePath: '/work/acme',
      repos: [{ name: 'web', path: 'web' }],
    },
    team: {
      members: [
        {
          kind: 'human',
          handle: 'owner',
          displayName: 'Owner',
          access: 'owner',
          email: 'owner@example.com',
          roles: ['operator'],
        },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer', email: 'ann@example.com' },
        { kind: 'ai', handle: ACTING, displayName: 'Acting', role: ACTING_ROLE, sponsor: 'owner' },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'writer',
          displayName: 'Writer',
          role: 'content',
          model: 'opus',
          sponsor: 'owner',
        },
        { kind: 'ai', handle: 'devops', displayName: 'Devops', role: 'devops', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      roles: [
        {
          id: 'checker',
          name: 'Checker',
          summary: 'Checks the work.',
          holders: 'ai',
          duties: ['code_review'],
        },
      ],
      roleOverrides: {
        qa: { duties: ['testing_acceptance'], instructions: 'Test it.' },
        [ACTING_ROLE]: { duties: ['project_operation'], instructions: 'Be careful.' },
      },
      limits: { maxConcurrentAi: 3 },
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', columnId: 'all' },
        {
          id: 'review',
          name: 'Review',
          kind: 'step',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'merge-ok' }] },
        },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [
        { id: 'merge-ok', name: 'Merge ok', setBy: { members: ['owner'], humansOnly: true } },
        { id: 'ui', name: 'UI' },
      ],
    },
  });
}

const member = (c: ProjectConfig, handle: string) => {
  const found = c.team.members.find((m) => m.handle === handle);
  if (!found) throw new Error(`no member ${handle}`);
  return found;
};
const ai = (c: ProjectConfig, handle: string) => {
  const found = member(c, handle);
  if (found.kind !== 'ai') throw new Error(`${handle} is not an AI member`);
  return found;
};
const stage = (c: ProjectConfig, id: string) => {
  const found = c.pipeline.stages.find((s) => s.id === id);
  if (!found) throw new Error(`no stage ${id}`);
  return found;
};

describe('approval waiver eligibility (PM-691)', () => {
  describe('indirect merger changes and gate order', () => {
    const reviewed = () => {
      const c = config();
      ai(c, 'dev-1').role = 'code_review';
      ai(c, 'writer').role = 'code_review';
      stage(c, 'dev').owners = ['ann'];
      stage(c, 'review').owners = ['dev-1'];
      return c;
    };
    const expectClick = (previous: ProjectConfig, next: ProjectConfig) => {
      // These changes do not touch the stored merger or a gate definition.
      expect(previous.team.merger).toEqual(next.team.merger);
      expect(ownerOnlyChanges(previous, next)).toEqual([]);
      for (const [a, b] of [
        [previous, next],
        [next, previous],
      ] as const)
        expect(operatorConfigVerdict(a, b, { operator: 'operator' })).toMatchObject({
          level: 'approval',
          waiverEligible: false,
        });
    };
    it('requires a click when a stage kind resolves a previously unresolved explicit merger', () => {
      const previous = reviewed();
      previous.team.merger = { kind: 'code_reviewer' };
      stage(previous, 'review').kind = 'queue';
      const next = structuredClone(previous);
      stage(next, 'review').kind = 'step';
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBeNull();
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('dev-1');
      expectClick(previous, next);
    });
    it('requires a click when review owners change the resolved merger', () => {
      const previous = reviewed();
      previous.team.merger = { kind: 'code_reviewer' };
      const next = structuredClone(previous);
      stage(next, 'review').owners = ['writer'];
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBe('dev-1');
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('writer');
      expectClick(previous, next);
    });
    it('requires a click when review owners switch the implicit merger to the developer', () => {
      const previous = reviewed();
      const next = structuredClone(previous);
      delete stage(next, 'review').owners;
      expect(mergerOf(previous)).toEqual({ kind: 'code_reviewer' });
      expect(mergerOf(next)).toEqual({ kind: 'developer' });
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBe('dev-1');
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('ann');
      expectClick(previous, next);
    });
    it('protects every reviewer choice, even when the fallback merger stays the same', () => {
      const previous = reviewed();
      previous.team.merger = { kind: 'code_reviewer' };
      stage(previous, 'review').owners = ['dev-1', 'writer'];
      const next = structuredClone(previous);
      stage(next, 'review').owners = ['dev-1'];
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBe('dev-1');
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('dev-1');
      expect(cardMerger(previous, { assignee: 'ann' }, 'writer')).toBe('writer');
      expect(cardMerger(next, { assignee: 'ann' }, 'writer')).toBe('dev-1');
      expectClick(previous, next);
    });
    it('requires a click for a stage reorder that moves a gate before work', () => {
      const previous = config();
      const next = structuredClone(previous);
      next.pipeline.stages = ['backlog', 'review', 'dev', 'done'].map((id) => stage(next, id));
      expectClick(previous, next);
    });
    it('requires a click when an inserted review stage changes the selected merger', () => {
      const previous = reviewed();
      const next = structuredClone(previous);
      next.pipeline.stages.splice(3, 0, {
        id: 'second_review',
        name: 'Second review',
        kind: 'step',
        columnId: 'all',
        owners: ['writer'],
      });
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBe('dev-1');
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('writer');
      expectClick(previous, next);
    });
    it('requires a click when a new merge target changes where merging is required', () => {
      const previous = config();
      const next = structuredClone(previous);
      next.pipeline.stages.splice(2, 0, {
        id: 'early_done',
        name: 'Early done',
        kind: 'done',
        columnId: 'all',
      });
      expectClick(previous, next);
    });
    it('protects resolved merger changes caused by member order and a mixed leave patch', () => {
      const previous = reviewed();
      previous.team.merger = { kind: 'code_reviewer' };
      stage(previous, 'review').duty = 'code_review';
      delete stage(previous, 'review').owners;
      const next = structuredClone(previous);
      next.team.members.reverse();
      expect(cardMerger(previous, { assignee: 'ann' }, null)).toBe('writer');
      expect(cardMerger(next, { assignee: 'ann' }, null)).toBe('dev-1');
      expectClick(previous, next);
      const leave = structuredClone(previous);
      leave.project.name = 'Changed';
      ai(leave, 'writer').onLeave = true;
      expect(cardMerger(leave, { assignee: 'ann' }, null)).toBe('dev-1');
      expectClick(previous, leave);
    });
    it('keeps safe stage metadata and board column order eligible', () => {
      const previous = reviewed();
      previous.pipeline.columns.push({ id: 'extra', name: 'Extra' });
      const next = structuredClone(previous);
      stage(next, 'review').description = 'Review the work';
      next.pipeline.columns.reverse();
      expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toMatchObject({
        level: 'approval',
        waiverEligible: true,
      });
    });
  });
  const allowed: Array<[string, (next: ProjectConfig) => void]> = [
    ['project name', (n) => (n.project.name = 'Renamed')],
    ['language', (n) => (n.project.language = 'en')],
    ['timezone', (n) => (n.project.timezone = 'Europe/Budapest')],
    ['template', (n) => (n.project.templateId = 'custom')],
    ['card mover', (n) => (n.team.cardMover = { kind: 'project_manager' })],
    ['project manager moves', (n) => (n.team.projectManagerMoves = 'start_only')],
    ['display name', (n) => (ai(n, 'writer').displayName = 'Author')],
    ['specialty', (n) => (ai(n, 'writer').specialty = 'Documentation')],
    ['provider', (n) => (ai(n, 'writer').provider = 'codex')],
    ['model', (n) => (ai(n, 'writer').model = 'sonnet')],
    ['effort', (n) => (ai(n, 'writer').effort = 'high')],
    ['member compaction', (n) => (ai(n, 'writer').autoCompactWindowTokens = 300000)],
    ['cheap subagent', (n) => (ai(n, 'writer').cheapSubagent = 'haiku')],
    ['capacity', (n) => (ai(n, 'writer').capacity = 2)],
    ['sponsor', (n) => (ai(n, 'writer').sponsor = 'ann')],
    ['leave', (n) => (ai(n, 'writer').onLeave = true)],
    ['schedule', (n) => (ai(n, 'writer').schedule = { cron: '0 9 * * *', prompt: 'Write.' })],
    ['ordinary role', (n) => (ai(n, 'writer').role = 'developer')],
    [
      'ordinary duties',
      (n) => (n.team.roleOverrides!.content = { duties: ['content', 'docs'], instructions: '' }),
    ],
    ['role text', (n) => (n.team.roles[0]!.summary = 'Implement changes.')],
    ['role instructions', (n) => (n.team.roles[0]!.instructions = 'Be concise.')],
    ['AI enablement', (n) => (n.team.limits.aiEnabled = false)],
    ['concurrency', (n) => (n.team.limits.maxConcurrentAi = 4)],
    ['usage threshold', (n) => (n.team.limits.pauseAbovePlanUsagePercent = 90)],
    ['token warning', (n) => (n.team.limits.warnAboveSessionTokens = 50000)],
    ['disk threshold', (n) => (n.team.limits.minFreeDiskGb = 20)],
    ['project compaction', (n) => (n.team.limits.autoCompactWindowTokens = 300000)],
    ['loop watch', (n) => (n.team.limits.loopWatch = { enabled: true, count: 5, minutes: 20 })],
    ['fix rounds', (n) => (n.team.limits.maxFixRounds = 4)],
    ['senior wait', (n) => (n.team.limits.seniorWaitMinutes = 30)],
    [
      'ordinary temp workers',
      (n) => (n.team.limits.tempWorkers = { enabled: true, max: 2, role: 'developer' }),
    ],
    ['stage description', (n) => (stage(n, 'dev').description = 'Implementation')],
    ['stage owners', (n) => (stage(n, 'dev').owners = ['dev-1'])],
    ['ordinary stage duty', (n) => (stage(n, 'dev').duty = 'implementation')],
    ['column hint', (n) => (n.pipeline.columns[0]!.hint = 'Work')],
    [
      'plain label rules',
      (n) =>
        Object.assign(n.pipeline.labels[1]!, { meaning: 'Interface', blocks: true, requiresComment: true }),
    ],
    ['plain label addition', (n) => n.pipeline.labels.push({ id: 'new-tag', name: 'Tag', setBy: 'anyone' })],
    ['plain label removal', (n) => n.pipeline.labels.splice(1, 1)],
    [
      'stage addition',
      (n) =>
        n.pipeline.stages.splice(1, 0, { id: 'planning', name: 'Planning', kind: 'queue', columnId: 'all' }),
    ],
    [
      'ordinary role addition',
      (n) =>
        n.team.roles.push({
          id: 'helper',
          name: 'Helper',
          summary: 'Helps.',
          holders: 'ai',
          duties: ['implementation'],
          instructions: '',
          notTheirJob: '',
        }),
    ],
  ];
  it.each(allowed)('waives %s and its revert without changing the approval level', (_name, edit) => {
    const previous = config();
    const next = structuredClone(previous);
    next.project.name = 'Changed'; // Include an approval field even when the tested field is already now.
    edit(next);
    for (const [a, b] of [
      [previous, next],
      [next, previous],
    ] as const) {
      expect(operatorConfigVerdict(a, b, { operator: 'operator' })).toMatchObject({
        level: 'approval',
        waiverEligible: true,
      });
    }
  });

  const protectedFields: Array<[string, (next: ProjectConfig) => void]> = [
    ['permission mode', (n) => (ai(n, 'writer').permissionMode = 'acceptEdits')],
    ['AI approver', (n) => (ai(n, 'writer').approver = 'ai')],
    ['network', (n) => (ai(n, 'writer').outboundNetwork = false)],
    ['GitHub identity', (n) => (ai(n, 'writer').githubLogin = 'different-author')],
    ['member instructions', (n) => (ai(n, 'writer').instructions = 'Use another workflow.')],
    ['temporary status', (n) => (ai(n, 'writer').temp = true)],
    ['complexity limit', (n) => (ai(n, 'writer').complexityLimit = 13)],
    ['workspace', (n) => (n.project.workspacePath = '/elsewhere')],
    ['repository', (n) => (n.project.repos[0]!.path = 'other')],
    ['new repository', (n) => n.project.repos.push({ name: 'new', path: 'new', defaultBranch: 'main' })],
    [
      'review test',
      (n) => (n.project.repos[0]!.reviewTest = { command: 'npm test', maxWorkers: 2, timeoutMinutes: 15 }),
    ],
    ['merger', (n) => (n.team.merger = { kind: 'developer' })],
    ['boundary', (n) => (n.team.boundary = { enabled: true, leadTimeoutSeconds: 120 })],
    ['operator watch', (n) => (n.team.operatorWatch = 'drive')],
    ['waiver switch', (n) => (n.team.operatorApprovalWaiver = true)],
    ['operator model', (n) => (ai(n, 'operator').model = 'sonnet')],
    ['operator provider', (n) => (ai(n, 'operator').provider = 'codex')],
    ['operator effort', (n) => (ai(n, 'operator').effort = 'high')],
    ['gate removal', (n) => delete stage(n, 'review').gate],
    [
      'non-approval gate addition',
      (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    ],
    [
      'new stage containing a gate',
      (n) =>
        n.pipeline.stages.splice(1, 0, {
          id: 'extra',
          name: 'Extra',
          kind: 'queue',
          columnId: 'all',
          gate: { conditions: [{ type: 'has_label', label: 'ui' }] },
        }),
    ],
    ['label setter', (n) => (n.pipeline.labels[1]!.setBy = { members: ['writer'] })],
    [
      'new restricted label',
      (n) => n.pipeline.labels.push({ id: 'restricted', name: 'Restricted', setBy: { members: ['owner'] } }),
    ],
    ['approval label text', (n) => (n.pipeline.labels[0]!.name = 'Approval')],
    ['review duty removal without a gate', (n) => (n.team.roles[0]!.duties = ['implementation'])],
    ['review role assignment', (n) => (ai(n, 'writer').role = 'code_review')],
    ['security role assignment', (n) => (ai(n, 'writer').role = 'security_review')],
    ['QA role assignment', (n) => (ai(n, 'writer').role = 'qa')],
    ['UX role assignment', (n) => (ai(n, 'writer').role = 'designer')],
    ['review stage duty', (n) => (stage(n, 'dev').duty = 'code_review')],
    ['boundary role assignment', (n) => (ai(n, 'writer').role = 'lead_developer')],
    [
      'boundary role definition',
      (n) =>
        n.team.roles.push({
          id: 'decider',
          name: 'Decider',
          summary: 'Decides.',
          holders: 'ai',
          duties: ['boundary_authorization'],
          instructions: '',
          notTheirJob: '',
        }),
    ],
    [
      'boundary override',
      (n) => (n.team.roleOverrides!.developer = { duties: ['boundary_authorization'], instructions: '' }),
    ],
    ['release duty', (n) => (n.team.roles[0]!.duties = ['release_approval'])],
    ['final decision duty', (n) => (n.team.roles[0]!.duties = ['final_decision'])],
    [
      'temp authorization',
      (n) => (n.team.limits.tempWorkers = { enabled: true, max: 1, role: 'lead_developer' }),
    ],
    ['unknown root', (n) => Object.assign(n, { remoteAccess: true })],
    ['unknown project', (n) => Object.assign(n.project, { clientSharing: true })],
    ['unknown team', (n) => Object.assign(n.team, { integrator: true })],
    ['unknown AI field', (n) => Object.assign(ai(n, 'writer'), { bypass: true })],
    [
      'unknown nested schedule',
      (n) => Object.assign(ai(n, 'writer'), { schedule: { cron: '0 9 * * *', prompt: 'Hi', remote: true } }),
    ],
    ['unknown limit', (n) => Object.assign(n.team.limits, { guestSharing: true })],
    ['unknown nested limit', (n) => Object.assign(n.team.limits.tempWorkers, { permissionMode: 'auto' })],
    ['unknown stage', (n) => Object.assign(stage(n, 'dev'), { remoteAccess: true })],
    ['unknown pipeline', (n) => Object.assign(n.pipeline, { clientSharing: true })],
  ];
  it.each(protectedFields)('requires a click for %s even in a mixed patch and revert', (_name, edit) => {
    const previous = config();
    const next = structuredClone(previous);
    next.project.name = 'Changed';
    edit(next);
    for (const [a, b] of [
      [previous, next],
      [next, previous],
    ] as const)
      expect(operatorConfigVerdict(a, b, { operator: 'operator' }).waiverEligible).toBe(false);
  });

  const hire = (extra: object = {}) => {
    const previous = config();
    const next = structuredClone(previous);
    next.team.members.push(
      AiMemberConfig.parse({
        kind: 'ai',
        handle: 'new-ai',
        displayName: 'New AI',
        role: 'developer',
        sponsor: 'owner',
        permissionMode: DEFAULT_PERMISSION_MODE,
        approver: DEFAULT_NEW_MEMBER_APPROVER,
        ...extra,
      }),
    );
    return { previous, next, result: operatorConfigVerdict(previous, next, { operator: 'operator' }) };
  };
  it('waives a new AI with exactly the template permissions', () => {
    const { previous, next, result } = hire();
    expect(result).toMatchObject({ level: 'approval', waiverEligible: true });
    expect(result.changes).toEqual([
      { area: 'member', target: 'new-ai', field: '*', before: null, after: 'developer', level: 'approval' },
    ]);
    expect(operatorConfigVerdict(next, previous, { operator: 'operator' }).waiverEligible).toBe(true);
  });
  it.each([
    ['githubLogin', 'different-author'],
    ['instructions', 'Use another workflow.'],
    ['temp', true],
    ['complexityLimit', 13],
  ])('requires a click when a presence change includes non-whitelisted %s', (field, value) => {
    const { previous, next, result } = hire({ [String(field)]: value });
    expect(result.waiverEligible).toBe(false);
    expect(operatorConfigVerdict(next, previous, { operator: 'operator' }).waiverEligible).toBe(false);
  });
  it.each([
    ['permissionMode', 'default', DEFAULT_PERMISSION_MODE],
    ['approver', 'human', DEFAULT_NEW_MEMBER_APPROVER],
    ['approver', 'ai', DEFAULT_NEW_MEMBER_APPROVER],
    ['approver', undefined, DEFAULT_NEW_MEMBER_APPROVER],
    ['outboundNetwork', false, true],
  ])('shows a separate new AI permission row for %s=%s', (field, value, baseline) => {
    const { result } = hire({ [field as string]: value });
    expect(result.waiverEligible).toBe(false);
    expect(result.changes).toContainEqual({
      area: 'member',
      target: 'new-ai',
      field,
      before: String(baseline),
      after: String(field === 'approver' && value === undefined ? 'human' : value),
      level: 'approval',
    });
  });
  it('checks authorization inside a new AI presence row', () => {
    expect(hire({ role: 'lead_developer' }).result.waiverEligible).toBe(false);
  });
  it.each(['code_review', 'security_review', 'qa', 'designer'])(
    'requires a click to hire a reviewer in role %s without a gate',
    (role) => {
      expect(hire({ role }).result.waiverEligible).toBe(false);
    },
  );
  it.each(['code_review', 'security_review', 'qa', 'designer'])(
    'requires a click for reviewer temp workers in role %s',
    (role) => {
      const previous = config();
      const next = structuredClone(previous);
      next.team.limits.tempWorkers = { enabled: true, max: 1, role };
      expect(operatorConfigVerdict(previous, next, { operator: 'operator' }).waiverEligible).toBe(false);
      expect(operatorConfigVerdict(next, previous, { operator: 'operator' }).waiverEligible).toBe(false);
    },
  );
  it.each(['gate', 'notByAuthor'] as const)(
    'protects AI approval labels recognized by %s in both end states',
    (kind) => {
      const previous = config();
      const label = previous.pipeline.labels[1]!;
      label.setBy = { duties: ['content'] };
      if (kind === 'gate')
        stage(previous, 'dev').gate = { conditions: [{ type: 'has_label', label: label.id }] };
      else label.notByAuthor = true;
      const next = structuredClone(previous);
      next.pipeline.labels[1]!.name = 'Renamed';
      for (const [a, b] of [
        [previous, next],
        [next, previous],
      ] as const)
        expect(operatorConfigVerdict(a, b, { operator: 'operator' }).waiverEligible).toBe(false);
      const removed = structuredClone(previous);
      delete removed.pipeline.labels[1]!.notByAuthor;
      removed.pipeline.labels.splice(1, 1);
      expect(operatorConfigVerdict(previous, removed, { operator: 'operator' }).waiverEligible).toBe(false);
      if (kind === 'notByAuthor') {
        const cleared = structuredClone(previous);
        delete cleared.pipeline.labels[1]!.notByAuthor;
        expect(operatorConfigVerdict(previous, cleared, { operator: 'operator' }).waiverEligible).toBe(false);
      }
      const reassigned = structuredClone(previous);
      ai(reassigned, 'dev-1').role = 'content'; // Same label definition, different actual holders.
      expect(operatorConfigVerdict(previous, reassigned, { operator: 'operator' }).waiverEligible).toBe(
        false,
      );
    },
  );
  it('requires a click when an implementer hire gains an AI approval label', () => {
    const { previous, next } = hire();
    for (const config of [previous, next]) {
      config.pipeline.labels[1]!.notByAuthor = true;
      config.pipeline.labels[1]!.setBy = { duties: ['implementation'] };
    }
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' }).waiverEligible).toBe(false);
  });
  it('does not make a now or never verdict eligible, with either waiver setting', () => {
    for (const enabled of [false, true]) {
      const previous = config();
      previous.team.operatorApprovalWaiver = enabled;
      const next = structuredClone(previous);
      ai(next, 'writer').model = 'sonnet';
      expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toMatchObject({
        level: 'now',
        waiverEligible: false,
      });
      member(next, 'ann').displayName = 'Changed';
      expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toMatchObject({
        level: 'never',
        waiverEligible: false,
      });
    }
  });
  it('normalizes missing and explicit default permission settings', () => {
    const previous = config();
    const next = structuredClone(previous);
    Object.assign(ai(next, 'writer'), { approver: 'human', outboundNetwork: true, provider: 'claude' });
    next.team.operatorApprovalWaiver = false;
    expect(ownerOnlyChanges(previous, next)).toEqual([]);
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toEqual({
      level: 'now',
      changes: [],
      waiverEligible: false,
    });
    const { result } = hire({ outboundNetwork: true });
    expect(result.waiverEligible).toBe(true);
  });
  it('holds a contacts change for the owner’s approval and never makes it waivable (PM-985)', () => {
    const previous = config();
    previous.team.operatorApprovalWaiver = true;
    const next = structuredClone(previous);
    next.team.contacts = ['ann'];
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toMatchObject({
      level: 'approval',
      changes: [expect.objectContaining({ field: 'contacts', level: 'approval' })],
      waiverEligible: false,
    });
  });
  it('names the waiver switch as an owner-only change in both directions', () => {
    const previous = config();
    const next = structuredClone(previous);
    next.team.operatorApprovalWaiver = true;
    for (const [a, b] of [
      [previous, next],
      [next, previous],
    ] as const) {
      expect(ownerOnlyChanges(a, b)).toEqual(['operator_approval_waiver']);
      expect(operatorConfigVerdict(a, b, { operator: 'operator' })).toMatchObject({
        level: 'approval',
        waiverEligible: false,
      });
    }
  });
});

function verdict(edit: (next: ProjectConfig) => void, base: () => ProjectConfig = config) {
  const previous = base();
  const next = structuredClone(previous);
  edit(next);
  return { previous, next, result: operatorConfigVerdict(previous, next, { operator: 'operator' }) };
}

type Case = [string, (next: ProjectConfig) => void, OperatorLevel];

/** The fields of an AI member the integrator rule covers but the owner wants to go straight through. */
const FOUR = ['model', 'effort', 'capacity', 'schedule'];

const NOW: Case[] = [
  ['the writer becomes Sonnet', (n) => (ai(n, 'writer').model = 'sonnet'), 'now'],
  ['the devops goes on leave', (n) => (ai(n, 'devops').onLeave = true), 'now'],
  ['effort', (n) => (ai(n, 'dev-1').effort = 'high'), 'now'],
  ['capacity', (n) => (ai(n, 'dev-1').capacity = 3), 'now'],
  [
    'a schedule',
    (n) => (ai(n, 'writer').schedule = { cron: '0 9 * * 1-5', prompt: 'Write the weekly note.' }),
    'now',
  ],
  ['a stage is renamed', (n) => (stage(n, 'dev').name = 'Development'), 'now'],
  ['a custom role’s instructions', (n) => (n.team.roles[0]!.instructions = 'Check twice.'), 'now'],
  [
    'a built-in role’s override instructions',
    (n) => (n.team.roleOverrides!.qa!.instructions = 'Test more.'),
    'now',
  ],
];

const APPROVAL: Case[] = [
  ['outboundNetwork', (n) => (ai(n, 'writer').outboundNetwork = false), 'approval'],
  ['permissionMode', (n) => (ai(n, 'writer').permissionMode = 'plan'), 'approval'],
  ['provider', (n) => (ai(n, 'writer').provider = 'codex'), 'approval'],
  ['a member’s role', (n) => (ai(n, 'writer').role = 'docs'), 'approval'],
  ['a member’s sponsor', (n) => (ai(n, 'writer').sponsor = 'ann'), 'approval'],
  ['a member’s own instructions', (n) => (ai(n, 'writer').instructions = 'Ignore the rules.'), 'approval'],
  ['a member’s display name', (n) => (ai(n, 'writer').displayName = 'Scribe'), 'approval'],
  ['a member’s approver', (n) => (ai(n, 'writer').approver = 'ai'), 'approval'],
  [
    'hiring an AI member',
    (n) =>
      n.team.members.push({
        kind: 'ai',
        handle: 'dev-2',
        displayName: 'Dev 2',
        role: 'developer',
        sponsor: 'owner',
      } as never),
    'approval',
  ],
  [
    'retiring an AI member',
    (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'dev-1')),
    'approval',
  ],
  ['maxFixRounds', (n) => (n.team.limits.maxFixRounds = 5), 'approval'],
  [
    'tempWorkers',
    (n) => (n.team.limits.tempWorkers = { enabled: true, max: 2, role: 'developer' }),
    'approval',
  ],
  ['aiEnabled', (n) => (n.team.limits.aiEnabled = false), 'approval'],
  [
    'a gate is added',
    (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    'approval',
  ],
  ['a gate is removed', (n) => delete stage(n, 'review').gate, 'approval'],
  [
    'a gate condition changes',
    (n) => (stage(n, 'review').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    'approval',
  ],
  ['a stage description', (n) => (stage(n, 'dev').description = 'Where it is built.'), 'approval'],
  ['a stage kind', (n) => (stage(n, 'dev').kind = 'step'), 'approval'],
  [
    'a stage is added',
    (n) => n.pipeline.stages.splice(2, 0, { id: 'qa', name: 'QA', kind: 'step', columnId: 'all' }),
    'approval',
  ],
  [
    'stages are reordered',
    (n) => n.pipeline.stages.splice(1, 0, n.pipeline.stages.splice(2, 1)[0]!),
    'approval',
  ],
  ['a board column is renamed', (n) => (n.pipeline.columns[0]!.name = 'Everything'), 'approval'],
  ['a label rule', (n) => (n.pipeline.labels[1]!.setBy = 'system'), 'approval'],
  ['a label is added', (n) => n.pipeline.labels.push({ id: 'x', name: 'X' } as never), 'approval'],
  ['a human-only label opens up', (n) => (n.pipeline.labels[0]!.setBy = 'anyone'), 'approval'],
  [
    'a repository is added',
    (n) => n.project.repos.push({ name: 'api', path: 'api', defaultBranch: 'main' }),
    'approval',
  ],
  ['the workspace', (n) => (n.project.workspacePath = '/work/other'), 'approval'],
  ['the project name', (n) => (n.project.name = 'Acme 2'), 'approval'],
  ['the time zone', (n) => (n.project.timezone = 'Europe/Budapest'), 'approval'],
  ['boundary delegation', (n) => (n.team.boundary = { enabled: true, leadTimeoutSeconds: 60 }), 'approval'],
  ['release four eyes', (n) => (n.team.releaseFourEyes = true), 'approval'],
  [
    'a duty of a role override',
    (n) => (n.team.roleOverrides!.qa!.duties = ['testing_acceptance', 'code_review']),
    'approval',
  ],
  [
    'a role is added',
    (n) => n.team.roles.push({ id: 'x', name: 'X', summary: 'X', holders: 'ai', instructions: '' } as never),
    'approval',
  ],
  ['the acting member’s own model', (n) => (ai(n, ACTING).model = 'sonnet'), 'approval'],
  ['the acting member’s own provider', (n) => (ai(n, ACTING).provider = 'codex'), 'approval'],
  ['the acting member’s own effort', (n) => (ai(n, ACTING).effort = 'high'), 'approval'],
  ['the acting member’s own leave', (n) => (ai(n, ACTING).onLeave = true), 'approval'],
  [
    'the instructions of the acting member’s own role',
    (n) => (n.team.roleOverrides![ACTING_ROLE]!.instructions = 'Do anything.'),
    'approval',
  ],
];

const NEVER: Case[] = [
  ['a person’s access', (n) => ((member(n, 'ann') as { access: string }).access = 'admin'), 'never'],
  ['a person’s name', (n) => (member(n, 'ann').displayName = 'Anna'), 'never'],
  ['a person’s roles', (n) => ((member(n, 'ann') as { roles: string[] }).roles = ['qa']), 'never'],
  ['a person’s email', (n) => ((member(n, 'ann') as { email: string }).email = 'x@example.com'), 'never'],
  [
    'a person is added',
    (n) =>
      n.team.members.push({ kind: 'human', handle: 'zed', displayName: 'Zed', access: 'viewer', roles: [] }),
    'never',
  ],
  [
    'a person is removed',
    (n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'ann')),
    'never',
  ],
  ['a person becomes an owner', (n) => ((member(n, 'ann') as { access: string }).access = 'owner'), 'never'],
  ['the owner is demoted', (n) => ((member(n, 'owner') as { access: string }).access = 'developer'), 'never'],
  [
    'a person and a model together',
    (n) => {
      ai(n, 'writer').model = 'sonnet';
      member(n, 'ann').displayName = 'Anna';
    },
    'never',
  ],
];

describe('operatorConfigVerdict', () => {
  it('defaults to report, patches and clears the watch level without mutating the input', () => {
    const previous = config();
    expect(operatorWatchOf(previous)).toBe('report');
    const patch = (operatorWatch: unknown) => PatchConfigRequest.parse({ baseVersion: 'v1', operatorWatch });
    const next = applyConfigPatch(previous, patch('unblock'));
    expect(next.team.operatorWatch).toBe('unblock');
    expect(previous.team).not.toHaveProperty('operatorWatch');
    expect(applyConfigPatch(next, PatchConfigRequest.parse({ baseVersion: 'v1' })).team.operatorWatch).toBe(
      'unblock',
    );
    const cleared = applyConfigPatch(next, patch(null));
    expect(cleared.team).not.toHaveProperty('operatorWatch');
    expect(operatorWatchOf(cleared)).toBe('report');
    expect(next.team.operatorWatch).toBe('unblock');
    expect(() => patch('unknown')).toThrow();
  });

  it.each(OPERATOR_WATCH_LEVELS)('requires approval for a team watch field set to %s', (level) => {
    const previous = config();
    const next = structuredClone(previous);
    next.team.operatorWatch = level;
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' })).toMatchObject({
      level: 'approval',
      changes: [
        {
          area: 'project',
          target: null,
          field: 'operatorWatch',
          before: null,
          after: level,
          level: 'approval',
        },
      ],
    });
    expect(ownerOnlyChanges(previous, next)).toEqual(level === 'report' ? [] : ['operator_watch']);
    expect(integratorConfigRefusal(previous, next)).toBe(level === 'report' ? null : 'owner_settings');
    const cleared = structuredClone(next);
    delete cleared.team.operatorWatch;
    expect(ownerOnlyChanges(next, cleared)).toEqual(level === 'report' ? [] : ['operator_watch']);
  });
  it('no change is now, with no rows', () => {
    expect(verdict(() => {}).result).toEqual({ level: 'now', changes: [], waiverEligible: false });
  });

  it('restating a default is no change', () => {
    expect(verdict((n) => (ai(n, 'writer').outboundNetwork = true)).result).toEqual({
      level: 'now',
      changes: [],
      waiverEligible: false,
    });
    expect(verdict((n) => (ai(n, 'writer').onLeave = false)).result).toEqual({
      level: 'now',
      changes: [],
      waiverEligible: false,
    });
    expect(verdict((n) => (ai(n, 'writer').approver = 'human')).result).toEqual({
      level: 'now',
      changes: [],
      waiverEligible: false,
    });
  });

  it('shows the acting member’s own fields row by row, every one asking for approval', () => {
    const { result } = verdict((n) => {
      ai(n, ACTING).model = 'sonnet';
      ai(n, ACTING).onLeave = true;
    });
    expect(result.changes.map((row) => `${row.field}:${row.level}`)).toEqual([
      'model:approval',
      'onLeave:approval',
    ]);
  });

  it.each([...NOW, ...APPROVAL, ...NEVER])('%s: %s', (_name, edit, level) => {
    const { previous, next, result } = verdict(edit);
    expect(result.level).toBe(level);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.changes.some((row) => row.level === level)).toBe(true);
    expect(result.changes.every((row) => ConfigChangeRow.safeParse(row).success)).toBe(true);
    if (integratorConfigRefusal(previous, next) !== null && result.level === 'now') {
      // Only these AI fields may bypass an integrator refusal.
      for (const row of result.changes) {
        expect(row.area).toBe('member');
        expect([...FOUR, 'onLeave']).toContain(row.field);
      }
    }
  });

  it('names the change in one row with the old and the new value', () => {
    expect(verdict((n) => (ai(n, 'writer').model = 'sonnet')).result).toEqual({
      level: 'now',
      waiverEligible: false,
      changes: [
        { area: 'member', target: 'writer', field: 'model', before: 'opus', after: 'sonnet', level: 'now' },
      ],
    });
    expect(verdict((n) => (ai(n, 'devops').onLeave = true)).result.changes).toEqual([
      { area: 'member', target: 'devops', field: 'onLeave', before: 'false', after: 'true', level: 'now' },
    ]);
    expect(verdict((n) => (ai(n, 'writer').outboundNetwork = false)).result.changes).toEqual([
      {
        area: 'member',
        target: 'writer',
        field: 'outboundNetwork',
        before: 'true',
        after: 'false',
        level: 'approval',
      },
    ]);
    expect(verdict((n) => (stage(n, 'dev').name = 'Development')).result.changes).toEqual([
      { area: 'stage', target: 'dev', field: 'name', before: 'Dev', after: 'Development', level: 'now' },
    ]);
  });

  it('shows what is not text as JSON with sorted keys, and an absent value as null', () => {
    const { result } = verdict((n) => (ai(n, 'writer').schedule = { prompt: 'Hi', cron: '0 9 * * *' }));
    expect(result.changes).toEqual([
      {
        area: 'member',
        target: 'writer',
        field: 'schedule',
        before: null,
        after: '{"cron":"0 9 * * *","prompt":"Hi"}',
        level: 'now',
      },
    ]);
    const gate = verdict(
      (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] }),
    );
    expect(gate.result.changes).toEqual([
      {
        area: 'gate',
        target: 'dev',
        field: 'gate',
        before: null,
        after: '{"conditions":[{"label":"ui","type":"has_label"}]}',
        level: 'approval',
      },
    ]);
  });

  it('shows an added or removed entity as one `*` row with a short descriptor', () => {
    const hired = verdict((n) =>
      n.team.members.push({
        kind: 'ai',
        handle: 'dev-2',
        displayName: 'Dev 2',
        role: 'developer',
        sponsor: 'owner',
      } as never),
    );
    expect(hired.result.changes).toContainEqual({
      area: 'member',
      target: 'dev-2',
      field: '*',
      before: null,
      after: 'developer',
      level: 'approval',
    });
    const retired = verdict((n) => (n.pipeline.labels = n.pipeline.labels.filter((l) => l.id !== 'ui')));
    expect(retired.result.changes).toEqual([
      { area: 'label', target: 'ui', field: '*', before: 'UI', after: null, level: 'approval' },
    ]);
  });

  it('the level is the highest of the rows: never over approval over now', () => {
    const mixed = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      ai(n, 'writer').outboundNetwork = false;
    });
    expect(mixed.result.level).toBe('approval');
    expect(mixed.result.changes.map((row) => row.level).sort()).toEqual(['approval', 'now']);
  });

  it('an AI member’s model together with a gate needs approval', () => {
    const { result } = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      delete stage(n, 'review').gate;
    });
    expect(result.level).toBe('approval');
  });

  describe('a revert is judged by its result', () => {
    const changed = () => {
      const c = config();
      ai(c, 'writer').model = 'sonnet';
      ai(c, 'writer').outboundNetwork = false;
      ai(c, 'devops').onLeave = true;
      return c;
    };

    it('putting back a model and a leave is now', () => {
      const result = operatorConfigVerdict(
        changed(),
        (() => {
          const c = config();
          ai(c, 'writer').outboundNetwork = false;
          return c;
        })(),
        { operator: 'operator' },
      );
      expect(result.level).toBe('now');
      expect(result.changes.map((row) => row.field).sort()).toEqual(['model', 'onLeave']);
    });

    it('putting back the network is approval, like turning it off', () => {
      const result = operatorConfigVerdict(changed(), config(), { operator: 'operator' });
      expect(result.level).toBe('approval');
      expect(result.changes.map((row) => `${row.field}:${row.level}`).sort()).toEqual([
        'model:now',
        'onLeave:now',
        'outboundNetwork:approval',
      ]);
      expect(result.changes.find((row) => row.field === 'outboundNetwork')).toMatchObject({
        before: 'false',
        after: 'true',
      });
    });

    it('a state that equals the current one is no change, whatever the way there was', () => {
      expect(operatorConfigVerdict(changed(), changed(), { operator: 'operator' })).toEqual({
        level: 'now',
        changes: [],
        waiverEligible: false,
      });
    });
  });

  it('judges the Operator’s own member by the handle given, not by its role', () => {
    const previous = config();
    const next = structuredClone(previous);
    ai(next, 'writer').model = 'sonnet';
    expect(operatorConfigVerdict(previous, next, { operator: 'operator' }).level).toBe('now');
    expect(operatorConfigVerdict(previous, next, { operator: 'writer' }).level).toBe('approval');
  });

  it('an invitation binding is still a change to a person', () => {
    const previous = config();
    (member(previous, 'ann') as { email?: string }).email = undefined;
    const next = structuredClone(previous);
    (member(next, 'ann') as { email?: string }).email = 'ann@example.com';
    const result = operatorConfigVerdict(previous, next, {
      operator: 'operator',
      invitationBinding: { handle: 'ann', email: 'ann@example.com' },
    });
    expect(result.level).toBe('never');
  });

  it('rows are the same on a repeat', () => {
    const a = verdict((n) => {
      ai(n, 'writer').model = 'sonnet';
      stage(n, 'dev').name = 'X';
    });
    const b = operatorConfigVerdict(a.previous, a.next, { operator: 'operator' });
    expect(b).toEqual(a.result);
  });

  describe('property: what the integrator may not do is at least approval', () => {
    it('holds when only the four fields change, and fails when anything else rides along', () => {
      const four = verdict((n) => {
        ai(n, 'writer').model = 'sonnet';
        ai(n, 'writer').effort = 'low';
        ai(n, 'writer').capacity = 2;
        ai(n, 'writer').schedule = { cron: '0 9 * * *', prompt: 'x' };
      });
      expect(integratorConfigRefusal(four.previous, four.next)).toBe('members');
      expect(four.result.level).toBe('now');
      const more = verdict((n) => {
        ai(n, 'writer').model = 'sonnet';
        ai(n, 'writer').provider = 'codex';
      });
      expect(more.result.level).toBe('approval');
    });
  });
});

describe('operatorAutonomousLevel (decision 55)', () => {
  const autonomous = (edit: (next: ProjectConfig) => void) => {
    const { previous, next, result } = verdict(edit);
    return { before: result.level, after: operatorAutonomousLevel(previous, next, result, 'operator') };
  };

  it.each<[string, (next: ProjectConfig) => void]>([
    [
      'a stage is added',
      (n) => n.pipeline.stages.splice(2, 0, { id: 'qa', name: 'QA', kind: 'step', columnId: 'all' }),
    ],
    ['a gate is added', (n) => (stage(n, 'dev').gate = { conditions: [{ type: 'has_label', label: 'ui' }] })],
    ['a member’s role', (n) => (ai(n, 'writer').role = 'docs')],
  ])('lets an owner-asked approval change through: %s', (_name, edit) => {
    expect(autonomous(edit)).toEqual({ before: 'approval', after: 'now' });
  });

  it('keeps what stays the owner’s call at approval: deletion and the acting member itself', () => {
    const retire = autonomous((n) => (n.team.members = n.team.members.filter((m) => m.handle !== 'dev-1')));
    expect(retire).toEqual({ before: 'approval', after: 'approval' });
    const itself = autonomous((n) => (ai(n, ACTING).model = 'sonnet'));
    expect(itself).toEqual({ before: 'approval', after: 'approval' });
  });

  it('never turns a never into anything else, and leaves a now alone', () => {
    expect(autonomous((n) => ((member(n, 'ann') as { access: string }).access = 'admin'))).toEqual({
      before: 'never',
      after: 'never',
    });
    expect(autonomous((n) => (ai(n, 'writer').model = 'sonnet'))).toEqual({ before: 'now', after: 'now' });
  });
});

describe('operator levels', () => {
  it('the project manager may not move a card out of the first stage', () => {
    expect(actorMoveRefusal(config(), { kind: 'ai', handle: 'pm' }, 'backlog', 'dev')).toBe(
      'project_manager_move_refused',
    );
  });

  it('the project manager and people may set a priority; other AI members may not', () => {
    const c = config();
    expect(priorityRefusal({ kind: 'ai', handle: 'pm' }, c)).toBeNull();
    expect(priorityRefusal({ kind: 'human', handle: 'owner' }, c)).toBeNull();
    expect(priorityRefusal({ kind: 'ai', handle: 'dev-1' }, c)).toBe('priority_humans_only');
  });

  it('level names parse', () => {
    expect(OperatorLevel.options).toEqual(['now', 'approval', 'never']);
    const verdictShape: OperatorConfigVerdict = { level: 'now', changes: [], waiverEligible: false };
    expect(verdictShape.changes).toEqual([]);
  });
});
