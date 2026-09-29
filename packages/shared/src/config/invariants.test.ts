import { describe, expect, it } from 'vitest';
import { AI_BUILT_IN_ROLE_IDS, BUILT_IN_ROLE_IDS, holdersAllow, roleHolders, RoleId } from '../domain/role';
import { validateProjectConfig } from './invariants';
import { AiMemberConfig, ProjectConfig, type ProjectConfigInput } from './schema';

function configInput(): ProjectConfigInput {
  return {
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'developer' },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
      roles: [
        {
          id: 'data_steward',
          name: 'Data steward',
          summary: 'Keeps the reference data clean.',
          holders: 'both',
        },
        { id: 'client_lead', name: 'Client lead', summary: 'Speaks for the client.', holders: 'human' },
        { id: 'log_reader', name: 'Log reader', summary: 'Reads the logs every hour.', holders: 'ai' },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'todo', name: 'To do' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', owners: [], columnId: 'todo' },
        { id: 'done', name: 'Done', kind: 'done', owners: [], columnId: 'todo' },
      ],
    },
  };
}

function build(change: (input: ProjectConfigInput) => void = () => {}): ProjectConfig {
  const input = configInput();
  change(input);
  return ProjectConfig.parse(input);
}

function members(input: ProjectConfigInput) {
  return input.team.members as Array<Record<string, unknown>>;
}

describe('role catalogue', () => {
  it('lets AI members hold every built-in role except the human-only ones', () => {
    expect(BUILT_IN_ROLE_IDS).toHaveLength(20);
    const aiRoles: readonly string[] = AI_BUILT_IN_ROLE_IDS;
    expect(BUILT_IN_ROLE_IDS.filter((id) => !aiRoles.includes(id))).toEqual(['operator', 'product_owner']);
    expect(roleHolders('watchdog')).toBe('both');
    expect(roleHolders('scheduled')).toBeNull();
    expect(roleHolders('log_reader', [{ id: 'log_reader', holders: 'ai' }])).toBe('both');
    expect(roleHolders('developer', [{ id: 'developer', holders: 'human' }])).toBe('both');
    expect(holdersAllow('both', 'human') && holdersAllow('ai', 'ai')).toBe(true);
    expect(holdersAllow('human', 'ai') || holdersAllow('ai', 'human')).toBe(false);
  });

  it('validates custom role identifiers', () => {
    expect(RoleId.safeParse('data_steward').success).toBe(true);
    expect(RoleId.safeParse('Data-Steward').success).toBe(false);
  });
});

describe('configuration schema', () => {
  it('defaults human roles, custom roles and the time zone', () => {
    const input = configInput();
    delete input.team.roles;
    const config = ProjectConfig.parse(input);
    expect(config.project.timezone).toBe('UTC');
    expect(config.team.roles).toEqual([]);
    expect(config.team.members[1]).toMatchObject({ kind: 'human', roles: [] });
    expect(config.team.limits.tempWorkers.role).toBe('developer');
  });

  it('accepts a schedule on any AI member', () => {
    const member = AiMemberConfig.parse({
      kind: 'ai',
      handle: 'daily',
      displayName: 'Daily worker',
      role: 'maintainer',
      sponsor: 'owner',
      schedule: { cron: '0 8 * * 1-5', prompt: 'Run the daily round.' },
    });
    expect(member.schedule).toEqual({ cron: '0 8 * * 1-5', prompt: 'Run the daily round.' });
    expect(
      AiMemberConfig.safeParse({ ...member, schedule: { cron: ' ', prompt: 'Run the daily round.' } })
        .success,
    ).toBe(false);
  });
});

describe('validateProjectConfig roles', () => {
  it('accepts built-in and custom roles held by the right kind of member', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['product_owner', 'data_steward', 'client_lead', 'qa'];
      members(input).push({
        kind: 'ai',
        handle: 'logs',
        displayName: 'Logs',
        role: 'log_reader',
        sponsor: 'owner',
      });
      input.team.limits = { tempWorkers: { enabled: true, max: 1, role: 'data_steward' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([]);
  });

  it('reports unknown roles of members and temp workers', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['qa', 'scheduled'];
      members(input)[2]!.role = 'scheduled';
      input.team.limits = { tempWorkers: { role: 'nobody_knows' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'unknown_role', path: 'team.members[1].roles[1]', detail: 'scheduled' },
      { code: 'unknown_role', path: 'team.members[2].role', detail: 'scheduled' },
      { code: 'unknown_role', path: 'team.limits.tempWorkers.role', detail: 'nobody_knows' },
    ]);
  });

  it('derives human-only restrictions while allowing humans to monitor and research', () => {
    const config = build((input) => {
      members(input)[0]!.roles = ['operator', 'watchdog', 'log_reader'];
      members(input)[2]!.role = 'operator';
      members(input).push({
        kind: 'ai',
        handle: 'lead',
        displayName: 'Lead',
        role: 'client_lead',
        sponsor: 'owner',
      });
      input.team.limits = { tempWorkers: { role: 'product_owner' } };
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'role_not_for_ai', path: 'team.members[2].role', detail: 'operator' },
      { code: 'role_not_for_ai', path: 'team.members[3].role', detail: 'client_lead' },
      { code: 'role_not_for_ai', path: 'team.limits.tempWorkers.role', detail: 'product_owner' },
    ]);
  });

  it('reports custom roles that reuse a built-in id or another custom id', () => {
    const config = build((input) => {
      input.team.roles!.push(
        { id: 'qa', name: 'Our QA', summary: 'Tests differently.', holders: 'both' },
        { id: 'data_steward', name: 'Second steward', summary: 'Same id again.', holders: 'ai' },
      );
      members(input)[1]!.roles = ['qa', 'data_steward'];
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'custom_role_shadows_builtin', path: 'team.roles[3].id', detail: 'qa' },
      { code: 'duplicate_role', path: 'team.roles[4].id', detail: 'data_steward' },
    ]);
  });

  it('reports a role a human holds twice', () => {
    const config = build((input) => {
      members(input)[1]!.roles = ['qa', 'devops', 'qa'];
    });
    expect(validateProjectConfig(config).filter((i) => i.severity !== 'warning')).toEqual([
      { code: 'duplicate_role', path: 'team.members[1].roles[2]', detail: 'qa' },
    ]);
  });
});
