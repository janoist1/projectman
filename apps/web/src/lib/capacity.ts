import { SESSION_IDLE_CLOSE_MINUTES } from '@projectman/shared';
import type { CapacityHolder, TaskStartWaiting } from '@projectman/shared';
import { formatAgo, formatStamp } from '../i18n/format';
import { t } from '../i18n/t';

/**
 * What holds the places of an AI member (PM-297), the one rule behind the card row, the "Miért áll?" box,
 * the board's team strip and the member profile: with a single holder the texts name its kind, with
 * several (or none known: an older server) they say what they said before.
 */

export interface Capacity {
  holders: readonly CapacityHolder[];
  /** The member's places. */
  max: number;
  /** The silence after which a chat or schedule run closes by itself. */
  closeAfterMinutes: number;
}

/** The holders as a capacity; null when none is known (an older server, or the places have freed up). */
export function capacityFrom(
  holders: readonly CapacityHolder[] | undefined,
  max?: number,
  closeAfterMinutes?: number,
): Capacity | null {
  if (!holders || holders.length === 0) return null;
  return {
    holders,
    max: max ?? holders.length,
    closeAfterMinutes: closeAfterMinutes ?? SESSION_IDLE_CLOSE_MINUTES,
  };
}

/** The holders a start wait for capacity carries; null for any other wait, or without holders. */
export function capacityOf(
  waiting: Pick<TaskStartWaiting, 'reason' | 'holders' | 'capacity' | 'closeAfterMinutes'> | null | undefined,
): Capacity | null {
  return waiting?.reason === 'member_at_capacity'
    ? capacityFrom(waiting.holders, waiting.capacity, waiting.closeAfterMinutes)
    : null;
}

/** The one holder, when there is exactly one: only then the texts name its kind. */
export function onlyHolder(capacity: Capacity): CapacityHolder | null {
  return capacity.holders.length === 1 ? capacity.holders[0]! : null;
}

function cardHolders(capacity: Capacity): { keys: string[]; hidden: number } {
  const cards = capacity.holders.filter((holder) => holder.kind === 'task');
  const keys = cards.flatMap((holder) => (holder.taskKey ? [holder.taskKey] : []));
  return { keys, hidden: cards.length - keys.length };
}

/** The keys of the cards that hold the places the viewer sees: "PM-12", "PM-12, PM-14", "PM-12, PM-14 +1". */
export function holderKeysText(capacity: Capacity): string | null {
  const { keys, hidden } = cardHolders(capacity);
  if (keys.length === 0) return null;
  const shown = keys.slice(0, 2).join(t('common.listSeparator'));
  const more = Math.max(0, keys.length - 2) + hidden;
  return more > 0 ? t('team.cardsMore', { keys: shown, more }) : shown;
}

/** The only visible card that holds a place: where the team strip's chip leads. */
export function onlyCardKey(capacity: Capacity): string | null {
  const holder = onlyHolder(capacity);
  return holder?.kind === 'task' && holder.taskKey ? holder.taskKey : null;
}

/** What the only holder is doing, short: "még beszélget", "még dolgozik (PM-12)"; null with several. */
export function capacityReason(capacity: Capacity): string | null {
  const holder = onlyHolder(capacity);
  if (!holder) return null;
  switch (holder.kind) {
    case 'general':
      return t('taskStatus.next.capacityKinds.general');
    case 'schedule':
      return t('taskStatus.next.capacityKinds.schedule');
    case 'meeting':
      return t('taskStatus.next.capacityKinds.meeting');
    case 'task': {
      const keys = holderKeysText(capacity);
      return keys
        ? t('taskStatus.next.capacityKinds.task', { keys })
        : t('taskStatus.next.capacityKinds.taskHidden');
    }
  }
}

/** When the quietest holders close and the card starts: the earliest silence limit among those not at work. */
function startsAt(capacity: Capacity): number | null {
  const quiet = capacity.holders.filter((holder) => !holder.working && holder.kind !== 'meeting');
  if (quiet.length === 0) return null;
  return Math.min(
    ...quiet.map((holder) => Date.parse(holder.lastActivityAt) + capacity.closeAfterMinutes * 60_000),
  );
}

