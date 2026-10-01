import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import { ownerOnlyChanges } from '../config/owner-only';
import {
  BoundaryRequest,
  BoundaryTarget,
  SubmitBoundaryRequest,
  boundaryCategory,
  boundaryWaitingState,
  canDecideBoundary,
} from './boundary';

const config = () =>
  ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Example', workspacePath: '/work', repos: [] },
    team: {
      boundary: { enabled: true, leadTimeoutSeconds: 120 },
      limits: {},
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'human', handle: 'admin', displayName: 'Admin', access: 'admin', roles: [] },
        {
          kind: 'human',
          handle: 'human-lead',
          displayName: 'Human lead',
          access: 'developer',
          roles: ['lead_developer'],
        },
        {
          kind: 'human',
          handle: 'viewer',
          displayName: 'Viewer',
          access: 'viewer',
          roles: ['lead_developer'],
        },
        { kind: 'ai', handle: 'ai-lead', displayName: 'AI lead', role: 'lead_developer', sponsor: 'owner' },
        {
          kind: 'ai',
          handle: 'requester',
          displayName: 'Requester',
          role: 'lead_developer',
          sponsor: 'owner',
        },
        { kind: 'ai', handle: 'developer', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
      ],
    },
    pipeline: {
      columns: [{ id: 'all', name: 'All' }],
      stages: [
        { id: 'todo', name: 'Todo', kind: 'queue', columnId: 'all' },
        { id: 'done', name: 'Done', kind: 'done', columnId: 'all' },
      ],
    },
  });
const target = (operation: BoundaryTarget['operation']): BoundaryTarget => ({
  operation,
  resource: 'example.test/resource',
  environment: 'development',
  branch: 'task-1',
  protectedBranch: false,
  scope: 'single_operation',
  policyVersion: 'policy-1',
  expiresAt: '2026-10-01T12:00:00.000Z',
});
const request = (operation: BoundaryTarget['operation']): BoundaryRequest => ({
  id: 'request-1',
  projectKey: 'AR',
  member: 'requester',
  sessionId: 'session-1',
  taskKey: null,
  operationId: 'operation-1',
  deduplicationKey: 'retry-1',
  target: target(operation),
  category: boundaryCategory(target(operation)),
  policyVersion: 'policy-1',
  state: operation === 'read_external' ? 'pending_lead' : 'pending_owner',
  assignees: ['ai-lead', 'human-lead'],
  leadDeadline: '2026-10-01T11:02:00.000Z',
  expiresAt: '2026-10-01T12:00:00.000Z',
  createdAt: '2026-10-01T11:00:00.000Z',
  updatedAt: '2026-10-01T11:00:00.000Z',
  decidedBy: null,
  reason: null,
});

describe('boundary rules', () => {
  const operations = ['read_external', 'spend', 'production_change', 'create_secret', 'expand_host'] as const;
  const actors = ['owner', 'admin', 'human-lead', 'viewer', 'ai-lead', 'requester', 'developer', 'unknown'];
  it.each(operations.flatMap((operation) => actors.map((actor) => ({ operation, actor }))))(
    'category × decider: $operation × $actor',
    ({ operation, actor }) => {
      expect(canDecideBoundary(config(), request(operation), actor)).toBe(
        actor === 'owner' || (operation === 'read_external' && ['human-lead', 'ai-lead'].includes(actor)),
      );
    },
  );
  it('does not trust a forged delegable category or owner assignee list for an AI', () => {
    const forged = {
      ...request('spend'),
      state: 'pending_lead' as const,
      category: 'delegable' as const,
      assignees: ['ai-lead', 'owner'],
    };
    expect(canDecideBoundary(config(), forged, 'ai-lead')).toBe(false);
    expect(canDecideBoundary(config(), forged, 'owner')).toBe(true);
  });
  it('keeps all terminal states closed and pending owner states human owner-only', () => {
    for (const state of ['allowed', 'denied', 'revoked', 'expired'] as const) {
      for (const actor of actors)
        expect(canDecideBoundary(config(), { ...request('read_external'), state }, actor)).toBe(false);
    }
    expect(
      canDecideBoundary(config(), { ...request('read_external'), state: 'pending_owner' }, 'ai-lead'),
    ).toBe(false);
  });
  it('applies deadline, leave and AI switch checks without resetting the stored deadline', () => {
    const r = request('read_external');
    expect(boundaryWaitingState(config(), r, Date.parse(r.leadDeadline))).toBe('pending_owner');
    expect(boundaryWaitingState(config(), r, Date.parse(r.expiresAt))).toBe('expired');
    const c = config();
    c.team.limits.aiEnabled = false;
    expect(canDecideBoundary(c, r, 'ai-lead')).toBe(false);
    expect(canDecideBoundary(c, r, 'human-lead')).toBe(true);
    c.team.members = c.team.members.filter((m) => m.handle !== 'human-lead');
    expect(boundaryWaitingState(c, r, Date.parse(r.createdAt))).toBe('pending_owner');
  });
  it('refuses decisions after the requester leaves the live roster', () => {
    const c = config();
    c.team.members = c.team.members.filter((m) => m.handle !== 'requester');
    expect(canDecideBoundary(c, request('read_external'), 'ai-lead')).toBe(false);
    expect(canDecideBoundary(c, request('read_external'), 'owner')).toBe(false);
  });
  it('keeps a consumed approval unchanged by the deadline rule', () => {
    const r = {
      ...request('read_external'),
      state: 'allowed' as const,
      consumedAt: '2026-10-01T11:01:00.000Z',
    };
    expect(boundaryWaitingState(config(), r, Date.parse(r.expiresAt))).toBe('allowed');
  });
  it.each([
    (c: ProjectConfig) => {
      c.team.boundary!.enabled = false;
    },
    (c: ProjectConfig) => {
      c.team.boundary!.leadTimeoutSeconds = 600;
    },
    (c: ProjectConfig) => {
      c.team.roleOverrides = {
        developer: { duties: ['implementation', 'boundary_authorization'], instructions: '' },
      };
    },
    (c: ProjectConfig) => {
      const m = c.team.members.find((m) => m.handle === 'developer')!;
      if (m.kind === 'ai') m.role = 'lead_developer';
    },
    (c: ProjectConfig) => {
      c.team.roles.push({
        id: 'new_lead',
        name: 'Lead',
        summary: 'Decide',
        holders: 'both',
        duties: ['boundary_authorization'],
        instructions: '',
        notTheirJob: '',
      });
    },
  ])('requires owner access for delegation configuration and duty assignments', (edit) => {
    const previous = config();
    const next = structuredClone(previous);
    edit(next);
    expect(ownerOnlyChanges(previous, next)).toContain('approval_policy');
  });
  it('keeps old configurations disabled and refuses caller target metadata and credential-shaped resources', () => {
    const c = config();
    delete c.team.boundary;
    expect(ProjectConfig.parse(c).team.boundary).toBeUndefined();
    expect(canDecideBoundary(c, request('read_external'), 'ai-lead')).toBe(false);
    expect(
      SubmitBoundaryRequest.safeParse({
        operationId: 'op',
        deduplicationKey: 'retry',
        target: target('read_external'),
      }).success,
    ).toBe(false);
    expect(
      BoundaryTarget.safeParse({
        ...target('read_external'),
        resource: 'https://user:credential@example.test?token=value',
      }).success,
    ).toBe(false);
  });
});
