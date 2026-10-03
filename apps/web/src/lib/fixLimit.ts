import type { TaskFixLimit } from '@projectman/shared';
import { joinNames, t } from '../i18n/t';
import { decidesText } from './loop';
import { nameOf, namesOf } from './members';
import type { MemberIndex } from './members';

/** The counts a fix round limit is made of (a hold, a decision item and a timeline row all carry them). */
export interface FixRoundParts {
  changeRequests: number;
  designChangeRequests: number;
  sendBacks: number;
}

/** "2 kódátnézési, 1 UI/UX és 0 visszaküldés": what the rounds were. */
export function fixRoundParts(counts: FixRoundParts, key: 'inbox.fixLimit.parts' | 'fixLimit.parts'): string {
  return t(key, {
    changes: counts.changeRequests,
    design: counts.designChangeRequests,
    sendBacks: counts.sendBacks,
  });
}

/** Whether the viewer is among those who decide a held card now. */
export function decidesFixLimit(limit: TaskFixLimit, myHandle: string | null): boolean {
  if (myHandle === null) return false;
  return limit.phase === 'owner' ? limit.deciders.includes(myHandle) : limit.decider === myHandle;
}

/** The card's one status line while it is held: who decides, or that the viewer does. */
export function fixLimitStatus(limit: TaskFixLimit, members: MemberIndex, myHandle: string | null): string {
  if (decidesFixLimit(limit, myHandle)) return t('taskStatus.fixLimitYou', { rounds: limit.rounds });
  const who =
    limit.phase === 'owner'
      ? joinNames(namesOf(limit.deciders, members, myHandle))
      : nameOf(limit.decider, members, myHandle);
  return t('taskStatus.fixLimit', { who, rounds: limit.rounds });
}

/** Who has the held card, as a sentence for the drawer's box. */
export function fixLimitWho(limit: TaskFixLimit, members: MemberIndex, myHandle: string | null): string {
  if (limit.phase === 'owner')
    return t('fixLimit.box.people', { decides: decidesText(limit.deciders, members, myHandle) });
  return t(limit.phase === 'lead' ? 'fixLimit.box.lead' : 'fixLimit.box.replan', {
    name: nameOf(limit.decider, members, myHandle),
  });
}
