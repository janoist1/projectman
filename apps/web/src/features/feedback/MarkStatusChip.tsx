import type { FeedbackMarkView } from '@projectman/shared';
import { Chip, StatusDot } from '../../components/Chip';
import type { ChipTone } from '../../components/Chip';
import { t } from '../../i18n/t';
import type { MemberIndex } from '../../lib/members';

type StatusFields = Pick<FeedbackMarkView, 'status' | 'outcome' | 'working'>;

/** The name the "… dönt" label carries: the project's owner. */
export function ownerNameOf(members: MemberIndex): string {
  for (const member of members.values()) {
    if (member.kind === 'human' && member.role === 'owner') return member.displayName;
  }
  return t('feedback.status.ownerFallback');
}

export function markStatusText(mark: StatusFields, ownerName: string): string {
  if (mark.status === 'closed') return t('feedback.status.closed');
  if (mark.status === 'waiting_owner') return t('feedback.status.waitingOwner', { owner: ownerName });
  if (mark.status === 'new') return mark.working ? t('feedback.status.working') : t('feedback.status.new');
  return mark.outcome === 'answered' ? t('feedback.status.answered') : t('feedback.status.card');
}

function toneOf(mark: StatusFields): ChipTone {
  if (mark.status === 'closed') return 'neutral';
  if (mark.status === 'waiting_owner') return 'needs';
  return mark.status === 'new' ? 'accent' : 'ok';
}

/** The state of a mark in words; a processor at work shows the pulsing dot. */
export function MarkStatusChip({ mark, ownerName }: { mark: StatusFields; ownerName: string }) {
  const working = mark.working && mark.status === 'new';
  // The label is from markStatusText; only a mark the processor is working on gets the pulsing dot.
  return (
    <Chip tone={toneOf(mark)}>
      {working ? (
        <>
          <StatusDot status="working" pulse size={7} />{' '}
        </>
      ) : null}
      {markStatusText(mark, ownerName)}
    </Chip>
  );
}
