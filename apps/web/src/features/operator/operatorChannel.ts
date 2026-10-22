import type { OperatorChannel, OperatorGrantState, ProjectManagerChannel } from '@projectman/shared';
import { daysBetween, formatDate, formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';

/** What a message to the Operator waits for, if anything; it names the line under the message. */
export type OperatorWait = 'quota' | 'paused' | 'queued';

/** The dot of the header button: green available, accent working, grey waiting. */
export type OperatorDot = 'available' | 'working' | 'waiting';

const QUOTA_REASONS: readonly string[] = ['plan_usage_paused', 'provider_rate_limited'];

/** Why the conversation cannot run now; null while the Operator is there or on its way (it is never on leave, PM-473). */
export function operatorWaitOf(channel: ProjectManagerChannel | undefined): OperatorWait | null {
  if (!channel) return null;
  if (channel.state === 'starting') return 'queued';
  if (channel.state !== 'waiting') return null;
  const reason = channel.waiting?.reason;
  if (reason === 'team_paused') return 'paused';
  if (reason && QUOTA_REASONS.includes(reason)) return 'quota';
  return 'queued';
}

export function operatorDotOf(channel: ProjectManagerChannel | undefined): OperatorDot {
  switch (channel?.state) {
    case 'available':
      return 'available';
    case 'working':
    case 'starting':
      return 'working';
    default:
      return 'waiting';
  }
}

/** The short status line: "Elérhető", "Dolgozik…", "Keretre vár 21:40-ig". */
export function operatorStatusText(channel: ProjectManagerChannel | undefined): string {
  switch (operatorWaitOf(channel)) {
    case 'paused':
      return t('operator.status.paused');
    case 'quota': {
      const until = channel?.waiting?.until;
      return until
        ? t('operator.status.quotaUntil', { until: formatTime(until) })
        : t('operator.status.quota');
    }
    case 'queued':
      return channel?.state === 'starting' ? t('operator.status.starting') : t('operator.status.waiting');
    case null:
      break;
  }
  switch (channel?.state) {
    case 'working':
      return t('operator.status.working');
    case 'available':
      return t('operator.status.available');
    case 'missing':
      return t('operator.status.missing');
    default:
      return '';
  }
}

/** The status line with the length of the Operator's queue behind it: "Dolgozik… · sorban 3". */
export function operatorStatusWithQueue(channel: OperatorChannel | undefined): string {
  const status = operatorStatusText(channel);
  const open = channel?.queue.open ?? 0;
  return open > 0
    ? [status, t('operator.button.queue', { count: open })].filter(Boolean).join(' · ')
    : status;
}

/**
 * The strip above the conversation while the queue has items: the item being worked on, or why none is (PM-890).
 * Without a current item the Operator is on its way ("starting") or cannot start ("waiting": paused, out of quota).
 */
export type OperatorStrip =
  | { kind: 'now'; title: string; more: number }
  | { kind: 'starting' }
  | { kind: 'waiting'; status: string; open: number };

export function operatorStripOf(channel: OperatorChannel | undefined): OperatorStrip | null {
  const queue = channel?.queue;
  if (!channel || !queue || queue.open <= 0) return null;
  if (queue.current) return { kind: 'now', title: queue.current.title, more: queue.open - 1 };
  if (channel.state === 'waiting') {
    return { kind: 'waiting', status: operatorStatusText(channel), open: queue.open };
  }
  return { kind: 'starting' };
}

/** When the grant ends: "visszavonásig", "ma 20:55-ig" or "okt. 27. 20:55-ig". */
export function operatorGrantExpiryText(grant: OperatorGrantState, now: Date = new Date()): string {
  if (!grant.expiresAt) return t('operator.queue.grant.untilRevoked');
  const time = formatTime(grant.expiresAt);
  return daysBetween(grant.expiresAt, now) === 0
    ? t('operator.queue.grant.untilToday', { time })
    : t('operator.queue.grant.untilDate', { date: formatDate(grant.expiresAt, now), time });
}

/** The line under an own message that the Operator has not taken yet. */
export function operatorSentText(wait: OperatorWait | null): string {
  switch (wait) {
    case 'quota':
      return t('operator.sent.quota');
    case 'paused':
      return t('operator.sent.paused');
    case 'queued':
      return t('operator.sent.queued');
    case null:
      return t('operator.sent.plain');
  }
}
