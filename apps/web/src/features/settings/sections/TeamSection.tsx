import type { MemberConfig, ProjectConfig, RoleView } from '@projectman/shared';
import { useRoles } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { Chip } from '../../../components/Chip';
import { t } from '../../../i18n/t';
import { nameOf, roleLabel } from '../../../lib/members';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

function memberRole(member: MemberConfig, roles: readonly RoleView[]): string {
  return member.kind === 'human'
    ? roleLabel(
        {
          handle: member.handle,
          displayName: member.displayName,
          kind: 'human',
          role: member.access,
        },
        roles,
      )
    : roleLabel(
        {
          handle: member.handle,
          displayName: member.displayName,
          kind: 'ai',
          role: member.role,
          specialty: member.specialty,
        },
        roles,
      );
}

/** The configured members: role, model, permissions, capacity and whose subscription runs them. */
export function TeamSection({ config }: { config: ProjectConfig }) {
  const { key, myHandle } = useProject();
  const roles = useRoles(key);
  const { members } = useProjectIndexes(key);
  return (
    <SettingsSection id="settings-team" title={t('settings.sections.team')}>
      <div className={shared.tableWrap}>
        <table className={shared.table}>
          <thead>
            <tr>
              <th scope="col">{t('settings.team.name')}</th>
              <th scope="col">{t('settings.team.handle')}</th>
              <th scope="col">{t('settings.team.role')}</th>
              <th scope="col">{t('settings.team.model')}</th>
              <th scope="col">{t('settings.team.permissions')}</th>
              <th scope="col">{t('settings.team.capacity')}</th>
              <th scope="col">{t('settings.team.sponsor')}</th>
            </tr>
          </thead>
          <tbody>
            {config.team.members.map((member) => (
              <tr key={member.handle}>
                <td className={shared.strong}>
                  {member.displayName}
                  {member.kind === 'ai' ? (
                    <>
                      {' '}
                      <Chip tone="dark">{t('common.ai')}</Chip>
                    </>
                  ) : null}
                </td>
                <td>
                  <code className={shared.id}>{member.handle}</code>
                </td>
                <td>{memberRole(member, roles.data?.roles ?? [])}</td>
                <td>{member.kind === 'ai' ? member.model : t('common.dash')}</td>
                <td>
                  {member.kind === 'ai' ? t(`permissionModes.${member.permissionMode}`) : t('common.dash')}
                </td>
                <td>
                  {member.kind === 'ai'
                    ? t('hire.capacityValue', { count: member.capacity })
                    : t('common.dash')}
                </td>
                <td>{member.kind === 'ai' ? nameOf(member.sponsor, members, myHandle) : t('common.dash')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SettingsSection>
  );
}
