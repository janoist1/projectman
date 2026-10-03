import type { TaskLoop } from '@projectman/shared';
import { joinNames, t } from '../i18n/t';
import { nameOf, namesOf } from './members';
import type { MemberIndex } from './members';

/** "A és B" for the members of a loop. */
export function pairText(handles: readonly string[], members: MemberIndex, myHandle: string | null): string {
  return joinNames(namesOf(handles, members, myHandle));
}

/** Whole minutes between two stamps, at least one: how long a loop has been going on. */
export function minutesBetween(from: string, to: string | Date): number {
  const end = typeof to === 'string' ? Date.parse(to) : to.getTime();
  return Math.max(1, Math.round((end - Date.parse(from)) / 60_000));
}

/** "Kata dönt", or "te döntesz" when the viewer is among the people it went to. */
export function decidesText(
  deciders: readonly string[],
  members: MemberIndex,
  myHandle: string | null,
): string {
  if (myHandle !== null && deciders.includes(myHandle)) return t('loop.youDecide');
  return t('loop.decides', { names: joinNames(namesOf(deciders, members, myHandle)) });
}

/** The name of the member told, or the stand-in when the loop names none. */
export function watcherName(handle: string | null, members: MemberIndex, myHandle: string | null): string {
  return handle ? nameOf(handle, members, myHandle) : t('loop.schedulingHolder');
}

/** Who has the loop and why, as a sentence: who was told, who decides, or who let it run. */
export function loopWho(loop: TaskLoop, members: MemberIndex, myHandle: string | null): string {
  if (loop.phase === 'let_run')
    return t('loop.who.let_run', { name: nameOf(loop.letRunBy, members, myHandle) });
  if (loop.phase === 'owner') {
    const decides = decidesText(loop.deciders, members, myHandle);
    return loop.ownerReason === 'continued'
      ? t('loop.who.continued', { name: watcherName(loop.notified, members, myHandle), decides })
      : t('loop.who.no_watcher', { decides });
  }
  return t('loop.who.notified', { name: watcherName(loop.notified, members, myHandle) });
}

/** The sentence of the card's mark (its title and its accessible name). */
export function loopSummary(
  loop: TaskLoop,
  members: MemberIndex,
  myHandle: string | null,
  now: Date,
): string {
  return t('loop.summary', {
    pair: pairText(loop.members, members, myHandle),
    minutes: minutesBetween(loop.startedAt, now),
    count: loop.count,
    who: loopWho(loop, members, myHandle),
  });
}
