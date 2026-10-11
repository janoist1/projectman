import clsx from 'clsx';
import { useState } from 'react';
import type { InboxItem, OperatorApprovalPayload, ResolveInboxRequest } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useResolveInbox } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import type { ButtonVariant } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import { OperatorChanges } from './OperatorChanges';
import styles from './OperatorApproval.module.css';

const STALE_CODE = 'operator_approval_stale';

/** Whether an error is the server's "this approval is out of date": it shows on the card, not as a toast. */
export function isStaleError(error: unknown): boolean {
  return isApiError(error) && error.code === STALE_CODE;
}

/** What the toast says after an approval was decided; dismissing a stale one says nothing. */
export function operatorDecisionToast(item: InboxItem, optionId: string): string | null {
  if (optionId === 'approve') return t('operator.approval.approved', { title: item.title });
  if (optionId === 'reject') return t('operator.approval.rejected');
  return null;
}

/**
 * Deciding an Operator approval (PM-447) from the Operator's steps. Approve and reject say so in a toast; a stale
 * answer (409) is not a toast: `staleFor` makes the card show its stale bar.
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

/** The consequence sentence, if the payload names one. */
function consequenceText(payload: OperatorApprovalPayload): string {
  return t(`operator.approval.consequences.${payload.consequence}`);
}

/** The quote of the owner's request ("Kérted: „…”"), cut to two lines until it is clicked. */
function Quote({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <blockquote className={styles.quote}>
      <button
        type="button"
        className={clsx(styles.quoteText, !open && styles.clamped)}
        aria-expanded={open}
        title={open ? t('operator.approval.quoteLess') : t('operator.approval.quoteMore')}
        onClick={() => setOpen((value) => !value)}
      >
        {t('operator.approval.asked', { quote: text })}
      </button>
    </blockquote>
  );
}

/** What the approval changes: the request's quote, the changed rows and the consequence. */
export function OperatorApprovalBody({
  payload,
  stale,
  staleReason,
}: {
  payload: OperatorApprovalPayload;
  /** The server refused a click as stale; the payload does not know yet. */
  stale?: boolean;
  staleReason?: NonNullable<OperatorApprovalPayload['stale']>['reason'];
}) {
  const reason = payload.stale?.reason ?? (stale ? (staleReason ?? 'config_changed') : null);
  return (
    <div className={styles.body}>
      {payload.quote ? <Quote text={payload.quote} /> : null}
      <OperatorChanges changes={payload.changes} />
      <p className={styles.consequence}>{consequenceText(payload)}</p>
      {reason ? (
        <p className={styles.staleBar} role="alert">
          {t(`operator.approval.staleReasons.${reason}`)}
        </p>
      ) : null}
    </div>
  );
}

const variantFor: Record<string, ButtonVariant> = {
  approve: 'primary',
  reject: 'secondary',
  dismiss: 'secondary',
};

/**
 * The buttons of an Operator approval: Jóváhagyom / Elvetem, or only "Rendben" once it is stale. They are bare
 * buttons for the caller's own row (`.actions` of the card, or the steps block).
 */
export function OperatorApprovalActions({
  item,
  payload,
  size,
  pending,
  stale,
  onDecide,
}: {
  item: InboxItem;
  payload: OperatorApprovalPayload;
  size: 'lg' | 'xl';
  pending: boolean;
  stale: boolean;
  onDecide: (item: InboxItem, body: ResolveInboxRequest) => void;
}) {
  const isStale = payload.stale !== null || stale;
  const op = payload.operation.op;
  const approveLabel =
    op === 'session_stop'
      ? t('operator.approval.stop')
      : op === 'project_pause'
        ? t('operator.approval.pause')
        : t('operator.approval.approve');
  const labelOf = (id: string) =>
    id === 'approve'
      ? approveLabel
      : id === 'reject'
        ? t('operator.approval.reject')
        : t('operator.approval.ok');
  // A stale approval can only be dismissed; the server leaves nothing else on the item.
  const options = item.options.filter((option) =>
    isStale ? option.id === 'dismiss' : option.id === 'approve' || option.id === 'reject',
  );
  if (options.length === 0) return null;
  return (
    <>
      {options.map((option) => (
        <Button
          key={option.id}
          variant={variantFor[option.id] ?? 'secondary'}
          size={size}
          disabled={pending}
          onClick={() => onDecide(item, { optionId: option.id })}
        >
          {labelOf(option.id)}
        </Button>
      ))}
    </>
  );
}
