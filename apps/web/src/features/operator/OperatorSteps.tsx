import { useMemo } from 'react';
import { Link } from 'react-router';
import { operatorApprovalOf } from '@projectman/shared';
import type { InboxItem, OperatorRequestView, OperatorStep } from '@projectman/shared';
import { useInbox } from '../../api/queries';
import { useProject, useProjectIndexes } from '../../app/contexts';
import { Icon } from '../../components/Icon';
import type { IconName } from '../../components/Icon';
import { t } from '../../i18n/t';
import { codeMessage } from '../../lib/errors';
import { nameOf } from '../../lib/members';
import { TaskChip } from '../messages/TaskChip';
import { OperatorApprovalActions, OperatorApprovalBody, useOperatorDecision } from './OperatorApproval';
import styles from './OperatorSteps.module.css';

type Group = 'done' | 'awaiting' | 'refused';

const GROUP_OF: Record<OperatorStep['status'], Group> = {
  done: 'done',
  approved: 'done',
  awaiting_approval: 'awaiting',
  rejected: 'refused',
  stale: 'refused',
  refused: 'refused',
};

const ICON_OF: Record<Group, IconName> = { done: 'check', awaiting: 'clock', refused: 'close' };

/** The words behind a group's icon, for screen readers: the icon alone never carries the state. */
function iconLabel(group: Group): string {
  switch (group) {
    case 'done':
      return t('operator.steps.iconDone');
    case 'awaiting':
      return t('operator.steps.iconAwaiting');
    case 'refused':
      return t('operator.steps.iconRefused');
  }
}

/** The note after a step's title: how the owner decided, or why the Operator did not do it. */
function StepNote({ step, ownerHandle }: { step: OperatorStep; ownerHandle: string | null }) {
  const { key } = useProject();
  if (step.status === 'approved') return <span className={styles.note}>{t('operator.steps.approved')}</span>;
  if (step.status === 'rejected') return <span className={styles.note}>{t('operator.steps.rejected')}</span>;
  if (step.status === 'stale') return <span className={styles.note}>{t('operator.steps.stale')}</span>;
  if (step.status !== 'refused' || !step.refusal) return null;
  const reason = codeMessage(step.refusal.code) ?? step.refusal.message;
  const ownerOnly = step.refusal.code === 'operator_owner_only';
  return (
    <span className={styles.note}>
      {ownerOnly ? t('operator.steps.ownerOnly') : reason}
      {ownerOnly && ownerHandle ? (
        <>
          {' '}
          <Link to={`/p/${key}/messages/with/${ownerHandle}`} className={styles.link}>
            {t('operator.steps.writeToOwner')} →
          </Link>
        </>
      ) : null}
    </span>
  );
}

/** One step: its icon (with a text label for screen readers), the title and what it touched. */
function StepRow({
  step,
  ownerHandle,
  titles,
  inboxItem,
}: {
  step: OperatorStep;
  ownerHandle: string | null;
  titles: ReadonlyMap<string, string>;
  inboxItem: InboxItem | null;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const decision = useOperatorDecision();
  const group = GROUP_OF[step.status];
  const approval = inboxItem && inboxItem.state === 'open' ? operatorApprovalOf(inboxItem) : null;
  return (
    <li className={styles.step} data-group={group} data-status={step.status}>
      <span className={styles.icon}>
        <Icon name={ICON_OF[group]} size={14} strokeWidth={2.4} />
        <span className={styles.sr}>{iconLabel(group)}</span>
      </span>
      <div className={styles.stepBody}>
        <div className={styles.stepLine}>
          <span className={styles.stepTitle}>{t(`operator.steps.actions.${step.action}`)}</span>
          {step.taskKey ? (
            <TaskChip projectKey={key} taskKey={step.taskKey} title={titles.get(step.taskKey)} />
          ) : null}
          {step.member ? (
            <span className={styles.member}>{nameOf(step.member, members, myHandle)}</span>
          ) : null}
          <StepNote step={step} ownerHandle={ownerHandle} />
        </div>
        {inboxItem && approval ? (
          <div className={styles.approval}>
            <OperatorApprovalBody payload={approval} stale={decision.staleFor(inboxItem)} />
            <div className={styles.actions}>
              <OperatorApprovalActions
                item={inboxItem}
                payload={approval}
                size="lg"
                pending={decision.pending(inboxItem)}
                stale={decision.staleFor(inboxItem)}
                onDecide={decision.decide}
              />
            </div>
          </div>
        ) : null}
      </div>
    </li>
  );
}

/**
 * "Lépések" under the owner's message (PM-447): what the Operator did on the request, from the server's record of
 * its steps, in three groups. A step that waits for approval shows the proposal inline, when its inbox item is the
 * viewer's to decide.
 */
export function OperatorSteps({
  request,
  titles,
}: {
  request: OperatorRequestView;
  titles: ReadonlyMap<string, string>;
}) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const inbox = useInbox(key);
  const items = useMemo(
    () => new Map((inbox.data?.items ?? []).map((item) => [item.id, item])),
    [inbox.data],
  );
  const ownerHandle = useMemo(
    () =>
      [...members.values()].find(
        (member) => member.kind === 'human' && member.role === 'owner' && member.handle !== myHandle,
      )?.handle ?? null,
    [members, myHandle],
  );
  if (request.steps.length === 0) return null;

  const groups: { group: Group; steps: OperatorStep[] }[] = (['done', 'awaiting', 'refused'] as const)
    .map((group) => ({ group, steps: request.steps.filter((step) => GROUP_OF[step.status] === group) }))
    .filter((entry) => entry.steps.length > 0);

  return (
    <section className={styles.steps} aria-label={t('operator.steps.label')} data-request={request.id}>
      {groups.map(({ group, steps }) => (
        <div key={group} className={styles.group}>
          <h4 className={styles.groupTitle}>{t(`operator.steps.${group}`)}</h4>
          <ul className={styles.list}>
            {steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                ownerHandle={ownerHandle}
                titles={titles}
                inboxItem={step.inboxItemId ? (items.get(step.inboxItemId) ?? null) : null}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
