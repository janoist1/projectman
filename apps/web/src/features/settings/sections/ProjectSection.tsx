import { useContext, useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import clsx from 'clsx';
import type { ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { Button } from '../../../components/Button';
import { SelectField, TextField } from '../../../components/Field';
import { t } from '../../../i18n/t';
import { issueMessage } from '../../../lib/configIssues';
import type { IssueRef } from '../../../lib/configIssues';
import { EditFooter } from '../edit/EditChrome';
import { LeaveGuardContext, LeaveGuardProvider } from '../edit/LeaveGuard';
import { useElementEdit } from '../edit/useElementEdit';
import { useLeaveGuard } from '../edit/useLeaveGuard';
import { PanelBands } from '../pipeline/PanelBands';
import shared from '../settings.module.css';
import styles from './ProjectSection.module.css';
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

/** The fields of the project the form edits. */
interface ProjectDraft {
  name: string;
  language: string;
  timezone: string;
}

type ProjectField = keyof ProjectDraft;
const FIELD_PATH = /^(?:project\.)?(name|language|timezone)$/;

/** The project's name, key, workspace, language and time zone. */
export function ProjectSection({ config }: { config: ProjectConfig }) {
  return (
    <LeaveGuardProvider>
      <ProjectBody config={config} />
    </LeaveGuardProvider>
  );
}

function ProjectBody({ config }: { config: ProjectConfig }) {
  const { can } = useProject();
  const formId = useId();
  const guard = useContext(LeaveGuardContext);
  const [editing, setEditing] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  /** Set when the form closes, so the focus goes back to the button once it is there again. */
  const refocus = useRef(false);
  const basics = t('settings.project.basics');
  const edit = useElementEdit<ProjectDraft>({
    key: 'project',
    initial: (current) => ({
      name: current.project.name,
      language: current.project.language,
      timezone: current.project.timezone,
    }),
    apply: (current, draft) => ({ ...current, project: { ...current.project, ...draft } }),
    toPatch: (candidate) => ({
      project: {
        name: candidate.project.name,
        language: candidate.project.language,
        timezone: candidate.project.timezone,
      },
    }),
    savedText: () => t('settings.project.saved'),
    name: () => basics.toLocaleLowerCase(),
  });
  useLeaveGuard(edit.dirty, edit.discard, basics);

  useEffect(() => {
    if (editing) nameField.current?.focus();
    else if (refocus.current) {
      refocus.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  // An undo from the toast removes the button the focus was on; it returns to the Edit button.
  useEffect(() => {
    if (edit.saves > 0 && !editing) editButton.current?.focus();
  }, [edit.saves]);

  const { project } = config;
  const draft = edit.draft;
  const close = () => {
    refocus.current = true;
    setEditing(false);
  };
  const cancel = () => {
    edit.discard();
    close();
  };
  const nameMissing = draft !== null && draft.name.trim() === '';
  const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
  const issues = new Map<ProjectField, string[]>();
  const other: { message: string; code: string; path: string }[] = [];
  const seen = new Set<string>();
  for (const issue of [...edit.errors, ...failed] as IssueRef[]) {
    const key = `${issue.code}:${issue.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const field = FIELD_PATH.exec(issue.path)?.[1] as ProjectField | undefined;
    // An empty name is said in the form's own words, whatever the schema calls it.
    if (field === 'name' && nameMissing) continue;
    if (field) issues.set(field, [...(issues.get(field) ?? []), issueMessage(issue)]);
    else other.push({ message: issueMessage(issue), code: issue.code, path: issue.path });
  }
  const errorOf = (field: ProjectField) =>
    field === 'name' && nameMissing
      ? t('settings.project.nameMissing')
      : (issues.get(field)?.join(' ') ?? null);
  const canSave =
    edit.dirty && !nameMissing && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    // A change asks first; an untouched form just closes.
    if (guard) guard.request(close);
    else cancel();
  };

  const view = (
    <dl key={edit.saves} className={clsx(shared.facts, edit.saves > 0 && styles.saved)}>
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
        <dd>
          {isKnownLanguage(project.language)
            ? t(`settings.project.languages.${project.language}`)
            : project.language}
        </dd>
      </div>
      <div>
        <dt>{t('settings.project.timezone')}</dt>
        <dd>{project.timezone}</dd>
      </div>
    </dl>
  );

  const form = draft ? (
    <form
      id={formId}
      className={styles.form}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        void edit.save().then((ok) => {
          if (ok) close();
        });
      }}
    >
      <PanelBands edit={edit} config={config} other={other} />
      <fieldset className={styles.fields} disabled={edit.saving}>
        <TextField
          ref={nameField}
          label={t('settings.project.name')}
          value={draft.name}
          error={errorOf('name')}
          onChange={(event) => edit.setDraft({ ...draft, name: event.target.value })}
        />
        <SelectField
          label={t('settings.project.language')}
          hint={t('settings.project.languageHint')}
          error={errorOf('language')}
          value={draft.language}
          onChange={(event) => edit.setDraft({ ...draft, language: event.target.value })}
        >
          {languageChoices(draft.language).map((language) => (
            <option key={language} value={language}>
              {isKnownLanguage(language) ? t(`settings.project.languages.${language}`) : language}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={t('settings.project.timezone')}
          error={errorOf('timezone')}
          value={draft.timezone}
          onChange={(event) => edit.setDraft({ ...draft, timezone: event.target.value })}
        >
          {timezoneChoices(draft.timezone).map((zone) => (
            <option key={zone} value={zone}>
              {zone}
            </option>
          ))}
        </SelectField>
      </fieldset>
      <p className={styles.readOnly}>
        {t('settings.project.key')} <code className={shared.id}>{project.key}</code> ·{' '}
        {t('settings.project.workspace')} <code className={shared.id}>{project.workspacePath}</code>
      </p>
      <EditFooter
        edit={edit}
        formId={formId}
        canSave={canSave}
        saveText={t('settings.pipeline.edit.save')}
        cancel="close"
        onClose={cancel}
      />
    </form>
  ) : null;

  return (
    <SettingsSection
      id="settings-project"
      title={t('settings.sections.project')}
      meta={
        can.manageTeam && !editing ? (
          <Button
            ref={editButton}
            className={styles.edit}
            size="sm"
            variant="secondary"
            icon="pencil"
            onClick={() => setEditing(true)}
          >
            {t('settings.project.edit')}
          </Button>
        ) : undefined
      }
    >
      {editing && form ? form : view}
    </SettingsSection>
  );
}
