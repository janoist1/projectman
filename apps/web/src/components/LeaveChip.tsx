import { Fragment } from 'react';
import { isOnLeave } from '@projectman/shared';
import { t } from '../i18n/t';
import { nameOf } from '../lib/members';
import type { MemberIndex } from '../lib/members';
import { Chip } from './Chip';

/** Enough of a member to tell whether it is on leave; MemberView and MemberConfig both fit. */
type LeaveMember = Parameters<typeof isOnLeave>[0];

/**
 * The one mark for a member on leave, next to the name wherever a member is chosen or named as
 * responsible. It shows nothing for a member at work, a person or one not (yet) known.
 */
export function LeaveChip({ member }: { member: LeaveMember | null | undefined }) {
  return isOnLeave(member) ? <Chip tone="needs">{t('leave.onLeave')}</Chip> : null;
}

/** " · Szabadságon" or nothing: for a native `<option>` or an aria-label, where a chip cannot be drawn. */
export function leaveSuffix(member: LeaveMember | null | undefined): string {
  return isOnLeave(member) ? ` · ${t('leave.onLeave')}` : '';
}

/** Names joined the Hungarian way ("a, b és c"), the mark after the name of a member on leave. */
export function MemberNames({
  handles,
  members,
  myHandle,
}: {
  handles: readonly string[];
  members: MemberIndex;
  myHandle: string | null;
}) {
  return (
    <>
      {handles.map((handle, index) => {
        const member = members.get(handle);
        return (
          <Fragment key={handle}>
            {index === 0 ? null : index === handles.length - 1 ? t('common.and') : t('common.listSeparator')}
            {nameOf(handle, members, myHandle)}
            {isOnLeave(member) ? (
              <>
                {' '}
                <LeaveChip member={member} />
              </>
            ) : null}
          </Fragment>
        );
      })}
    </>
  );
}
