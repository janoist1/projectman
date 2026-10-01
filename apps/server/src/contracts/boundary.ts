import type { BoundaryTarget } from '@projectman/shared';

export interface BoundaryRequester {
  projectKey: string;
  member: string;
  sessionId: string;
  taskKey: string | null;
}
/** Protected control-plane adapter. Resolve an opaque operation id against its own registry and
 * verify requester ownership. Return null for unknown or inaccessible operations. Metadata must
 * be public and credential-free. Re-resolve before decisions and grant use. The executor must
 * enforce the returned single-operation scope atomically, never treat a grant as a CLI approval. */
export interface BoundaryOperationAdapter {
  /** Local registry lookup only; a network operation must not delay the escalation timer. */
  resolve(requester: BoundaryRequester, operationId: string): BoundaryTarget | null;
}
