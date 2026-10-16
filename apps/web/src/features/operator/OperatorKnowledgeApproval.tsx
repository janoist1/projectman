import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { canReadOperatorKnowledge } from '@projectman/shared';
import type { InboxItem, OperatorKnowledgeApprovalPayload, ResolveInboxRequest } from '@projectman/shared';
import { api } from '../../api/endpoints';
import { queryKeys } from '../../api/queryKeys';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Fold } from '../../components/Fold';
import { ErrorState } from '../../components/States';
import { t } from '../../i18n/t';
import { OperatorChanges } from './OperatorChanges';
import { KnowledgeSummary, KnowledgeSkeleton } from './OperatorKnowledgeView';
import styles from './OperatorKnowledge.module.css';

export function OperatorKnowledgeBody({
  payload,
  stale,
}: {
  payload: OperatorKnowledgeApprovalPayload;
  stale?: boolean;
}) {
  const { key, me } = useProject();
  const access = me.projects.find((project) => project.key === key)?.access;
  const knowledge = useQuery({
    queryKey: queryKeys.operatorKnowledge(key),
    queryFn: () => api.operatorKnowledge(key),
    enabled: !me.via && canReadOperatorKnowledge({ access }),
  });
  const change = payload.change;
  const previous = change.kind === 'agreement_replace' ? knowledge.data?.agreement?.data : null;
  const principle =
    change.kind === 'principle_remove'
      ? knowledge.data?.principles.find((entry) => entry.id === change.id)
      : change.kind === 'principle_put'
        ? knowledge.data?.principles.find((entry) => entry.id === change.principle.id)
        : null;
  const reason = payload.stale?.reason ?? (stale ? 'knowledge_changed' : null);
  return (
    <div className={styles.section}>
      {change.kind === 'agreement_replace' ? (
        <>
          <strong>{t('knowledge.proposal.summary')}</strong>
          <KnowledgeSummary text={change.agreement.summary} />
          <p>
            {t('knowledge.proposal.involvement')}:{' '}
            <strong>{t(`knowledge.involvement.${change.agreement.involvement}`)}</strong>
          </p>
          {previous && previous.involvement !== change.agreement.involvement ? (
            <p className={styles.meta}>
              {t('knowledge.proposal.previous', {
                value: t(`knowledge.involvement.${previous.involvement}`),
              })}
            </p>
          ) : null}
          {change.agreement.extraCritical.length > 0 ? (
            <div>
              {t('knowledge.critical')}
              <ul>
                {change.agreement.extraCritical.map((text, index) => (
                  <li key={index}>{text}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {payload.changes.length > 0 ? (
            <>
              <strong>{t('knowledge.proposal.changes')}</strong>
              <OperatorChanges changes={payload.changes} />
            </>
          ) : null}
          <p>
            {t('knowledge.proposal.agreementConsequence')}
            {payload.changes.length > 0 ? ` ${t('knowledge.proposal.changesConsequence')}` : ''}
          </p>
        </>
      ) : change.kind === 'principle_put' ? (
        <>
          <strong>{t('knowledge.proposal.rule')}</strong>
          <strong>{change.principle.principle}</strong>
          {principle ? (
            <p className={styles.meta}>{t('knowledge.proposal.previous', { value: principle.principle })}</p>
          ) : null}
          <p>
            {t('knowledge.proposal.effect')}: {change.principle.effect}
          </p>
          <Fold summary={t('knowledge.example')}>{change.principle.example}</Fold>
          <p>{t('knowledge.proposal.principleConsequence')}</p>
        </>
      ) : (
        <>
          <p>{t('knowledge.proposal.remove')}</p>
          {knowledge.isPending ? (
            <KnowledgeSkeleton />
          ) : knowledge.isError ? (
            <ErrorState compact error={knowledge.error} onRetry={() => void knowledge.refetch()} />
          ) : principle ? (
            <strong>{principle.principle}</strong>
          ) : (
            <p>{t('knowledge.proposal.missingPrinciple')}</p>
          )}
          <p>{t('knowledge.proposal.removeConsequence')}</p>
        </>
      )}
      {payload.applying ? <p role="status">{t('knowledge.proposal.applying')}</p> : null}
      {reason ? (
        <p role="alert" className={styles.alert}>
          {t(`knowledge.proposal.${reason}`)}
        </p>
      ) : null}
    </div>
  );
}

export function OperatorKnowledgeActions({
  item,
  payload,
  pending,
  stale,
  onDecide,
}: {
  item: InboxItem;
  payload: OperatorKnowledgeApprovalPayload;
  pending: boolean;
  stale: boolean;
  onDecide: (item: InboxItem, body: ResolveInboxRequest) => void;
}) {
  const { isOwner, me, openOperator } = useProject();
  const [pressed, setPressed] = useState<string | null>(null);
  const locked = useRef(false);
  const outOfDate = Boolean(payload.stale || stale);
  if (!isOwner || me.via) return <p>{t('knowledge.proposal.ownerOnly')}</p>;
  if (payload.applying) return null;
  return (
    <div className={styles.actions}>
      {outOfDate ? (
        <Button
          variant="primary"
          onClick={(event) =>
            openOperator(event.currentTarget, t('knowledge.proposal.retryPrompt', { title: item.title }))
          }
        >
          {t('knowledge.proposal.retry')}
        </Button>
      ) : null}
      {(outOfDate ? ['dismiss'] : ['approve', 'reject']).map((option) => (
        <Button
          key={option}
          variant={option === 'approve' ? 'primary' : 'secondary'}
          disabled={pending}
          onClick={() => {
            if (pending || locked.current) return;
            locked.current = true;
            setPressed(option);
            onDecide(item, { optionId: option });
            // The parent owns the mutation; release the synchronous double-click guard after dispatch.
            queueMicrotask(() => {
              locked.current = false;
            });
          }}
        >
          {pending && pressed === option
            ? t('knowledge.proposal.pending')
            : t(
                option === 'approve'
                  ? 'operator.approval.approve'
                  : option === 'reject'
                    ? 'operator.approval.reject'
                    : 'operator.approval.ok',
              )}
        </Button>
      ))}
    </div>
  );
}
