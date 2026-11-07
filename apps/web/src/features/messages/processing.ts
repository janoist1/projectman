import type { MessageProcessing } from '@projectman/shared';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';

type ProcessingTone = 'neutral' | 'progress' | 'ok' | 'warn' | 'danger';

export interface ProcessingView {
  /** The state's name, as the label table words it. */
  label: string;
  /** The why / what next line, when the state has one. */
  detail: string | null;
  tone: ProcessingTone;
  /** A reply to open, when the state is `replied`. */
  reply: Extract<MessageProcessing, { state: 'replied' }>['reply'] | null;
}

/**
 * The one mapping of a recipient's processing state to what the card and the PM panel show (PM-1305). Words
 * come only from the server's data: a state the viewer may not see is not here at all (the server hides it),
 * and the client's wait reason is already stripped by `visibleProcessing`.
 */
export function processingView(item: MessageProcessing): ProcessingView {
  const base = { detail: null, reply: null };
  switch (item.state) {
    case 'stored':
      return { ...base, label: t('processing.label.stored'), tone: 'neutral' };
    case 'held':
      return {
        ...base,
        label: t('processing.label.held'),
        detail: t(`processing.hold.${item.hold}`),
        tone: 'neutral',
      };
    case 'starting':
      return {
        ...base,
        label: t('processing.label.starting'),
        detail: t('processing.detail.starting'),
        tone: 'progress',
      };
    case 'delivered':
      return {
        ...base,
        label: t('processing.label.delivered'),
        detail: t('processing.detail.delivered'),
        tone: 'neutral',
      };
    case 'read':
      return { ...base, label: t('processing.label.read'), tone: 'ok' };
    case 'handed_off':
      return { ...base, label: t('processing.label.handed_off', { to: item.to }), tone: 'ok' };
    case 'working':
      return { ...base, label: t('processing.label.working'), tone: 'progress' };
    case 'waiting':
      return {
        ...base,
        label: t('processing.label.waiting'),
        detail: t(`processing.wait.${item.reason ?? 'unknown'}`),
        tone: 'warn',
      };
    case 'stale':
      return {
        ...base,
        label: t('processing.label.stale'),
        detail: t(`processing.stale.${item.cause}`, { time: formatTime(item.lastSeenAt) }),
        tone: 'danger',
      };
    case 'turn_ended':
      return {
        ...base,
        label: t('processing.label.turn_ended'),
        detail: t('processing.detail.turn_ended'),
        tone: 'warn',
      };
    case 'replied':
      return { ...base, label: t('processing.label.replied'), tone: 'ok', reply: item.reply };
    case 'not_sent':
      return {
        ...base,
        label: t('processing.label.not_sent'),
        detail: t('processing.detail.not_sent'),
        tone: 'danger',
      };
  }
}
