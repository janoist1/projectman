import type { ProjectManagerChannel } from '@projectman/shared';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';

/** What a message to the project manager waits for, if anything; it names the line under the message. */
export type PmWait = 'leave' | 'quota' | 'paused' | 'queued';

/** The dot of the header button: green available, accent working, hollow on leave, grey waiting. */
export type PmDot = 'available' | 'working' | 'leave' | 'waiting';

const QUOTA_REASONS: readonly string[] = ['plan_usage_paused', 'provider_rate_limited'];

/** Why the conversation cannot run now; null while the project manager is there or on its way. */
export function pmWaitOf(channel: ProjectManagerChannel | undefined): PmWait | null {
  if (!channel) return null;
  if (channel.state === 'on_leave') return 'leave';
  if (channel.state === 'starting') return 'queued';
  if (channel.state !== 'waiting') return null;
  const reason = channel.waiting?.reason;
  if (reason === 'team_paused') return 'paused';
  if (reason && QUOTA_REASONS.includes(reason)) return 'quota';
  return 'queued';
}

export function pmDotOf(channel: ProjectManagerChannel | undefined): PmDot {
  switch (channel?.state) {
    case 'available':
      return 'available';
    case 'working':
    case 'starting':
      return 'working';
    case 'on_leave':
      return 'leave';
    default:
      return 'waiting';
  }
}

/** The short status line: "Elérhető", "Dolgozik…", "Keretre vár 21:40-ig". */
export function pmStatusText(channel: ProjectManagerChannel | undefined): string {
  switch (pmWaitOf(channel)) {
    case 'leave':
      return t('pm.status.onLeave');
    case 'paused':
      return t('pm.status.paused');
    case 'quota': {
      const until = channel?.waiting?.until;
      return until ? t('pm.status.quotaUntil', { until: formatTime(until) }) : t('pm.status.quota');
    }
    case 'queued':
      return channel?.state === 'starting' ? t('pm.status.starting') : t('pm.status.waiting');
    case null:
      break;
  }
  switch (channel?.state) {
    case 'working':
      return t('pm.status.working');
    case 'available':
      return t('pm.status.available');
    case 'missing':
      return t('pm.status.missing');
    default:
      return '';
  }
}

/** The line under an own message that the project manager has not taken yet. */
export function pmSentText(wait: PmWait | null): string {
  switch (wait) {
    case 'leave':
      return t('pm.sent.leave');
    case 'quota':
      return t('pm.sent.quota');
    case 'paused':
      return t('pm.sent.paused');
    case 'queued':
      return t('pm.sent.queued');
    case null:
      return t('pm.sent.plain');
  }
}
