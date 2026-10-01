import type { BoundaryRequest, InboxItem } from '@projectman/shared';

export function boundaryInboxFixture(): InboxItem {
  const createdAt = new Date().toISOString();
  const request: BoundaryRequest = {
    id: 'bnd_fixture',
    projectKey: 'AC',
    member: 'fe-1',
    sessionId: 'ses_ac21_fe1',
    taskKey: 'AC-21',
    operationId: 'docs',
    deduplicationKey: 'retry-1',
    target: {
      operation: 'read_external',
      resource: 'https://example.test/docs',
      environment: 'development',
      branch: null,
      protectedBranch: false,
      scope: 'single_operation',
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      policyVersion: 'policy-1',
    },
    category: 'delegable',
    policyVersion: 'policy-1',
    state: 'pending_lead',
    assignees: ['code-review'],
    leadDeadline: new Date(Date.now() + 120000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    createdAt,
    updatedAt: createdAt,
    decidedBy: null,
    reason: null,
  };
  return {
    id: request.id,
    projectKey: 'AC',
    kind: 'boundary',
    assignees: ['code-review', 'owner'],
    source: request.member,
    sessionId: request.sessionId,
    taskKey: request.taskKey,
    title: request.target.resource,
    body: null,
    payload: { boundary: request },
    options: [
      { id: 'allow', label: 'allow', style: 'primary' },
      { id: 'deny', label: 'deny', style: 'danger' },
    ],
    state: 'open',
    resolution: null,
    createdAt,
  };
}
