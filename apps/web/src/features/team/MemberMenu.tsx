import { useId } from 'react';
import { isOperator } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import { Button } from '../../components/Button';
import { MoreMenu } from '../../components/MoreMenu';
import { t } from '../../i18n/t';
import { useIsRequiredPm } from '../operator/useRequiredMember';
import { LeaveButton } from './LeaveButton';
import styles from './MemberMenu.module.css';

/**
 * The "⋯" menu of a member, on the roster and on the profile: edit, rename (the owner, AI), invite (an unclaimed human),
 * leave (AI), retire (AI) and remove (human). An action is offered when its handler is given.
 */
export function MemberMenu({
  member,
  onEdit,
  editDisabled = false,
  onRename,
  onInvite,
  onRetire,
  onRemove,
}: {
  member: MemberView;
  onEdit: () => void;
  editDisabled?: boolean;
  /** The owner's rename of an AI member's handle (PM-1026); the caller offers it only when allowed. */
  onRename?: () => void;
  onInvite?: () => void;
  onRetire?: () => void;
  onRemove?: () => void;
}) {
  const required = useIsRequiredPm(member.handle);
  const noteId = useId();
  // The Operator is built in (PM-447): it can only be given another model and effort, never leave or be retired.
  if (isOperator(member)) {
    return (
      <MoreMenu label={t('team.moreFor', { name: member.displayName })}>
        {(close) => (
          <Button
            variant="ghost"
            disabled={editDisabled}
            onClick={() => {
              onEdit();
              close();
            }}
            aria-label={t('operator.builtIn.editMember')}
          >
            {t('operator.builtIn.edit')}
          </Button>
        )}
      </MoreMenu>
    );
  }
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
          {onRename ? (
            <Button
              variant="ghost"
              onClick={() => {
                onRename();
                close();
              }}
              aria-label={t('memberRename.menuFor', { name: member.displayName })}
            >
              {t('memberRename.menu')}
            </Button>
          ) : null}
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
            <>
              <Button
                variant="danger"
                // Focusable though refused, so the reason below is read with it (PM-429).
                aria-disabled={required || undefined}
                aria-describedby={required ? noteId : undefined}
                onClick={() => {
                  if (required) return;
                  onRetire();
                  close();
                }}
                aria-label={t('team.retireMember', { name: member.displayName, handle: member.handle })}
              >
                {t('team.retire')}
              </Button>
              {required ? (
                <p id={noteId} className={styles.note}>
                  {t('pm.required.retireNote')}
                </p>
              ) : null}
            </>
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
