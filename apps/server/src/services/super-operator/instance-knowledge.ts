import { OperatorAgreementData, OperatorPrincipleData } from '@projectman/shared';
import type { OperatorKnowledgeDocument } from '@projectman/shared';
import { z } from 'zod';
import type { OperatorKnowledgeStore } from '../../contracts';
import { invalid, newId } from '../../kernel';

/** Who approved the instance knowledge: the connected owner, through the Operator's super key. */
const APPROVED_BY = 'owner';

/** A principle the Operator writes; the server gives a new one its id and keeps the id of an existing one. */
const PrincipleInput = OperatorPrincipleData.extend({ id: OperatorPrincipleData.shape.id.optional() });

export const UpdateInstanceKnowledgeInput = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  agreement: OperatorAgreementData.optional(),
  principles: z.array(PrincipleInput).max(20).optional(),
});
export type UpdateInstanceKnowledgeInput = z.infer<typeof UpdateInstanceKnowledgeInput>;

type Store = Pick<OperatorKnowledgeStore, 'readInstanceKnowledge' | 'compareAndSwapInstanceKnowledge'>;

/**
 * The instance-level knowledge of the global Operator (PM-1046): the same document as a project's, but one for
 * the whole server and written directly, because the owner is the one connected. A stale revision is refused
 * with `operator_knowledge_stale`; `principles` replaces the whole list, `agreement` the whole agreement.
 */
export async function updateInstanceKnowledge(
  store: Store,
  input: UpdateInstanceKnowledgeInput,
  at: string,
): Promise<OperatorKnowledgeDocument> {
  const parsed = UpdateInstanceKnowledgeInput.safeParse(input);
  if (!parsed.success) throw invalid('invalid_request', 'invalid instance knowledge update');
  const { expectedRevision, agreement, principles } = parsed.data;
  if (agreement === undefined && principles === undefined)
    throw invalid('invalid_request', 'give an agreement, principles or both');
  const previous = await store.readInstanceKnowledge();
  const next: OperatorKnowledgeDocument = { ...structuredClone(previous), revision: expectedRevision + 1 };
  if (agreement !== undefined)
    next.agreement = {
      version: (previous.agreement?.version ?? 0) + 1,
      data: agreement,
      approvedBy: APPROVED_BY,
      approvedAt: at,
    };
  if (principles !== undefined)
    next.principles = principles.map((principle) => {
      const id = principle.id ?? newId('olp');
      const before = previous.principles.find((entry) => entry.id === id);
      const data = { ...principle, id };
      const unchanged =
        before !== undefined &&
        before.example === data.example &&
        before.principle === data.principle &&
        before.effect === data.effect;
      return unchanged ? before : { ...data, approvedBy: APPROVED_BY, approvedAt: at };
    });
  // The store's compare-and-swap refuses a write over another revision, so a read that went stale meanwhile fails there.
  return store.compareAndSwapInstanceKnowledge(expectedRevision, next);
}
