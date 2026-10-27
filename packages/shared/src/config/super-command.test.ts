import { describe, expect, it } from 'vitest';
import type { SuperCommand } from '../api/super-handoff';
import { SuperCommand as SuperCommandSchema } from '../api/super-handoff';
import { AiMemberConfig, ProjectConfig } from './schema';
import { SuperCommandUnclassifiable, superCommandEffects, superCommandMutations } from './super-command';
import type { SuperCommandContext } from './super-command';
import {
  ownerReservedEffect,
  SUPER_ADMINISTRATION_COMMANDS,
  projectManagerCommandRefusal,
  superConfigMutations,
} from './super-mutation';

it.each([
  ['task_create', null],
  ['merge', 'command_not_for_project_manager'],
  ['administration', 'command_not_for_project_manager'],
  ['future_command', 'command_not_for_project_manager'],
])('checks the project manager command allowlist for %s', (kind, refusal) => {
  expect(projectManagerCommandRefusal({ kind: kind! })).toBe(refusal);
});

function config() {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [{ name: 'web', path: 'web' }] },
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
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'dev-2',
          displayName: 'Paid developer',
          role: 'developer',
          sponsor: 'owner',
          provider: 'nanogpt',
        },
      ],
      limits: {},
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'backlog', name: 'Backlog', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
      labels: [],
    },
  });
}

const context = (): SuperCommandContext => ({ config: config(), configVersion: 'v1' });
const effects = (command: SuperCommand) => superCommandEffects(command, context());
const operate = (operation: unknown) => ({ kind: 'operate', operation }) as SuperCommand;

