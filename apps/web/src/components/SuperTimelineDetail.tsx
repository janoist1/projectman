import { useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { TimelineEvent } from '@projectman/shared';
import { SuperState } from '@projectman/shared';
import { api } from '../api/endpoints';
import { ProjectContext } from '../app/contexts';
import { t } from '../i18n/t';
import { Button } from './Button';
import { SuperStateChip } from './SuperStateChip';

/** The event keeps only ids and state. Owner-only DTO reads supply the reason and links. */
export function SuperTimelineDetail({
  event,
  events,
}: {
  event: TimelineEvent;
  events: readonly TimelineEvent[];
}) {
  const project = useContext(ProjectContext);
  const allowed = project?.isOwner === true;
  const operationId = typeof event.data.operationId === 'string' ? event.data.operationId : '';
  const handoffId = typeof event.data.handoffId === 'string' ? event.data.handoffId : '';
  const handoffs = useQuery({
    queryKey: ['project', event.projectKey, 'super-handoffs', 'detail', handoffId],
    queryFn: () => api.superHandoff(event.projectKey, handoffId),
    enabled: allowed && !!handoffId,
  });
  const operation = useQuery({
    queryKey: ['project', event.projectKey, 'super-operation', operationId],
    queryFn: () => api.superOperation(event.projectKey, operationId),
    enabled: allowed && !!operationId,
  });
  const handoff = handoffs.data?.handoff;
  const op = operation.data?.operation;
  const state = SuperState.safeParse(event.data.state);
  const source = op?.handoffId
    ? events.find((item) => item.type === 'super_handoff_changed' && item.data.handoffId === op.handoffId)
    : undefined;
  return (
    <span>
      {handoff ? (
        <span>
          {t('superMode.handedOff', {
            operation: t(`superMode.commands.${handoff.command.kind}`),
            reason: handoff.reason,
          })}{' '}
        </span>
      ) : null}
      {op ? (
        <span>
          {t(
            op.handoffId && state.success && state.data === 'succeeded'
              ? 'superMode.executed'
              : 'superMode.operation',
            { operation: t(`superMode.commands.${op.command.kind}`) },
          )}{' '}
        </span>
      ) : null}
      {state.success ? (
        <SuperStateChip state={state.data} projectKey={event.projectKey} questionId={op?.ownerQuestionId} />
      ) : null}
      {source ? (
        <>
          {' '}
          <Link to={`#timeline-${source.id}`}>{t('superMode.handoff')}</Link>
        </>
      ) : op?.handoffId ? (
        <>
          {' '}
          <Link to={`/p/${event.projectKey}/sessions?by=super#handoff-${op.handoffId}`}>
            {t('superMode.handoff')}
          </Link>
        </>
      ) : null}
      {handoffs.isError || operation.isError ? (
        <span role="alert">
          {t('superMode.detailError')}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (handoffId) void handoffs.refetch();
              if (operationId) void operation.refetch();
            }}
          >
            {t('app.retry')}
          </Button>
        </span>
      ) : null}
    </span>
  );
}
