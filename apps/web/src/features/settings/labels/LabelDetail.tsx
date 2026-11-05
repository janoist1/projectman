import { useContext } from 'react';
import type { MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { isHumanOnlyLabel } from '@projectman/shared';
import type { LabelDefinition, ProjectConfig } from '@projectman/shared';
import { useProject } from '../../../app/contexts';
import { t } from '../../../i18n/t';
import { LeaveGuardContext } from '../edit/LeaveGuard';
import fields from '../pipeline/StagePanel.module.css';
import { labelUsage } from './labelDraft';
import type { LabelUsage } from './labelDraft';
import styles from './LabelPanel.module.css';
import { whoText } from './labelText';

/** The steps whose gate asks for the label, forbids it or binds to it: each opens that step on the Folyamat page. */
export function UsageList({ uses }: { uses: readonly LabelUsage[] }) {
  const { key } = useProject();
  const guard = useContext(LeaveGuardContext);
  const navigate = useNavigate();
  if (uses.length === 0) return <p className={fields.hintText}>{t('settings.labels.edit.whereNone')}</p>;
  return (
    <ul className={styles.usage}>
      {uses.map((use) => {
        const to = `/p/${key}/settings/pipeline?show=stage:${use.stageId}`;
        return (
          <li key={`${use.stageId}:${use.use}`}>
            <Link
              to={to}
              onClick={(event: MouseEvent) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0)
                  return;
                // An unsaved change asks before the page changes.
                event.preventDefault();
                if (guard) guard.request(() => navigate(to));
                else navigate(to);
              }}
            >
              {use.stageName}
            </Link>{' '}
            <span className={styles.usageUse}>· {t(`settings.labels.edit.use.${use.use}`)}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The label's rules as a short list of sentences. */
function ruleTexts(label: LabelDefinition): string[] {
  return [
    ...(isHumanOnlyLabel(label) ? [t('settings.labels.approval')] : []),
    ...(label.group ? [t('settings.labels.edit.inGroup', { group: label.group })] : []),
    ...(label.notByAuthor ? [t('settings.labels.notByAuthor')] : []),
    ...(label.requiresComment ? [t('settings.labels.requiresComment')] : []),
    ...(label.notifyAssignee ? [t('settings.labels.notifyAssignee')] : []),
    ...(label.blocks ? [t('settings.labels.blocks')] : []),
    ...(label.clearedWhen ?? []).map((trigger) => t(`settings.labels.clearedWhen.${trigger}`)),
  ];
}

/** What a member sees of a label: the same facts as the editor, as text. */
export function LabelDetail({ config, label }: { config: ProjectConfig; label: LabelDefinition }) {
  const rules = ruleTexts(label);
  return (
    <>
      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt>{t('settings.labels.meaning')}</dt>
          <dd className={styles.value}>{label.meaning || t('settings.labels.edit.noMeaning')}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('settings.labels.who')}</dt>
          <dd className={styles.value}>{whoText(label, config)}</dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('settings.labels.edit.rules')}</dt>
          <dd className={styles.value}>
            {rules.length === 0 ? (
              t('settings.labels.edit.rulesNone')
            ) : (
              <ul className={styles.rules}>
                {rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            )}
          </dd>
        </div>
        <div className={styles.fact}>
          <dt>{t('settings.labels.edit.where')}</dt>
          <dd className={styles.value}>
            <UsageList uses={labelUsage(config, label.id)} />
          </dd>
        </div>
      </dl>
      <p className={fields.id}>
        {t('settings.pipeline.id')} <code>{label.id}</code>
      </p>
      <p className={fields.hintText}>{t('settings.pipeline.memberNote')}</p>
    </>
  );
}
