import type { ProjectManagerKnowledgeDocument, ProjectManagerPreferenceDocument } from '@projectman/shared';

/** Private server storage. Authorization and principle id generation belong to the caller. */
export interface ProjectManagerKnowledgeStore {
  readKnowledge(projectKey: string): Promise<ProjectManagerKnowledgeDocument>;
  compareAndSwapKnowledge(
    projectKey: string,
    expectedRevision: number,
    next: ProjectManagerKnowledgeDocument,
  ): Promise<ProjectManagerKnowledgeDocument>;
  /** The instance-level knowledge of the connected Claude (PM-1046): one document for the whole server. */
  readInstanceKnowledge(): Promise<ProjectManagerKnowledgeDocument>;
  compareAndSwapInstanceKnowledge(
    expectedRevision: number,
    next: ProjectManagerKnowledgeDocument,
  ): Promise<ProjectManagerKnowledgeDocument>;
  readPreference(projectKey: string, handle: string): Promise<ProjectManagerPreferenceDocument>;
  compareAndSwapPreference(
    projectKey: string,
    handle: string,
    expectedRevision: number,
    next: ProjectManagerPreferenceDocument,
  ): Promise<ProjectManagerPreferenceDocument>;
}
