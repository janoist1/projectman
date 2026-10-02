import { Link } from 'react-router';
import type { MemberConfig, ProjectConfig, RoleView } from '@projectman/shared';
import { useRoles } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { Chip } from '../../../components/Chip';
import { t } from '../../../i18n/t';
import { roleLabel } from '../../../lib/members';
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

/**
 * The configured members in short: name and role. Model, permissions, capacity and subscription
 * are the Team page's business, which this links to instead of repeating them.
 */
export function TeamSection({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const roles = useRoles(key);
  return (
    <SettingsSection id="settings-team" title={t('settings.sections.team')}>
      <ul className={shared.members}>
        {config.team.members.map((member) => (
          <li key={member.handle}>
            <span className={shared.strong}>
              {member.displayName}
              {member.kind === 'ai' ? (
                <>
                  {' '}
                  <Chip tone="dark">{t('common.ai')}</Chip>
                </>
              ) : null}
            </span>
            <span className={shared.muted}>
              {memberRole(member, roles.data?.roles ?? [])} ·{' '}
              <code className={shared.id}>{member.handle}</code>
            </span>
          </li>
        ))}
      </ul>
      <p className={shared.muted}>
        <Link to={`/p/${key}/team`}>{t('settings.team.manage')}</Link>
      </p>
    </SettingsSection>
  );
}
