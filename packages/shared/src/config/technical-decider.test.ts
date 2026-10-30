import { describe, expect, it } from 'vitest';
import { ProjectConfig } from './schema';
import { technicalDeciderOf } from './technical-decider';

type Member = Record<string, unknown>;

const lead = (handle: string, extra: Member = {}): Member => ({
  kind: 'ai',
  handle,
  displayName: handle,
  role: 'lead_developer',
  sponsor: 'owner',
  ...extra,
});

function configWith(members: Member[], limits: Record<string, unknown> = {}): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        ...members,
      ],
      limits,
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

describe('technicalDeciderOf', () => {
  it('is the first AI member holding boundary_authorization, in the team order', () => {
    expect(technicalDeciderOf(configWith([lead('lead-1'), lead('lead-2')]), 'dev')).toBe('lead-1');
  });

  it('skips a member on leave', () => {
    expect(technicalDeciderOf(configWith([lead('lead-1', { onLeave: true }), lead('lead-2')]), 'dev')).toBe(
      'lead-2',
    );
  });

  it('is null when only the project manager or nobody holds the duty', () => {
    const withPmDuty = ProjectConfig.parse({
      ...configWith([]),
      team: {
        ...configWith([]).team,
        roleOverrides: { project_manager: { duties: ['boundary_authorization'], instructions: '' } },
      },
    });
    expect(technicalDeciderOf(withPmDuty, 'dev')).toBeNull();
    expect(technicalDeciderOf(configWith([]), 'dev')).toBeNull();
  });

  it('is null while the AI team is switched off', () => {
    expect(technicalDeciderOf(configWith([lead('lead-1')], { aiEnabled: false }), 'dev')).toBeNull();
  });

  it('is null for a human who holds the duty', () => {
    const human = {
      kind: 'human',
      handle: 'maria',
      displayName: 'Maria',
      access: 'developer',
      roles: ['lead_developer'],
    };
    expect(technicalDeciderOf(configWith([human]), 'dev')).toBeNull();
  });

  it('is null when the asker holds the duty itself', () => {
    expect(technicalDeciderOf(configWith([lead('lead-1'), lead('lead-2')]), 'lead-1')).toBeNull();
  });
});
