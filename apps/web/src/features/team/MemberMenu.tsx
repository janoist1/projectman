import type { MemberView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { MoreMenu } from '../../components/MoreMenu';
import { t } from '../../i18n/t';
import { LeaveButton } from './LeaveButton';

/**
 * The "⋯" menu of a member, on the roster and on the profile: edit, invite (an unclaimed human),
 * leave (AI), retire (AI) and remove (human). An action is offered when its handler is given.
 */
export function MemberMenu({
  member,
  onEdit,
  editDisabled = false,
  onInvite,
  onRetire,
  onRemove,
}: {
  member: MemberView;
  onEdit: () => void;
  editDisabled?: boolean;
  onInvite?: () => void;
  onRetire?: () => void;
  onRemove?: () => void;
}) {
  return (
    <MoreMenu label={t('team.moreFor', { name: member.displayName })}>
      {(close) => (
        <>
          <Button
            variant="ghost"
            disabled={editDisabled}
            onClick={() => {
              onEdit();
              close();
            }}
            aria-label={t('memberEdit.editMember', { name: member.displayName })}
          >
            {t('memberEdit.edit')}
          </Button>
          {onInvite && member.kind === 'human' && member.status === 'no_account' ? (
            <Button
              variant="ghost"
              onClick={() => {
                onInvite();
                close();
              }}
            >
              {t('invites.create')}
            </Button>
          ) : null}
          {member.kind === 'ai' ? <LeaveButton member={member} onDone={close} /> : null}
          {onRetire && member.kind === 'ai' ? (
            <Button
              variant="danger"
              onClick={() => {
                onRetire();
                close();
              }}
              aria-label={t('team.retireMember', { name: member.displayName, handle: member.handle })}
            >
              {t('team.retire')}
            </Button>
          ) : null}
          {onRemove && member.kind === 'human' ? (
            <Button
              variant="danger"
              onClick={() => {
                onRemove();
                close();
              }}
            >
              {t('profile.remove')}
            </Button>
          ) : null}
        </>
      )}
    </MoreMenu>
  );
}
