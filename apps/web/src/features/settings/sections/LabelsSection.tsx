import { isHumanOnlyLabel } from '@projectman/shared';
import type { LabelView, ProjectConfig } from '@projectman/shared';
import { useLabels } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { LabelChip } from '../../../components/LabelChip';
import { joinNames, t } from '../../../i18n/t';
import { nameOf } from '../../../lib/members';
import { LabelsEditor } from '../LabelsEditor';
import { EditableSection } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The label vocabulary: each label's meaning and who may set it (editable by admins; approvals by owners). */
export function LabelsSection({ config }: { config: ProjectConfig }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const labels = useLabels(key);
  const who = (label: LabelView) =>
    label.setBy === 'anyone' || label.setBy === 'humans' || label.setBy === 'system'
      ? t(`settings.labels.whoOptions.${label.setBy}`)
      : t('settings.labels.setters', {
          names: joinNames(label.holders.map((handle) => nameOf(handle, members, myHandle))),
        });
  return (
    <SettingsSection
      id="settings-labels"
      title={t('settings.sections.labels')}
      meta={
        <span className={shared.muted}>
          {t('settings.labels.count', { count: config.pipeline.labels.length })}
        </span>
      }
    >
      <p className={shared.muted}>{t('settings.labels.intro')}</p>
      <EditableSection section="labels" editor={(props) => <LabelsEditor {...props} />}>
        <ul className={shared.stages}>
          {labels.map((label) => (
            <li key={label.id} className={shared.stage}>
              <div className={shared.stageTop}>
                <LabelChip id={label.id} labels={labels} />
                <span className={shared.muted}>
                  {[
                    who(label),
                    ...(isHumanOnlyLabel(label) ? [t('settings.labels.approval')] : []),
                    ...(label.requiresComment ? [t('settings.labels.requiresComment')] : []),
                    ...(label.blocks ? [t('settings.labels.blocks')] : []),
                  ].join(' · ')}
                </span>
              </div>
              {label.meaning ? <p className={shared.muted}>{label.meaning}</p> : null}
            </li>
          ))}
        </ul>
      </EditableSection>
    </SettingsSection>
  );
}
