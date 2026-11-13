import type { InboxItem, ResolveInboxRequest } from '@projectman/shared';
import { projectManagerKnowledgeApprovalOf } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useResolveInbox } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';

const STALE_CODE = 'operator_approval_stale';

/** Whether an error is the server's "this approval is out of date": it shows on the card, not as a toast. */
export function isStaleError(error: unknown): boolean {
  return isApiError(error) && (error.code === STALE_CODE || error.code === 'operator_knowledge_stale');
}

/** What the toast says after a knowledge approval was decided; dismissing a stale one says nothing. */
export function operatorDecisionToast(item: InboxItem, optionId: string): string | null {
  const knowledge = projectManagerKnowledgeApprovalOf(item);
  if (optionId === 'approve' && knowledge)
    return t(
      knowledge.change.kind === 'agreement_replace'
        ? 'knowledge.proposal.approvedAgreement'
        : knowledge.change.kind === 'principle_remove'
          ? 'knowledge.proposal.approvedRemove'
          : 'knowledge.proposal.approvedPrinciple',
    );
  if (optionId === 'reject') return t('operator.approval.rejected');
  return null;
}

/**
 * Deciding an Operator knowledge approval (PM-447) from the Operator's steps. Approve and reject say so in a toast;
 * a stale answer (409) is not a toast: `staleFor` makes the card show its stale bar.
 */
export function useOperatorDecision() {
  const { key, myHandle } = useProject();
  const resolve = useResolveInbox(key, myHandle);
  const toast = useToast();
  const mine = (item: InboxItem) => resolve.variables?.item.id === item.id;
  return {
    decide: (item: InboxItem, body: ResolveInboxRequest) =>
      resolve.mutate(
        { item, body },
        {
          onSuccess: () => {
            const text = operatorDecisionToast(item, body.optionId);
            if (text) toast.show(text, 'ok');
          },
          onError: (error) => {
            if (!isStaleError(error)) toast.show(errorMessage(error), 'error');
          },
        },
      ),
    pending: (item: InboxItem) => resolve.isPending && mine(item),
    staleFor: (item: InboxItem) => resolve.isError && mine(item) && isStaleError(resolve.error),
  };
}
