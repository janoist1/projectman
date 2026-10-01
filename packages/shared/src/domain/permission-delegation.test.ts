import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import {
  canDecidePermission,
  permissionDelegationOf,
  permissionDelegationState,
  permissionDeciders,
  routePermissionRequest,
} from './permission-delegation';
import type { PermissionDelegation } from './permission-delegation';

function config(
  opts: {
    boundary?: boolean;
    onLeave?: boolean;
    approver?: 'ai' | 'human' | 'none';
    aiEnabled?: boolean;
  } = {},
) {
  return ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AC', name: 'Acme', workspacePath: '/work/acme', repos: [] },
    team: {
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        {
          kind: 'ai',
          handle: 'dev-1',
          displayName: 'Developer',
          role: 'developer',
          sponsor: 'owner',
          approver: opts.approver ?? 'ai',
        },
        {
          kind: 'ai',
          handle: 'lead',
          displayName: 'Lead',
          role: 'lead_developer',
          sponsor: 'owner',
          ...(opts.onLeave ? { onLeave: true } : {}),
        },
      ],
      ...(opts.boundary === false ? {} : { boundary: { enabled: true, leadTimeoutSeconds: 120 } }),
      limits: opts.aiEnabled === false ? { aiEnabled: false } : {},
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

const roots = ['/work/acme'];
const curl = { toolName: 'Bash', toolInput: { command: 'curl https://example.com' }, roots };

describe('routePermissionRequest', () => {
  it('sends an ordinary question of an `ai` member to the decider', () => {
    expect(routePermissionRequest(config(), 'dev-1', curl)).toEqual({ to: 'ai', leads: ['lead'] });
  });

  it.each(['human', 'none'] as const)('leaves a member with approver %s to a person', (approver) => {
    expect(routePermissionRequest(config({ approver }), 'dev-1', curl)).toEqual({
      to: 'human',
      why: 'approver_human',
    });
  });

  it('sends the owner’s categories to a person, with the category', () => {
    expect(
      routePermissionRequest(config(), 'dev-1', { ...curl, toolInput: { command: 'npm publish' } }),
    ).toEqual({ to: 'human', why: 'owner_category', category: 'production' });
  });

  it('sends a request to a person when no decider is at work', () => {
    const none = { to: 'human', why: 'no_decider' };
    expect(routePermissionRequest(config({ boundary: false }), 'dev-1', curl)).toEqual(none);
    expect(routePermissionRequest(config({ onLeave: true }), 'dev-1', curl)).toEqual(none);
    expect(routePermissionRequest(config({ aiEnabled: false }), 'dev-1', curl)).toEqual(none);
    // The decider’s own request has no other decider.
    expect(routePermissionRequest(config({ approver: 'ai' }), 'lead', curl)).toMatchObject({
      to: 'human',
    });
  });
});

describe('the delegation of an item', () => {
  const delegation: PermissionDelegation = {
    state: 'pending_lead',
    leads: ['lead'],
    leadDeadline: '2026-10-01T11:02:00.000Z',
  };
  const at = (iso: string) => Date.parse(iso);

  it('is read from the payload, and absent or broken ones are null', () => {
    expect(permissionDelegationOf({ payload: { delegation } })).toEqual(delegation);
    expect(permissionDelegationOf({ payload: {} })).toBeNull();
    expect(permissionDelegationOf({ payload: { delegation: { state: 'allowed' } } })).toBeNull();
  });

  it('waits for the decider until the deadline, then belongs to a person', () => {
    expect(permissionDelegationState(config(), 'dev-1', delegation, at('2026-10-01T11:01:59Z'))).toBe(
      'pending_lead',
    );
    expect(permissionDelegationState(config(), 'dev-1', delegation, at('2026-10-01T11:02:00Z'))).toBe(
      'pending_owner',
    );
    expect(permissionDelegationState(config(), 'dev-1', { ...delegation, state: 'pending_owner' }, 0)).toBe(
      'pending_owner',
    );
  });

  it('belongs to a person as soon as no chosen decider is at work', () => {
    const early = at('2026-10-01T11:00:00Z');
    for (const changed of [config({ onLeave: true }), config({ boundary: false })])
      expect(permissionDelegationState(changed, 'dev-1', delegation, early)).toBe('pending_owner');
    expect(permissionDeciders(config(), 'dev-1')).toEqual(['lead']);
  });

  it('may be decided by a chosen, live, independent decider in time, and by nobody else', () => {
    const early = at('2026-10-01T11:00:00Z');
    expect(canDecidePermission(config(), 'dev-1', delegation, 'lead', early)).toBe(true);
    expect(canDecidePermission(config(), 'dev-1', delegation, 'lead', at('2026-10-01T11:03:00Z'))).toBe(
      false,
    );
    expect(canDecidePermission(config(), 'dev-1', delegation, 'dev-1', early)).toBe(false);
    expect(canDecidePermission(config(), 'dev-1', delegation, 'owner', early)).toBe(false);
    expect(canDecidePermission(config(), 'lead', delegation, 'lead', early)).toBe(false);
    expect(canDecidePermission(config({ onLeave: true }), 'dev-1', delegation, 'lead', early)).toBe(false);
  });
});
