import { workQueueReasonOf } from '@projectman/shared';
import type { LabelView, WorkQueueItem } from '@projectman/shared';
import { formatStamp } from '../../i18n/format';
import { t, tDynamic } from '../../i18n/t';
import { labelName } from '../../lib/labels';

/** The group-level sentence of what a queued item waits for (the reason's seven classes). */
export function workQueueReasonText(item: Pick<WorkQueueItem, 'reason'>): string {
  return t(`workQueues.reasons.${item.reason ?? 'unknown'}`);
}

/**
 * The finer sentence behind the reason, or null when there is none to say. A hold code has its own text; a start
 * code reuses the card's `taskStatus.startWaiting` sentence, but only when every part it names is known from the
 * wait facts: a sentence that would keep a raw `{…}` is never shown.
 */
export function workQueueReasonDetail(
  item: WorkQueueItem,
  names: { member: (handle: string) => string; labels: readonly LabelView[] },
): string | null {
  const code = item.reasonCode;
  if (item.state !== 'queued' || !code) return null;
  if (code.startsWith('hold_')) {
    const text = code === 'hold_unknown' ? '' : tDynamic(`workQueues.hold.${code}`, '');
    return text === '' ? null : text;
  }
  if (workQueueReasonOf({ code, wake: true, placeLive: false }) === 'unknown') return null;
  const facts = item.waitFacts;
  const text = tDynamic(`taskStatus.startWaiting.${code}`, '', {
    ...(facts?.member ? { name: names.member(facts.member) } : {}),
    ...(facts?.taskKeys?.length ? { prerequisites: facts.taskKeys.join(', ') } : {}),
    ...(facts?.labels?.length
      ? { labels: facts.labels.map((id) => labelName(id, names.labels)).join(', ') }
      : {}),
    ...(facts?.until ? { until: formatStamp(facts.until) } : {}),
  });
  return text === '' || /\{\w+\}/.test(text) ? null : text;
}
