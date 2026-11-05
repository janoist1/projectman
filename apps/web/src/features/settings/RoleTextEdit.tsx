import type { KeyboardEvent } from 'react';
import { isBuiltInRole } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import type { getLocale } from '@projectman/templates';
import { Button } from '../../components/Button';
import { TextAreaField } from '../../components/Field';
import { t } from '../../i18n/t';
import { issueMessage } from '../../lib/configIssues';
import type { IssueRef } from '../../lib/configIssues';
import { useElementEdit } from './edit/useElementEdit';
import { useLeaveGuard } from './edit/useLeaveGuard';
import { PanelBands } from './pipeline/PanelBands';
import { roleText, withRoleText } from './rolesEdit';
import type { RoleTextField } from './rolesEdit';
import styles from './DutiesMatrix.module.css';

/**
 * One text of one role (the short description, what is not their job, when to ask, the extra duties) as an
 * element of its own: a small Save / Cancel row appears under it while it holds a change, Ctrl/⌘+Enter
 * saves and Esc drops the change. Several of them can hold changes at once.
 */
export function RoleTextEdit({
  config,
  locale,
  role,
  roleName,
  field,
  label,
  maxLength,
  disabled,
  card,
}: {
  config: ProjectConfig;
  locale: ReturnType<typeof getLocale>;
  role: string;
  roleName: string;
  field: RoleTextField;
  label: string;
  maxLength?: number;
  disabled: boolean;
  /** On a phone the field has its visible label; in the table the column and row heads are the label. */
  card: boolean;
}) {
  const what = `${roleName} · ${label}`;
  const edit = useElementEdit<string>({
    key: `role:${role}:${field}`,
    initial: (current) =>
      isBuiltInRole(role) || current.team.roles.some((entry) => entry.id === role)
        ? roleText(current, role, field, locale)
        : null,
    apply: (current, value) => withRoleText(current, role, field, value, locale),
    toPatch: (candidate) => ({
      roleOverrides: candidate.team.roleOverrides ?? {},
      roles: candidate.team.roles,
    }),
    savedText: () => t('duties.textSaved', { role: roleName, field: label }),
    name: () => what,
  });
  useLeaveGuard(edit.dirty, edit.discard, what);
  const canSave = edit.dirty && edit.errors.length === 0 && edit.locked.length === 0 && !edit.gone;
  const failed = edit.failure?.kind === 'issues' ? edit.failure.issues : [];
  const other = [...edit.errors, ...failed].map((issue: IssueRef) => ({
    message: issueMessage(issue),
    code: issue.code,
    path: issue.path,
  }));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && edit.dirty) {
      event.stopPropagation();
      edit.discard();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) {
      event.preventDefault();
      void edit.save();
    }
  };
  const common = {
    disabled: disabled || edit.saving,
    maxLength,
    placeholder: isBuiltInRole(role) && field !== 'instructions' ? locale.roles[role][field] : undefined,
    value: edit.draft ?? '',
    onChange: (event: { target: { value: string } }) => edit.setDraft(event.target.value),
    onKeyDown,
  };

  return (
    <div className={styles.textEdit}>
      {card ? (
        <TextAreaField label={label} {...common} />
      ) : (
        <textarea aria-label={`${label}: ${roleName}`} {...common} />
      )}
      {edit.dirty || edit.conflict || edit.failure || edit.gone ? (
        <>
          <PanelBands edit={edit} config={config} other={other} />
          {edit.dirty ? (
            <div className={styles.textActions}>
              <span className={styles.unsaved}>
                <span aria-hidden="true">●</span> {t('settings.pipeline.edit.unsaved')}
              </span>
              <Button
                size="sm"
                variant="primary"
                disabled={!canSave}
                loading={edit.saving}
                onClick={() => void edit.save()}
              >
                {t('settings.pipeline.edit.save')}
              </Button>
              <Button size="sm" variant="secondary" disabled={edit.saving} onClick={edit.discard}>
                {t('settings.pipeline.edit.cancel')}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
