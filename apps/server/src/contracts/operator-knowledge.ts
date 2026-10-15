import type { OperatorKnowledgeDocument, OperatorPreferenceDocument } from '@projectman/shared';

/** Private server storage. Authorization and principle id generation belong to the caller. */
export interface OperatorKnowledgeStore {
  readKnowledge(projectKey: string): Promise<OperatorKnowledgeDocument>;
  compareAndSwapKnowledge(
    projectKey: string,
    expectedRevision: number,
    next: OperatorKnowledgeDocument,
  ): Promise<OperatorKnowledgeDocument>;
  readPreference(projectKey: string, handle: string): Promise<OperatorPreferenceDocument>;
  compareAndSwapPreference(
    projectKey: string,
    handle: string,
    expectedRevision: number,
    next: OperatorPreferenceDocument,
  ): Promise<OperatorPreferenceDocument>;
}
