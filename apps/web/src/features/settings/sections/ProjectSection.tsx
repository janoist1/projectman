import type { ProjectConfig } from '@projectman/shared';
import { SelectField, TextField } from '../../../components/Field';
import { t } from '../../../i18n/t';
import { EditableSection } from '../SettingsEditor';
import type { SectionEditorProps } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The languages the project's texts (templates, role texts) exist in. */
const LANGUAGES = ['hu', 'en'] as const;

/** The IANA time zones of this browser; a zone the project already has stays choosable. */
function timezoneChoices(current: string): string[] {
  const zones = new Set<string>(['UTC', ...Intl.supportedValuesOf('timeZone')]);
  zones.add(current);
  return [...zones].sort();
}

type KnownLanguage = (typeof LANGUAGES)[number];
const isKnownLanguage = (language: string): language is KnownLanguage =>
  (LANGUAGES as readonly string[]).includes(language);

/** The languages to choose from; a language the project already has stays choosable. */
function languageChoices(current: string): string[] {
  return isKnownLanguage(current) ? [...LANGUAGES] : [...LANGUAGES, current];
}

function ProjectEditor({ draft, change }: SectionEditorProps) {
  const { project } = draft;
  return (
    <>
      <TextField
        label={t('settings.project.name')}
        value={project.name}
        onChange={(event) =>
          change((config) => {
            config.project.name = event.target.value;
          })
        }
      />
      <SelectField
        label={t('settings.project.language')}
        value={project.language}
        onChange={(event) =>
          change((config) => {
            config.project.language = event.target.value;
          })
        }
      >
        {languageChoices(project.language).map((language) => (
          <option key={language} value={language}>
            {isKnownLanguage(language) ? t(`settings.project.languages.${language}`) : language}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('settings.project.timezone')}
        value={project.timezone}
        onChange={(event) =>
          change((config) => {
            config.project.timezone = event.target.value;
          })
        }
      >
        {timezoneChoices(project.timezone).map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </SelectField>
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
