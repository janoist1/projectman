import type { FeedbackMarkView } from '@projectman/shared';
import type { TextKey } from './i18n';

export type StatusKey = 'new' | 'working' | 'answered' | 'card' | 'waiting_owner' | 'closed';

/**
 * The label state of a mark. The widget API does not give the owner's name, so a mark that waits for
 * the owner says "A tulajdonos dönt" with no name.
 */
export function statusOf(mark: Pick<FeedbackMarkView, 'status' | 'outcome' | 'working'>): StatusKey {
  if (mark.status === 'closed') return 'closed';
  if (mark.working) return 'working';
  if (mark.status === 'waiting_owner') return 'waiting_owner';
  if (mark.status === 'handled') {
    return mark.outcome === 'card_created' || mark.outcome === 'card_linked' ? 'card' : 'answered';
  }
  return 'new';
}

export const statusText = (status: StatusKey): TextKey => `status.${status}` as const;
