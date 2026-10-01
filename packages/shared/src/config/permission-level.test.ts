import { describe, expect, it } from 'vitest';
import { PermissionLevel, PermissionMode } from '../domain/member';
import { PROVIDER_PERMISSION_MODES } from '../domain/provider-model';
import {
  askAiBlocker,
  cliPermissionMode,
  effectivePermissionMode,
  isLegacyBypass,
  permissionLevelBlocker,
  permissionLevelFromMode,
  permissionLevelOf,
  permissionView,
} from './permission-level';
import { ProjectConfig } from './schema';

function config(
  opts: { boundary?: boolean; deciderRole?: 'code_review' | 'developer'; onLeave?: boolean } = {},
) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'ai', handle: 'dev-1', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'lead',
          displayName: 'Lead',
          role: opts.deciderRole ?? 'lead_developer',
          sponsor: 'owner',
          ...(opts.onLeave ? { onLeave: true } : {}),
        },
      ],
      ...(opts.boundary ? { boundary: { enabled: true, leadTimeoutSeconds: 120 } } : {}),
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

describe('the level of a member without a stored level', () => {
  it.each<[PermissionMode | undefined, PermissionLevel]>([
    ['plan', 'plan'],
    ['auto', 'auto'],
    ['default', 'ask_human'],
    ['acceptEdits', 'ask_human'],
    ['bypassPermissions', 'ask_human'],
    [undefined, 'ask_human'],
  ])('derives it from %s', (mode, level) => {
    expect(permissionLevelFromMode(mode)).toBe(level);
    expect(permissionLevelOf({ permissionMode: mode })).toBe(level);
  });

  it('never makes a member freer than its historical mode', () => {
    const freedom: Record<PermissionLevel, number> = { plan: 0, ask_human: 1, ask_ai: 1, auto: 2 };
    const modeFreedom: Record<PermissionMode, number> = {
      plan: 0,
      default: 1,
      acceptEdits: 2,
      auto: 2,
      bypassPermissions: 3,
    };
    for (const mode of PermissionMode.options) {
      expect(freedom[permissionLevelFromMode(mode)], mode).toBeLessThanOrEqual(modeFreedom[mode]);
    }
  });

  it('prefers a stored level', () => {
    expect(permissionLevelOf({ permissionLevel: 'plan', permissionMode: 'auto' })).toBe('plan');
  });
});

describe('the agent CLI mode', () => {
  it('follows from the level, and never from the old field once a level is stored', () => {
    expect(PermissionLevel.options.map(cliPermissionMode)).toEqual(['auto', 'default', 'default', 'plan']);
    expect(
      effectivePermissionMode({ permissionLevel: 'ask_human', permissionMode: 'bypassPermissions' }),
    ).toBe('default');
    expect(effectivePermissionMode({ permissionMode: 'acceptEdits' })).toBe('acceptEdits');
    expect(effectivePermissionMode({})).toBe('default');
  });

  it('is never bypassPermissions, and is allowed for every provider', () => {
    for (const level of PermissionLevel.options) {
      const mode = cliPermissionMode(level);
      expect(mode).not.toBe('bypassPermissions');
      expect(PROVIDER_PERMISSION_MODES.codex).toContain(mode);
      expect(PROVIDER_PERMISSION_MODES.claude).toContain(mode);
    }
  });

  it('marks only a member that still runs in bypassPermissions as legacy', () => {
    expect(isLegacyBypass({ permissionMode: 'bypassPermissions' })).toBe(true);
    expect(isLegacyBypass({ permissionMode: 'bypassPermissions', permissionLevel: 'auto' })).toBe(false);
    expect(isLegacyBypass({ permissionMode: 'auto' })).toBe(false);
  });
});

describe('"ask, AI decides"', () => {
  it('needs delegation to be on', () => {
    expect(askAiBlocker(config({ boundary: false }), 'dev-1')).toBe('delegation_off');
    expect(askAiBlocker(config(), 'dev-1')).toBe('delegation_off');
  });

  it('needs another AI member at work that holds the authorization duty', () => {
    expect(askAiBlocker(config({ boundary: true }), 'dev-1')).toBeNull();
    // The lead cannot decide for itself.
    expect(askAiBlocker(config({ boundary: true }), 'lead')).toBe('no_ai_decider');
    expect(askAiBlocker(config({ boundary: true, onLeave: true }), 'dev-1')).toBe('no_ai_decider');
    expect(askAiBlocker(config({ boundary: true, deciderRole: 'developer' }), 'dev-1')).toBe('no_ai_decider');
  });

  it('is the only level that can be blocked', () => {
    const off = config();
    expect(permissionLevelBlocker(off, 'dev-1', 'ask_ai')).toBe('delegation_off');
    for (const level of ['auto', 'ask_human', 'plan'] as const) {
      expect(permissionLevelBlocker(off, 'dev-1', level)).toBeNull();
    }
  });
});

describe('the roster fields', () => {
  it('carry the level, the legacy mark and the blocker', () => {
    const view = permissionView(config(), { handle: 'dev-1', permissionMode: 'bypassPermissions' });
    expect(view).toEqual({
      permissionMode: 'bypassPermissions',
      permissionLevel: 'ask_human',
      permissionLegacy: true,
      askAiBlocker: 'delegation_off',
    });
    expect(
      permissionView(config({ boundary: true }), { handle: 'dev-1', permissionLevel: 'ask_ai' }),
    ).toEqual({
      permissionLevel: 'ask_ai',
    });
  });
});
