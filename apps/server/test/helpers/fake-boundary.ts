import type { BoundaryTarget } from '@projectman/shared';
import type { BoundaryOperationAdapter, BoundaryRequester } from '../../src/contracts';

/** Protected registry fake: the agent supplies neither a category nor target metadata. */
export class FakeBoundaryAdapter implements BoundaryOperationAdapter {
  readonly operations = new Map<string, { requester: BoundaryRequester; target: BoundaryTarget }>();
  register(id: string, requester: BoundaryRequester, target: BoundaryTarget): void {
    this.operations.set(id, { requester: structuredClone(requester), target: structuredClone(target) });
  }
  resolve(requester: BoundaryRequester, id: string): BoundaryTarget | null {
    const operation = this.operations.get(id);
    if (!operation || JSON.stringify(operation.requester) !== JSON.stringify(requester)) return null;
    return structuredClone(operation.target);
  }
}

export const fakeBoundaryTarget = (patch: Partial<BoundaryTarget> = {}): BoundaryTarget => ({
  operation: 'read_external',
  resource: 'https://example.test/docs',
  environment: 'development',
  branch: null,
  protectedBranch: false,
  scope: 'single_operation',
  expiresAt: '2026-10-01T12:00:00.000Z',
  policyVersion: 'fake-policy-1',
  ...patch,
});