describe('super command classification (PM-762)', () => {
  it('always reserves an owner command for a fresh security approval', () => {
    const command: SuperCommand = {
      kind: 'administration',
      request: {
        kind: 'owner_command',
        target: { kind: 'hub' },
        command: 'pwd',
        timeoutSeconds: 120,
        reason: 'Inspect fixture',
      },
    };
    expect(ownerReservedEffect(null, { kind: 'owner_command' })).toBe('security');
    expect(superCommandMutations(command, context())).toEqual([{ kind: 'owner_command' }]);
    const ctx = context();
    ctx.config.team.operatorApprovalWaiver = true;
    expect(superCommandEffects(command, ctx)).toEqual(['security']);
    expect(SUPER_ADMINISTRATION_COMMANDS).not.toContain('owner_command');
  });
  it('has no owner-reserved effect for the routine commands', () => {
    expect(effects(operate({ op: 'project_pause' }))).toEqual([]);
    expect(effects(operate({ op: 'project_resume' }))).toEqual([]);
    expect(effects(operate({ op: 'session_stop', sessionId: 'ses_1' }))).toEqual([]);
    expect(effects({ kind: 'workspace_release', scopeId: 'scp_1', reason: 'Checked by hand' })).toEqual([]);
    expect(
      effects({ kind: 'member_update', handle: 'dev-1', request: { displayName: 'Fictional name' } }),
    ).toEqual([]);
    expect(
      effects({
        kind: 'administration',
        request: { kind: 'full_test', taskKey: 'AC-1', commit: 'a'.repeat(40), profile: 'merge-test' },
      }),
    ).toEqual([]);
    expect(
      effects({
        kind: 'administration',
        request: { kind: 'process_cleanup', target: { kind: 'hub' }, selector: 'orphan_test_workers' },
      }),
    ).toEqual([]);
  });

  it('names deletion for a member retired', () => {
    expect(effects(operate({ op: 'member_retire', handle: 'dev-1' }))).toEqual(['deletion']);
  });

  it('names cost for a paid runtime and nothing for a deploy', () => {
    expect(effects({ kind: 'member_update', handle: 'dev-2', request: { effort: 'high' } })).toEqual([
      'cost',
    ]);
    // Only sending the paid member on leave costs nothing.
    expect(effects({ kind: 'member_update', handle: 'dev-2', request: { onLeave: true } })).toEqual([]);
    expect(effects({ kind: 'administration', request: { kind: 'deploy', releaseId: 'rel_1' } })).toEqual([]);
  });

  it('names security for an access change or an owner invitation, and nothing for a role change', () => {
    expect(
      superCommandMutations(
        { kind: 'member_update', handle: 'dev-1', request: { access: 'admin' } },
        context(),
      ),
    ).toEqual([{ kind: 'access_change', handle: 'dev-1', before: null, after: 'admin' }]);
    expect(effects({ kind: 'member_update', handle: 'owner', request: { access: 'admin' } })).toEqual([
      'security',
    ]);
    // The same access again is no change.
    expect(effects({ kind: 'member_update', handle: 'owner', request: { access: 'owner' } })).toEqual([]);
    expect(effects({ kind: 'member_update', handle: 'owner', request: { roles: ['operator'] } })).toEqual([]);
    const invite = (access: string) =>
      ({ kind: 'invite_create', request: { email: 'new@example.com', access } }) as SuperCommand;
    expect(effects(invite('owner'))).toEqual(['security']);
    expect(effects(invite('developer'))).toEqual([]);
  });

  it('names security for an AI permission setting, together with the cost of a paid member', () => {
    expect(effects({ kind: 'member_update', handle: 'dev-1', request: { approver: 'none' } })).toEqual([
      'security',
    ]);
    expect(effects({ kind: 'member_update', handle: 'dev-1', request: { outboundNetwork: false } })).toEqual([
      'security',
    ]);
    expect(
      effects({
        kind: 'member_update',
        handle: 'dev-2',
        request: { permissionMode: 'default', effort: 'high' },
      }),
    ).toEqual(['security', 'cost']);
  });

  it('refuses what it cannot project, instead of treating it as harmless', () => {
    expect(() => effects({ kind: 'member_update', handle: 'ghost', request: { displayName: 'X' } })).toThrow(
      SuperCommandUnclassifiable,
    );
    expect(() => effects({ kind: 'nothing' } as unknown as SuperCommand)).toThrow(SuperCommandUnclassifiable);
    expect(() => effects(operate({ op: 'nothing' }))).toThrow(SuperCommandUnclassifiable);
    expect(() => effects(operate({ op: 'config_revert', version: 'unknown' }))).toThrow(
      SuperCommandUnclassifiable,
    );
  });

  it('projects every command kind onto a mutation', () => {
    expect(
      superCommandMutations({ kind: 'merge_order', taskKeys: ['AC-1'] } as SuperCommand, context()),
    ).toEqual([{ kind: 'routine', operation: 'merge_order' }]);
    expect(
      superCommandMutations(
        { kind: 'administration', request: { kind: 'deploy', releaseId: 'rel_1' } },
        context(),
      ),
    ).toEqual([{ kind: 'administration', command: 'deploy' }]);
  });

  it('keeps the command schema closed: an unknown kind or field is not a command', () => {
    expect(
      SuperCommandSchema.safeParse({ kind: 'operate', operation: { op: 'project_pause' } }).success,
    ).toBe(true);
    expect(SuperCommandSchema.safeParse({ kind: 'shell', command: 'ls' }).success).toBe(false);
    expect(
      SuperCommandSchema.safeParse({ kind: 'operate', operation: { op: 'project_pause' }, extra: 1 }).success,
    ).toBe(false);
    expect(
      SuperCommandSchema.safeParse({
        kind: 'administration',
        request: { kind: 'deploy', releaseId: 'rel_1', path: '/x' },
      }).success,
    ).toBe(false);
  });

  it.each([
    { kind: 'task_create', request: { title: 'A card', labels: ['refine'] } },
    { kind: 'task_update', taskKey: 'AC-1', request: { title: 'Changed' } },
    { kind: 'task_labels', taskKey: 'AC-1', request: { add: ['scope-ok'] } },
    { kind: 'task_start', taskKey: 'AC-1', request: {} },
    { kind: 'task_cancel', taskKey: 'AC-1', request: {} },
    { kind: 'inbox_resolve', itemId: 'inbox_1', request: { optionId: 'done' } },
  ])('accepts and classifies the additive $kind command', (input) => {
    const command = SuperCommandSchema.parse(input);
    expect(effects(command)).toEqual([]);
    expect(SuperCommandSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
  });

  it.each([
    ['task_create', 'task_create'],
    ['task_update', 'task_write'],
  ] as const)('classifies %s as routine', (kind, operation) => {
    const command: SuperCommand =
      kind === 'task_create'
        ? { kind, request: { title: 'A card' } }
        : { kind, taskKey: 'AC-1', request: { title: 'Updated' } };
    expect(superCommandMutations(command, context())).toEqual([{ kind: 'routine', operation }]);
  });

  it('refuses a workspace release reason with hidden formatting characters', () => {
    const release = (reason: string) => ({ kind: 'workspace_release', scopeId: 'scp_1', reason });
    expect(SuperCommandSchema.safeParse(release('Checked by hand')).success).toBe(true);
    expect(SuperCommandSchema.safeParse(release('Checked‮reversed')).success).toBe(false);
  });

  it('reserves credential revocation for the owner', () => {
    expect(effects(SuperCommandSchema.parse({ kind: 'credential_revoke', keyId: 'key_1' }))).toEqual([
      'deletion',
    ]);
  });

  it.each(['grant', 'remove'] as const)('reserves a boundary duty role change: %s', (direction) => {
    const ctx = context();
    const member = ctx.config.team.members.find((m) => m.handle === 'dev-1')!;
    if (member.kind !== 'ai') throw new Error('expected AI fixture');
    if (direction === 'remove') member.role = 'lead_developer';
    const command = operate({
      op: 'member_update',
      handle: member.handle,
      changes: { role: direction === 'grant' ? 'lead_developer' : 'developer' },
    });
    expect(superCommandMutations(command, ctx)).toContainEqual({
      kind: 'permission_change',
      handle: member.handle,
    });
    expect(superCommandEffects(command, ctx)).toEqual(['security']);
  });

  it('reserves a boundary role definition change in a config patch', () => {
    const command = operate({
      op: 'config_patch',
      patch: {
        roleOverrides: {
          developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
        },
      },
    });
    expect(superCommandMutations(command, context())).toContainEqual({
      kind: 'permission_change',
      handle: 'dev-1',
    });
    expect(effects(command)).toEqual(['security']);
  });

  it.each([
    ['operator', 'ai_operator', 'model'],
    ['operator', 'ai_operator', 'instructions'],
    ['operator', 'ai_operator', 'roleOverride'],
    ['pm', 'project_manager', 'model'],
    ['pm', 'project_manager', 'instructions'],
    ['pm', 'project_manager', 'roleOverride'],
  ] as const)('reserves %s self changes (%s): %s', (handle, role, field) => {
    const ctx = context();
    ctx.config.team.members.push(
      AiMemberConfig.parse({
        handle,
        kind: 'ai',
        displayName: 'Operator',
        role,
        sponsor: 'owner',
      }),
    );
    const command: SuperCommand =
      field === 'roleOverride'
        ? operate({
            op: 'config_patch',
            patch: {
              roleOverrides: {
                [role]: { duties: ['project_operation'], instructions: 'Updated role instructions' },
              },
            },
          })
        : { kind: 'member_update', handle, request: { [field]: 'Updated value' } };
    expect(superCommandMutations(command, ctx)).toContainEqual({
      kind: 'permission_change',
      handle,
    });
    expect(superCommandEffects(command, ctx)).toEqual(['security']);
  });

  it('reserves a coordinator member edit at the final configuration boundary', () => {
    const previous = config();
    previous.team.members.push(
      AiMemberConfig.parse({
        kind: 'ai',
        handle: 'pm',
        displayName: 'PM',
        role: 'project_manager',
        sponsor: 'owner',
      }),
    );
    const next = structuredClone(previous);
    next.team.members.find((member) => member.handle === 'pm')!.displayName = 'Updated PM';
    expect(superConfigMutations(previous, next)).toContainEqual({ kind: 'permission_change', handle: 'pm' });
    expect(ownerReservedEffect(previous, { kind: 'config_change', next })).toBe('security');
  });
});
