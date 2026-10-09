import { describe, expect, it } from 'vitest';
import { memberOf } from './lookup';
import {
  isProjectManager,
  isRequiredProjectManager,
  PROJECT_MANAGER_ROLE,
  projectManagerMoveRefusal,
  projectManagerOf,
  projectManagersOf,
  sessionWorkItemOf,
} from './project-manager';
import { ProjectConfig } from './schema';
import type { MemberConfig } from './schema';

type MemberInput = Record<string, unknown>;

const OWNER: MemberInput = {
  kind: 'human',
  handle: 'owner',
  displayName: 'Owner',
  access: 'owner',
  roles: ['operator'],
};

function ai(handle: string, extra: MemberInput = {}): MemberInput {
  return {
    kind: 'ai',
    handle,
    displayName: handle,
    role: PROJECT_MANAGER_ROLE,
    sponsor: 'owner',
    ...extra,
  };
}

function configWith(members: MemberInput[]): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: { members: [OWNER, ...members], limits: {} },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'ideas', name: 'Ideas', kind: 'queue', columnId: 'all' },
        { id: 'ready', name: 'Ready', kind: 'queue', columnId: 'all' },
        { id: 'dev', name: 'Dev', kind: 'work', columnId: 'all' },
        { id: 'review', name: 'Review', kind: 'step', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

describe('isProjectManager', () => {
  it('is true for an AI member with the project_manager role, on leave or not', () => {
    const config = configWith([ai('pm'), ai('away', { onLeave: true })]);
    expect(isProjectManager(memberOf(config, 'pm'))).toBe(true);
    expect(isProjectManager(memberOf(config, 'away'))).toBe(true);
  });

  it('is false for a temp worker, another role, a human with the role and no member', () => {
    const config = configWith([
      ai('stand-in', { temp: true }),
      ai('dev-1', { role: 'developer' }),
      { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin', roles: ['project_manager'] },
    ]);
    expect(isProjectManager(memberOf(config, 'stand-in'))).toBe(false);
    expect(isProjectManager(memberOf(config, 'dev-1'))).toBe(false);
    expect(isProjectManager(memberOf(config, 'ann'))).toBe(false);
    expect(isProjectManager(undefined)).toBe(false);
    expect(isProjectManager(null)).toBe(false);
  });
});

describe('projectManagersOf and projectManagerOf', () => {
  it('has none without a project manager', () => {
    const config = configWith([ai('dev-1', { role: 'developer' })]);
    expect(projectManagersOf(config)).toEqual([]);
    expect(projectManagerOf(config)).toBeNull();
  });

  it('lists the AI project managers in configuration order, leaving out humans and temp workers', () => {
    const config = configWith([
      ai('pm-b'),
      ai('stand-in', { temp: true }),
      { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin', roles: ['project_manager'] },
      ai('pm-a'),
    ]);
    expect(projectManagersOf(config).map((m) => m.handle)).toEqual(['pm-b', 'pm-a']);
  });

  it('names the only one, on leave or not', () => {
    expect(projectManagerOf(configWith([ai('pm')]))?.handle).toBe('pm');
    expect(projectManagerOf(configWith([ai('pm', { onLeave: true })]))?.handle).toBe('pm');
  });

  it('names the first one not on leave, else the first', () => {
    const one = configWith([ai('pm-a', { onLeave: true }), ai('pm-b'), ai('pm-c')]);
    expect(projectManagerOf(one)?.handle).toBe('pm-b');
    const away = configWith([ai('pm-a', { onLeave: true }), ai('pm-b', { onLeave: true })]);
    expect(projectManagerOf(away)?.handle).toBe('pm-a');
  });
});

describe('isRequiredProjectManager', () => {
  it('holds for the only AI project manager, even on leave', () => {
    expect(isRequiredProjectManager(configWith([ai('pm')]), 'pm')).toBe(true);
    expect(isRequiredProjectManager(configWith([ai('pm', { onLeave: true })]), 'pm')).toBe(true);
  });

  it('does not hold with two project managers', () => {
    const config = configWith([ai('pm-a'), ai('pm-b')]);
    expect(isRequiredProjectManager(config, 'pm-a')).toBe(false);
    expect(isRequiredProjectManager(config, 'pm-b')).toBe(false);
  });

  it('does not hold for another member, a temp worker or a human with the role', () => {
    const config = configWith([
      ai('pm'),
      ai('dev-1', { role: 'developer' }),
      ai('stand-in', { temp: true }),
      { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin', roles: ['project_manager'] },
    ]);
    expect(isRequiredProjectManager(config, 'dev-1')).toBe(false);
    expect(isRequiredProjectManager(config, 'stand-in')).toBe(false);
    expect(isRequiredProjectManager(config, 'ann')).toBe(false);
    expect(isRequiredProjectManager(config, 'nobody')).toBe(false);
  });

  it('does not hold when a human holds the role and no AI does', () => {
    const config = configWith([
      { kind: 'human', handle: 'ann', displayName: 'Ann', access: 'admin', roles: ['project_manager'] },
    ]);
    expect(isRequiredProjectManager(config, 'ann')).toBe(false);
  });
});

describe('projectManagerMoveRefusal', () => {
  const config = configWith([ai('pm')]);

  it('allows a later work stage from a queue stage that is not the first', () => {
    expect(projectManagerMoveRefusal(config, 'ready', 'dev')).toBeNull();
  });

  it('refuses the first stage, backward moves and moves into other kinds of stage', () => {
    for (const [from, to] of [
      ['ideas', 'ready'],
      ['ideas', 'dev'],
      ['dev', 'ready'],
      ['ready', 'ideas'],
      ['ready', 'ready'],
      ['ready', 'review'],
      ['ready', 'done'],
      ['dev', 'review'],
      ['review', 'dev'],
    ] as const)
      expect(projectManagerMoveRefusal(config, from, to), `${from} -> ${to}`).toBe(
        'project_manager_move_refused',
      );
  });

  it('refuses an unknown stage on either side', () => {
    expect(projectManagerMoveRefusal(config, 'nowhere', 'dev')).toBe('project_manager_move_refused');
    expect(projectManagerMoveRefusal(config, 'ready', 'nowhere')).toBe('project_manager_move_refused');
  });
});

describe('sessionWorkItemOf', () => {
  const config = configWith([ai('pm'), ai('dev-1', { role: 'developer' })]);
  const pm: MemberConfig | undefined = memberOf(config, 'pm');
  const dev: MemberConfig | undefined = memberOf(config, 'dev-1');

  it("moves a project manager's card work into its general conversation", () => {
    expect(sessionWorkItemOf(pm, { type: 'task', taskKey: 'AC-1' })).toEqual({ type: 'general' });
  });

  it('leaves everything else as it is', () => {
    const task = { type: 'task', taskKey: 'AC-1' } as const;
    expect(sessionWorkItemOf(dev, task)).toEqual(task);
    expect(sessionWorkItemOf(undefined, task)).toEqual(task);
    for (const item of [
      { type: 'meeting', meetingId: 'm1' },
      { type: 'schedule', runId: 'r1' },
      { type: 'general' },
    ] as const)
      expect(sessionWorkItemOf(pm, item)).toEqual(item);
  });
});
