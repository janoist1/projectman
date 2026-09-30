import type { ProjectConfig } from '@projectman/shared';
import { t } from '../../../i18n/t';
import { EditableSection } from '../SettingsEditor';
import type { SectionEditorProps } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

const EDITABLE_FIELDS = ['name', 'language', 'timezone'] as const;

function ProjectEditor({ draft, change }: SectionEditorProps) {
  return (
    <>
      {EDITABLE_FIELDS.map((field) => (
        <label key={field} className={shared.field}>
          {t(`settings.project.${field}`)}
          <input
            value={draft.project[field]}
            onChange={(event) =>
              change((config) => {
                config.project[field] = event.target.value;
              })
            }
          />
        </label>
      ))}
    </>
  );
}

/** The project's name, key, workspace, language and time zone. */
export function ProjectSection({ config }: { config: ProjectConfig }) {
  const { project } = config;
  return (
    <SettingsSection id="settings-project" title={t('settings.sections.project')}>
      <EditableSection section="project" editor={(props) => <ProjectEditor {...props} />}>
        <dl className={shared.facts}>
          <div>
            <dt>{t('settings.project.name')}</dt>
            <dd>{project.name}</dd>
          </div>
          <div>
            <dt>{t('settings.project.key')}</dt>
            <dd>
              <code className={shared.id}>{project.key}</code>
            </dd>
          </div>
          <div>
            <dt>{t('settings.project.workspace')}</dt>
            <dd>
              <code className={shared.id}>{project.workspacePath}</code>
            </dd>
          </div>
          <div>
            <dt>{t('settings.project.language')}</dt>
            <dd>{project.language}</dd>
          </div>
          <div>
            <dt>{t('settings.project.timezone')}</dt>
            <dd>{project.timezone}</dd>
          </div>
        </dl>
      </EditableSection>
    </SettingsSection>
  );
}
