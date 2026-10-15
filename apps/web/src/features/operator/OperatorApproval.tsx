import clsx from 'clsx';
import { useEffect, useState } from 'react';
import type { InboxItem, OperatorApprovalPayload, ResolveInboxRequest } from '@projectman/shared';
import { isApiError } from '../../api/client';
import { useResolveInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Link } from 'react-router';
import { Button } from '../../components/Button';
import type { ButtonVariant } from '../../components/Button';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { rich } from '../../i18n/rich';
import { formatStamp } from '../../i18n/format';
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
  open = true,
}: {
  payload: OperatorApprovalPayload;
  /** The server refused a click as stale; the payload does not know yet. */
  stale?: boolean;
  staleReason?: NonNullable<OperatorApprovalPayload['stale']>['reason'];
  open?: boolean;
}) {
  const reason = payload.stale?.reason ?? (stale ? (staleReason ?? 'config_changed') : null);
  const { key } = useProject();
  const { members } = useProjectIndexes(key);
  const operation = payload.operation;
  const reversible = operation.op !== 'message_send' && payload.plan?.reversible;
  return (
    <div className={styles.body}>
      {payload.quote ? <Quote text={payload.quote} /> : null}
      {payload.plan ? (
        <div className={styles.section}>
          <h3 className={styles.label}>{t('operator.approval.plan')}</h3>
          <dl className={styles.plan}>
            <dt>{t('operator.approval.planWhy')}</dt>
            <dd>{payload.plan.why}</dd>
            <dt>{t('operator.approval.planImpact')}</dt>
            <dd>{payload.plan.impact}</dd>
            <dt>{t('operator.approval.planReversible')}</dt>
            <dd>
              <span className={clsx(styles.reversible, !reversible && styles.warning)}>
                <Icon name={reversible ? 'check' : 'alertCircle'} size={16} />
                {t(reversible ? 'operator.approval.reversibleYes' : 'operator.approval.reversibleNo')}
              </span>
            </dd>
          </dl>
        </div>
      ) : null}
      {operation.op === 'message_send' ? (
        <>
          <div className={styles.section}>
            <h3 className={styles.label}>{t('operator.approval.recipients')}</h3>
            <div className={styles.recipients}>
              {[...new Set(operation.to)].map((handle) => (
                <span key={handle} className={styles.recipient}>
                  <Avatar member={members.get(handle)} handle={handle} size="sm" />
                  {members.get(handle)?.displayName ?? handle}
                  {members.get(handle)?.role === 'client' ? (
                    <small>{t('operator.approval.guest')}</small>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
          <div className={styles.section}>
            <h3 className={styles.label}>{t('operator.approval.message')}</h3>
            <div className={styles.message}>{operation.text}</div>
            <p className={styles.exact}>
              {operation.taskKey
                ? rich('operator.approval.messageExactTask', {
                    key: <Link to={`/p/${key}/tasks/${operation.taskKey}`}>{operation.taskKey}</Link>,
                  })
                : t('operator.approval.messageExact')}
            </p>
          </div>
        </>
      ) : null}
      <OperatorChanges changes={payload.changes} />
      <p className={styles.consequence}>{consequenceText(payload)}</p>
      {open && !reason && payload.expiresAt ? <Expiry at={payload.expiresAt} /> : null}
      {reason ? (
        <p className={styles.staleBar} role="alert">
          {t(`operator.approval.staleReasons.${reason}`)}
        </p>
      ) : null}
    </div>
  );
}

function Expiry({ at }: { at: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const remaining = Date.parse(at) - now;
  const soon = remaining <= 60 * 60_000;
  if (remaining <= 0) return null;
  return (
    <p className={clsx(styles.expires, soon && styles.warning)}>
      <Icon name="clock" size={14} />
      <time dateTime={at}>
        {soon
          ? t('operator.approval.expiresSoon', { minutes: Math.max(1, Math.ceil(remaining / 60_000)) })
          : t('operator.approval.expires', { time: formatStamp(at, new Date(now)) })}
      </time>
    </p>
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
  const [pressed, setPressed] = useState<string | null>(null);
  const isStale = payload.stale !== null || stale;
  const op = payload.operation.op;
  const approveLabel =
    op === 'message_send'
      ? t('operator.approval.send')
      : op === 'session_stop'
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
          // The pressed button waits (spinner); the other one only stands still.
          loading={pending && pressed === option.id}
          disabled={pending}
          onClick={() => {
            setPressed(option.id);
            onDecide(item, { optionId: option.id });
          }}
        >
          {labelOf(option.id)}
        </Button>
      ))}
    </>
  );
}
