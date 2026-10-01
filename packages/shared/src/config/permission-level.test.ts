import { describe, expect, it } from 'vitest';
import { Approver, PermissionMode, SelectablePermissionMode } from '../domain/member';
import { PROVIDER_PERMISSION_MODES } from '../domain/provider-model';
import {
  aiApproverBlocker,
  approverBlocker,
  approverOf,
  isLegacyBypass,
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

describe('the approver', () => {
  it('reads as a person when none is stored', () => {
    expect(approverOf({})).toBe('human');
    for (const approver of Approver.options) expect(approverOf({ approver })).toBe(approver);
  });
});

describe('the selectable modes', () => {
  it('are the CLI modes except bypassPermissions, and all allowed for both providers', () => {
    expect(SelectablePermissionMode.options).toEqual(['default', 'acceptEdits', 'plan', 'auto']);
    for (const mode of SelectablePermissionMode.options) {
      expect(PROVIDER_PERMISSION_MODES.codex).toContain(mode);
      expect(PROVIDER_PERMISSION_MODES.claude).toContain(mode);
    }
    expect(PermissionMode.options).toContain('bypassPermissions');
  });

  it('marks only a member in bypassPermissions as legacy', () => {
    expect(isLegacyBypass({ permissionMode: 'bypassPermissions' })).toBe(true);
    for (const mode of SelectablePermissionMode.options)
      expect(isLegacyBypass({ permissionMode: mode })).toBe(false);
  });
});

describe('the AI approver', () => {
  it('needs delegation to be on', () => {
    expect(aiApproverBlocker(config({ boundary: false }), 'dev-1')).toBe('delegation_off');
    expect(aiApproverBlocker(config(), 'dev-1')).toBe('delegation_off');
  });

  it('needs another AI member at work that holds the authorization duty', () => {
    expect(aiApproverBlocker(config({ boundary: true }), 'dev-1')).toBeNull();
    // The lead cannot decide for itself.
    expect(aiApproverBlocker(config({ boundary: true }), 'lead')).toBe('no_ai_decider');
    expect(aiApproverBlocker(config({ boundary: true, onLeave: true }), 'dev-1')).toBe('no_ai_decider');
    expect(aiApproverBlocker(config({ boundary: true, deciderRole: 'developer' }), 'dev-1')).toBe(
      'no_ai_decider',
    );
  });

  it('is the only approver that can be blocked', () => {
    const off = config();
    expect(approverBlocker(off, 'dev-1', 'ai')).toBe('delegation_off');
    for (const approver of ['human', 'none'] as const) {
      expect(approverBlocker(off, 'dev-1', approver)).toBeNull();
    }
  });
});

describe('the roster fields', () => {
  it('carry the mode, the effective approver, the legacy mark and the blocker', () => {
    expect(permissionView(config(), { handle: 'dev-1', permissionMode: 'bypassPermissions' })).toEqual({
      permissionMode: 'bypassPermissions',
      approver: 'human',
      permissionLegacy: true,
      aiApproverBlocker: 'delegation_off',
    });
    expect(
      permissionView(config({ boundary: true }), { handle: 'dev-1', permissionMode: 'auto', approver: 'ai' }),
    ).toEqual({ permissionMode: 'auto', approver: 'ai' });
  });
});
