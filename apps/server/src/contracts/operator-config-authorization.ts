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
}
