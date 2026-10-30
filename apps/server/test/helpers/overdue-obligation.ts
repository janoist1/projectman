import type { ObligationKind, Task } from '@projectman/shared';
import type { DomainHarness } from './domain-harness';

/**
 * PM-1152: an open obligation row of `card` that the project manager has been told about (its second rung
 * has run), and the `obligation_overdue` signal row that carries it. The signal is raised but not delivered:
 * the caller delivers it (`operatorSignals.deliver`) when the test needs the PM to have it.
 */
export function openOverdueObligation(
  h: DomainHarness,
  card: Task,
  opts: { at: Date; kind?: ObligationKind; responsible?: string },
): { id: string; signalId: string } {
  const id = `obl_${card.key}`;
  const at = opts.at.toISOString();
  h.repos.obligations.insert({
    id,
    projectKey: card.projectKey,
    taskKey: card.key,
    kind: opts.kind ?? 'work',
    responsible: opts.responsible ?? card.assignee ?? 'dev-1',
    subject: card.key,
    openedAt: at,
    dueAt: at,
  });
  h.repos.obligations.update(id, { pmToldAt: at }, at);
  const signalId = h.domain.operatorSignals.raiseObligationOverdue({
    projectKey: card.projectKey,
    taskKey: card.key,
    obligationId: id,
  });
  return { id, signalId };
}
