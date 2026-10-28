import { describe, expect, it } from 'vitest';
import { currentHandleOf, memberStorageHandle, renameMemberInConfig } from './member-handles';
import { AiMemberConfig, ProjectConfig } from './schema';

describe('memberStorageHandle', () => {
  it('is the current handle of a member that was never renamed', () => {
    expect(memberStorageHandle({ handle: 'dev' })).toBe('dev');
  });

  it('is the oldest former handle of a renamed member', () => {
    expect(memberStorageHandle({ handle: 'dev-3', formerHandles: ['dev', 'dev-2'] })).toBe('dev');
  });
});

function configWith(members: unknown[]): ProjectConfig {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: {
      key: 'AR',
      name: 'Acme',
      workspacePath: '/tmp/acme',
      repos: [],
      feedback: { blockedMarkers: ['dev', 'other'] },
    },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: [] },
        ...members,
      ],
      cardMover: { kind: 'human', handle: 'dev' },
      merger: { kind: 'member', handle: 'dev' },
      contacts: ['dev', 'owner'],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'c', name: 'C' }],
      stages: [
        { id: 'a', name: 'A', kind: 'queue', columnId: 'c', owners: ['dev', 'owner'] },
        { id: 'b', name: 'B', kind: 'done', columnId: 'c' },
      ],
      labels: [{ id: 'ok', name: 'Ok', setBy: { members: ['dev'] } }],
    },
  });
}

const ai = (handle: string, extra: object = {}) => ({
  kind: 'ai',
  handle,
  displayName: handle,
  role: 'developer',
  sponsor: 'owner',
  ...extra,
});

describe('renameMemberInConfig', () => {
  const config = configWith([
    ai('dev', { email: { enabled: true, sendWithoutApproval: true } }),
    ai('other', { formerHandles: ['old'] }),
  ]);
  const renamed = renameMemberInConfig(config, 'dev', 'haini');

  it('rewrites every reference to the handle', () => {
    expect(renamed.team.members.map((m) => m.handle)).toEqual(['owner', 'haini', 'other']);
    expect(renamed.pipeline.stages[0]?.owners).toEqual(['haini', 'owner']);
    expect(renamed.pipeline.labels[0]?.setBy).toEqual({ members: ['haini'] });
    expect(renamed.team.cardMover).toEqual({ kind: 'human', handle: 'haini' });
    expect(renamed.team.merger).toEqual({ kind: 'member', handle: 'haini' });
    expect(renamed.team.contacts).toEqual(['haini', 'owner']);
    expect(renamed.project.feedback?.blockedMarkers).toEqual(['haini', 'other']);
  });

  it('keeps the old handle as a former one and the e-mail settings as they are', () => {
    const member = renamed.team.members[1] as AiMemberConfig;
    expect(member.formerHandles).toEqual(['dev']);
    expect(member.email).toEqual({ enabled: true, sendWithoutApproval: true });
    expect((renamed.team.members[2] as AiMemberConfig).formerHandles).toEqual(['old']);
  });

  it('appends to an earlier chain', () => {
    const chained = renameMemberInConfig(renamed, 'haini', 'emil');
    expect((chained.team.members[1] as AiMemberConfig).formerHandles).toEqual(['dev', 'haini']);
  });
});

describe('currentHandleOf', () => {
  const config = renameMemberInConfig(configWith([ai('dev'), ai('x')]), 'dev', 'haini');

  it.each([
    ['haini', 'haini'],
    ['dev', 'haini'],
    ['x', 'x'],
    ['nobody', null],
  ])('maps %s to %s', (name, expected) => {
    expect(currentHandleOf(config, name)).toBe(expected);
  });

  it('prefers a live handle over a former one', () => {
    const reused = {
      ...config,
      team: {
        ...config.team,
        members: [...config.team.members, ...configWith([ai('dev')]).team.members.slice(1)],
      },
    };
    expect(currentHandleOf(reused, 'dev')).toBe('dev');
  });
});
