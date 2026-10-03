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

/** "2 kódátnézés és 1 visszaküldés": what the rounds were; the kinds that did not happen are left out. */
export function fixRoundParts(counts: FixRoundParts): string {
  const parts = [
    counts.changeRequests > 0 ? t('fixLimit.part.changes', { count: counts.changeRequests }) : null,
    counts.designChangeRequests > 0
      ? t('fixLimit.part.design', { count: counts.designChangeRequests })
      : null,
    counts.sendBacks > 0 ? t('fixLimit.part.sendBacks', { count: counts.sendBacks }) : null,
  ].filter((part): part is string => part !== null);
  return joinNames(parts.length > 0 ? parts : [t('fixLimit.part.sendBacks', { count: 0 })]);
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

/** Who has the held card and, when it went to the people, why, as a sentence for the drawer's box. */
export function fixLimitWho(limit: TaskFixLimit, members: MemberIndex, myHandle: string | null): string {
  if (limit.phase === 'owner') {
    const decides = decidesText(limit.deciders, members, myHandle);
    return t(`fixLimit.box.people.${limit.reason ?? 'no_ai_decider'}`, { decides });
  }
  return t(limit.phase === 'lead' ? 'fixLimit.box.lead' : 'fixLimit.box.replan', {
    name: nameOf(limit.decider, members, myHandle),
  });
}
