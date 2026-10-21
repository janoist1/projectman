import type { ProjectConfig } from '@projectman/shared';

/** Called only inside the project's configuration lock. */
export interface OperatorConfigAuthorization {
  authorize(input: {
    projectKey: string;
    operator: string;
    requestId: string;
    previous: ProjectConfig;
    next: ProjectConfig;
    expectedAgreementVersion: number;
  }): Promise<{ mode: 'click' | 'waived'; agreementVersion: number | null }>;
  /** The owner's own-login request in the app already stands for the approval of this change (decision 55). */
  autonomousCommit(input: {
    projectKey: string;
    operator: string;
    requestId: string;
    previous: ProjectConfig;
    next: ProjectConfig;
  }): boolean;
}
