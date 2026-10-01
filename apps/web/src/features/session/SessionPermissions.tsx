import { Approver, effectiveSessionPermissions, SelectablePermissionMode } from '@projectman/shared';
import type { MemberView, Session, UpdateSessionRequest } from '@projectman/shared';
import { useUpdateSession } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Button } from '../../components/Button';
import { Chip } from '../../components/Chip';
import { SelectField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './SessionPermissions.module.css';

const modeName = (mode: string) => t(`permissionModes.${mode as SelectablePermissionMode}`);
const approverName = (approver: Approver) => t(`permissionControls.approvers.${approver}`);

/**
 * The permission settings that apply to the session (PM-170): its own, set by an owner, else its
 * member's (`effectiveSessionPermissions`). Everyone sees them as chips, marked when they belong to
 * this session only. An owner gets the two selectors ("Mód", "Ha kérdez, ki dönt"), saved at once
 * for this session and its resumes only, and a way back to the member's settings. A new mode
 * that waits for the session's restart, and grants that restart dropped, are said under them.
 */
export function SessionPermissions({
  session,
  member,
}: {
  session: Session;
  member: MemberView | undefined;
}) {
  const { key, isOwner } = useProject();
  const update = useUpdateSession(key);
  const toast = useToast();
  if (member && member.kind !== 'ai') return null;
  const effective = effectiveSessionPermissions(member, session);
  const own = effective.source.mode === 'session' || effective.source.approver === 'session';
  const notes = (
    <>
      {session.permissionRestartPending ? (
        <p className={styles.note} role="status">
          {t('session.permissions.restartPending')}
        </p>
      ) : null}
      {session.permissionGrantsLost ? (
        <p className={styles.warning} role="status">
          {t('session.permissions.grantsLost')}
        </p>
      ) : null}
    </>
  );

  if (!isOwner) {
    return (
      <>
        {effective.permissionMode ? (
          <Chip size="md">
            {t('session.chips.permissions', { mode: modeName(effective.permissionMode) })}
            {effective.source.mode === 'session' ? ` · ${t('session.chips.sessionOwn')}` : ''}
          </Chip>
        ) : null}
        <Chip size="md">
          {t('session.chips.approver', { approver: approverName(effective.approver) })}
          {effective.source.approver === 'session' ? ` · ${t('session.chips.sessionOwn')}` : ''}
        </Chip>
        {notes}
      </>
    );
  }

  const save = (body: UpdateSessionRequest, done: string) =>
    update.mutate(
      { sessionId: session.id, body },
      {
        onSuccess: () => toast.show(done),
        onError: (error) => toast.show(errorMessage(error), 'error'),
      },
    );
  const legacy = effective.permissionMode === 'bypassPermissions';
  const blocker = member?.aiApproverBlocker;
  // The member's own value is named in the list, so the owner sees what "back" would mean.
  const optionLabel = (value: string, name: string, memberValue: string | undefined) =>
    value === memberValue ? t('session.permissions.memberValue', { value: name }) : name;
  return (
    <div className={styles.control}>
      <div className={styles.line}>
        <SelectField
          label={t('session.permissions.mode')}
          value={legacy ? '' : (effective.permissionMode ?? 'default')}
          disabled={update.isPending}
          fieldClassName={styles.field}
          onChange={(event) =>
            save(
              { permissionMode: SelectablePermissionMode.parse(event.target.value) },
              t('session.permissions.saved'),
            )
          }
        >
          {legacy ? (
            <option value="" disabled>
              {t('permissionControls.legacy')}
            </option>
          ) : null}
          {SelectablePermissionMode.options.map((mode) => (
            <option key={mode} value={mode}>
              {optionLabel(mode, modeName(mode), member?.permissionMode)}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('session.permissions.approver')}
          value={effective.approver}
          disabled={update.isPending}
          fieldClassName={styles.field}
          onChange={(event) =>
            save({ approver: Approver.parse(event.target.value) }, t('session.permissions.saved'))
          }
        >
          {Approver.options.map((approver) => (
            <option key={approver} value={approver} disabled={approver === 'ai' && blocker !== undefined}>
              {optionLabel(approver, approverName(approver), member?.approver)}
            </option>
          ))}
        </SelectField>
        {own ? (
          <Button
            variant="secondary"
            disabled={update.isPending}
            onClick={() =>
              save(
                {
                  ...(effective.source.mode === 'session' ? { permissionMode: null } : {}),
                  ...(effective.source.approver === 'session' ? { approver: null } : {}),
                },
                t('session.permissions.resetDone'),
              )
            }
          >
            {t('session.permissions.reset')}
          </Button>
        ) : null}
      </div>
      {blocker ? <p className={styles.note}>{t(`permissionControls.blocked.${blocker}`)}</p> : null}
      {notes}
    </div>
  );
}
