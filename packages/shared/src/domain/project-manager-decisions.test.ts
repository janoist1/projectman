import { describe, expect, it } from 'vitest';
import { ProjectConfig } from '../config/schema';
import { boundaryLeads, canDecideBoundary } from './boundary';
import type { BoundaryRequest } from './boundary';
import { canDecidePermission, permissionDeciders } from './permission-delegation';
import type { PermissionDelegation } from './permission-delegation';

/** The project manager holds the boundary authorization duty here (a role override), as a misconfiguration would. */
const config = () =>
  ProjectConfig.parse({
    schemaVersion: 1,
    project: { key: 'AR', name: 'Example', workspacePath: '/work', repos: [] },
    team: {
      boundary: { enabled: true, leadTimeoutSeconds: 120 },
      limits: {},
      roleOverrides: { project_manager: { duties: ['boundary_authorization'], instructions: '' } },
      members: [
        { kind: 'human', handle: 'owner', displayName: 'Owner', access: 'owner', roles: ['operator'] },
        { kind: 'ai', handle: 'pm', displayName: 'PM', role: 'project_manager', sponsor: 'owner' },
        { kind: 'ai', handle: 'ai-lead', displayName: 'AI lead', role: 'lead_developer', sponsor: 'owner' },
        { kind: 'ai', handle: 'dev', displayName: 'Developer', role: 'developer', sponsor: 'owner' },
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

const request: BoundaryRequest = {
  id: 'request-1',
  projectKey: 'AR',
  member: 'dev',
  sessionId: 'session-1',
  taskKey: null,
  operationId: 'operation-1',
  deduplicationKey: 'retry-1',
  target: {
    operation: 'read_external',
    resource: 'example.test/resource',
    environment: 'development',
    branch: 'task-1',
    protectedBranch: false,
    scope: 'single_operation',
    policyVersion: 'policy-1',
    expiresAt: '2026-10-01T12:00:00.000Z',
  },
  category: 'delegable',
  policyVersion: 'policy-1',
  state: 'pending_lead',
  assignees: ['pm', 'ai-lead'],
  leadDeadline: '2026-10-01T11:02:00.000Z',
  expiresAt: '2026-10-01T12:00:00.000Z',
  createdAt: '2026-10-01T11:00:00.000Z',
  updatedAt: '2026-10-01T11:00:00.000Z',
  decidedBy: null,
  reason: null,
};

describe('the project manager does not decide (PM-433)', () => {
  it('is no boundary lead and no permission decider, even holding the duty, while a lead is', () => {
    expect(boundaryLeads(config(), 'dev')).toEqual(['ai-lead']);
    expect(permissionDeciders(config(), 'dev')).toEqual(['ai-lead']);
  });

  it('may not decide a boundary request, even one that names it', () => {
    expect(canDecideBoundary(config(), request, 'pm')).toBe(false);
    expect(canDecideBoundary(config(), request, 'ai-lead')).toBe(true);
  });

  it('may not decide a delegated permission request', () => {
    const delegation: PermissionDelegation = {
      state: 'pending_lead',
      leads: ['pm', 'ai-lead'],
      leadDeadline: '2026-10-01T11:02:00.000Z',
    };
    const early = Date.parse('2026-10-01T11:00:00Z');
    expect(canDecidePermission(config(), 'dev', delegation, 'pm', early)).toBe(false);
    expect(canDecidePermission(config(), 'dev', delegation, 'ai-lead', early)).toBe(true);
  });
});
