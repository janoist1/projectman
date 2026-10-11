import type { ProjectManagerChannel } from '@projectman/shared';
import { formatTime } from '../../i18n/format';
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
