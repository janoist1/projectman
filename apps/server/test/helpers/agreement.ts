import type { ProjectManagerAgreementData } from '@projectman/shared';
import type { DomainHarness } from './domain-harness';

/** Approves a working agreement of project AR with the given involvement level (PM-1459). */
export async function setAgreementInvolvement(
  h: DomainHarness,
  involvement: ProjectManagerAgreementData['involvement'],
  approvedAt: string,
): Promise<void> {
  const store = h.domain.projectManagerKnowledge;
  const doc = await store.readKnowledge('AR');
  await store.compareAndSwapKnowledge('AR', doc.revision, {
    ...doc,
    revision: doc.revision + 1,
    agreement: {
      version: 1,
      approvedBy: 'owner',
      approvedAt,
      data: { summary: 'Working agreement', involvement, extraCritical: [] },
    },
  });
}