/** What the viewer can do, and when it starts by itself: "Semmit." is added by the caller. */
export function capacityHint(capacity: Capacity, name: string, now: Date = new Date()): string {
  const holder = onlyHolder(capacity);
  const n = capacity.closeAfterMinutes;
  if (holder?.kind === 'meeting') return t('taskStatus.startHints.capacity.meeting');
  const first =
    holder?.kind === 'general'
      ? t('taskStatus.startHints.capacity.general', { n })
      : holder?.kind === 'schedule'
        ? t('taskStatus.startHints.capacity.schedule', { n })
        : holder?.kind === 'task'
          ? t('taskStatus.startHints.capacity.task', { name })
          : t('taskStatus.startHints.capacity.several', { name, n });
  const at = startsAt(capacity);
  if (at === null) return first;
  const when =
    at <= now.getTime()
      ? t('taskStatus.startHints.capacitySoon')
      : t('taskStatus.startHints.capacityAt', { time: formatStamp(new Date(at), now) });
  return `${first} ${when}`;
}

/** The box's lead sentence above the list of holders. */
export function capacityIntro(capacity: Capacity): string {
  return capacity.holders.length > 1
    ? t('task.whyBox.capacityMany', { max: capacity.max })
    : t('task.whyBox.capacityOne');
}

/** How long a holder has been at it, short: "most dolgozik", "utolsó bejegyzés 6 perce", "20 perce tart". */
export function holderMeta(holder: CapacityHolder, now: Date = new Date()): string {
  if (holder.kind === 'meeting')
    return t('task.whyBox.capacityMeeting', { ago: formatAgo(holder.startedAt, now) });
  return holder.working
    ? t('task.whyBox.capacityWorking')
    : t('task.whyBox.capacityLastEntry', { ago: formatAgo(holder.lastActivityAt, now) });
}

export interface CapacityRow {
  id: string;
  kind: CapacityHolder['kind'];
  /** The card the viewer sees; null for the other kinds and for a hidden card. */
  taskKey: string | null;
  /** The session to open; null for a client, and for a card holder (the card is the link). */
  sessionId: string | null;
  /** The list's name of the holder: "PM-12", "Általános beszélgetés", "Egy másik kártya". */
  what: string;
  /** The name in running text: "PM-12", "általános beszélgetés", "egy másik kártya". */
  name: string;
  /** The card's title when the board has it. */
  title: string | null;
  meta: string;
}

/** One row per holder, for the box's list and the profile's note. */
export function capacityRows(
  capacity: Capacity,
  titles: ReadonlyMap<string, string> = new Map(),
  now: Date = new Date(),
): CapacityRow[] {
  return capacity.holders.map((holder, index) => {
    const base = { meta: holderMeta(holder, now), kind: holder.kind };
    switch (holder.kind) {
      case 'task':
        return {
          ...base,
          id: `task-${holder.taskKey ?? index}`,
          taskKey: holder.taskKey ?? null,
          sessionId: null,
          what: holder.taskKey ?? t('task.whyBox.capacityRow.taskHidden'),
          name: holder.taskKey ?? t('taskStatus.capacityNames.taskHidden'),
          title: holder.taskKey ? (titles.get(holder.taskKey) ?? null) : null,
        };
      case 'general':
        return row(
          base,
          holder,
          index,
          t('task.whyBox.capacityRow.general'),
          t('taskStatus.capacityNames.general'),
        );
      case 'schedule':
        return row(
          base,
          holder,
          index,
          t('task.whyBox.capacityRow.schedule'),
          t('taskStatus.capacityNames.schedule'),
        );
      case 'meeting':
        return row(
          base,
          holder,
          index,
          t('task.whyBox.capacityRow.meeting'),
          t('taskStatus.capacityNames.meeting'),
        );
    }
  });
}

function row(
  base: Pick<CapacityRow, 'meta' | 'kind'>,
  holder: CapacityHolder,
  index: number,
  what: string,
  name: string,
): CapacityRow {
  return {
    ...base,
    id: `${holder.kind}-${holder.sessionId ?? index}`,
    taskKey: null,
    sessionId: holder.sessionId ?? null,
    what,
    name,
    title: null,
  };
}

/**
 * The team strip's chip in place of the card key: the cards that hold the places (mono) and the other kinds
 * in words. "PM-12" and "általános beszélgetés"; a card the viewer cannot see reads "egy másik kártya".
 */
export function capacityChip(capacity: Capacity): { keys: string | null; kinds: string | null } {
  const keys = holderKeysText(capacity);
  const kinds: string[] = [];
  if (!keys && cardHolders(capacity).hidden > 0) kinds.push(t('taskStatus.capacityNames.taskHidden'));
  for (const holder of capacity.holders) {
    if (holder.kind === 'task') continue;
    const name = t(`taskStatus.capacityNames.${holder.kind}`);
    if (!kinds.includes(name)) kinds.push(name);
  }
  return { keys, kinds: kinds.length > 0 ? kinds.join(t('common.listSeparator')) : null };
}
