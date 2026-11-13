import type { ProjectManagerChannel, ProjectManagerCorner } from '@projectman/shared';
import { formatTime } from '../../i18n/format';
import { t } from '../../i18n/t';

/** What a message to the project manager waits for, if anything; it names the line under the message. */
export type ProjectManagerWait = 'quota' | 'paused' | 'queued';

/** The dot of the header button: green available, accent working, grey waiting. */
export type ProjectManagerDot = 'available' | 'working' | 'waiting';

const QUOTA_REASONS: readonly string[] = ['plan_usage_paused', 'provider_rate_limited'];

/** Why the conversation cannot run now; null while the project manager is there, on its way or on leave (a message waits for it). */
export function operatorWaitOf(channel: ProjectManagerChannel | undefined): ProjectManagerWait | null {
  if (!channel) return null;
  if (channel.state === 'starting') return 'queued';
  if (channel.state !== 'waiting') return null;
  const reason = channel.waiting?.reason;
  if (reason === 'team_paused') return 'paused';
  if (reason && QUOTA_REASONS.includes(reason)) return 'quota';
  return 'queued';
}

export function operatorDotOf(channel: ProjectManagerChannel | undefined): ProjectManagerDot {
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
    case 'on_leave':
      return t('operator.status.on_leave');
    case 'missing':
      return t('operator.status.missing');
    default:
      return '';
  }
}

/** The status line with the length of the project manager's queue behind it: "Dolgozik… · sorban 3". */
export function operatorStatusWithQueue(channel: ProjectManagerCorner | undefined): string {
  const status = operatorStatusText(channel);
  const open = channel?.queue.open ?? 0;
  return open > 0
    ? [status, t('operator.button.queue', { count: open })].filter(Boolean).join(' · ')
    : status;
}

/**
 * The strip above the conversation while the queue has items: the item being worked on, or why none is (PM-890).
 * Without a current item the Operator is on its way ("starting") or cannot start ("waiting": paused, out of quota).
 * An idle ("available"), working or away Operator with open items shows no strip: what is open then does not wait for
 * a session start (a message that wakes nobody, an item at another place), so "starting" would stay for good (PM-1269).
 */
export type ProjectManagerStrip =
  | { kind: 'now'; title: string; more: number }
  | { kind: 'starting' }
  | { kind: 'waiting'; status: string; open: number };

export function operatorStripOf(channel: ProjectManagerCorner | undefined): ProjectManagerStrip | null {
  const queue = channel?.queue;
  if (!channel || !queue || queue.open <= 0) return null;
  if (queue.current) return { kind: 'now', title: queue.current.title, more: queue.open - 1 };
  if (channel.state === 'waiting') {
    return { kind: 'waiting', status: operatorStatusText(channel), open: queue.open };
  }
  return channel.state === 'starting' ? { kind: 'starting' } : null;
}
