import type { DocumentChangeAuthor } from '@projectman/shared';
import { t } from '../../i18n/t';
import { actorLabel } from '../../lib/members';
import type { MemberIndex } from '../../lib/members';

/**
 * Who a document change is shown as: the connected Claude's label when the commit names it, the integrator
 * when only the origin is known, else the commit's author name (as before decision 66).
 */
export function authorLabel(by: DocumentChangeAuthor, members: MemberIndex, myHandle: string | null): string {
  if (by.actor) return actorLabel(by.actor, members, myHandle);
  return by.via === 'integrator' ? t('involvement.integratorFull') : by.name;
}
