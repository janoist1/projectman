import { PermissionLevel } from '@projectman/shared';
import type { MemberView } from '@projectman/shared';
import { useUpdateMember } from '../../api/queries';
import { useProject } from '../../app/contexts';
import { Chip } from '../../components/Chip';
import { SelectField } from '../../components/Field';
import { useToast } from '../../components/toastContext';
import { t } from '../../i18n/t';
import { errorMessage } from '../../lib/errors';
import styles from './PermissionLevelControl.module.css';

/** An AI member's level with no way to change it, as everyone but an owner sees it. */
function PermissionLevelText({ member }: { member: MemberView }) {
  const level = member.permissionLevel;
  return (
    <span className={styles.control}>
      <span className={styles.line}>
        {level ? t(`permissionLevels.levels.${level}`) : t('common.dash')}
        {member.permissionLegacy ? <Chip>{t('permissionLevels.legacy')}</Chip> : null}
      </span>
      {member.permissionLegacy ? (
        <span className={styles.note}>{t('permissionLevels.legacyHint')}</span>
      ) : null}
    </span>
  );
}

/**
 * The permission level of an AI member. Only an owner gets the selector; the choice is saved at
 * once (`PATCH` of the member). "Ask, AI decides" is disabled, with the reason, while the server
 * says it cannot be chosen. Everyone else only reads the level.
 */
export function PermissionLevelControl({ member }: { member: MemberView }) {
  const { key, isOwner } = useProject();
  const update = useUpdateMember(key);
  const toast = useToast();
  if (member.kind !== 'ai') return null;
  if (!isOwner) return <PermissionLevelText member={member} />;
  const level = member.permissionLevel ?? 'auto';
  const blocker = member.askAiBlocker;
  return (
    <span className={styles.control}>
      <SelectField
        label={t('permissionLevels.title')}
        hideLabel
        value={member.permissionLegacy ? '' : level}
        disabled={update.isPending}
        onChange={(event) => {
          const chosen = PermissionLevel.parse(event.target.value);
          update.mutate(
            { handle: member.handle, body: { permissionLevel: chosen } },
            {
              onSuccess: () =>
                toast.show(
                  t('permissionLevels.saved', {
                    name: member.displayName,
                    level: t(`permissionLevels.levels.${chosen}`),
                  }),
                ),
              onError: (error) => toast.show(errorMessage(error), 'error'),
            },
          );
        }}
      >
        {member.permissionLegacy ? (
          <option value="" disabled>
            {t('permissionLevels.legacy')}
          </option>
        ) : null}
        {PermissionLevel.options.map((option) => (
          <option key={option} value={option} disabled={option === 'ask_ai' && blocker !== undefined}>
            {t(`permissionLevels.levels.${option}`)}
          </option>
        ))}
      </SelectField>
      {blocker ? <span className={styles.note}>{t(`permissionLevels.blocked.${blocker}`)}</span> : null}
      {member.permissionLegacy ? (
        <span className={styles.note}>{t('permissionLevels.legacyHint')}</span>
      ) : null}
    </span>
  );
}
