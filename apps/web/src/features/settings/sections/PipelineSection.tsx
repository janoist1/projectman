import { resolvedStages } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { useLabels } from '../../../api/queries';
import { useProject, useProjectIndexes } from '../../../app/contexts';
import { Avatar } from '../../../components/Avatar';
import { Chip } from '../../../components/Chip';
import { LeaveChip } from '../../../components/LeaveChip';
import { t } from '../../../i18n/t';
import { gateConditionText } from '../../../lib/gates';
import { nameOf } from '../../../lib/members';
import { PipelineEditor } from '../PipelineEditor';
import { EditableSection } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The pipeline's stages: kind, column, owners and gate. */
export function PipelineSection({ config }: { config: ProjectConfig }) {
  const { key, myHandle } = useProject();
  const { members } = useProjectIndexes(key);
  const labels = useLabels(key);
  const byHandle = new Map(config.team.members.map((member) => [member.handle, member]));
  return (
    <SettingsSection
      id="settings-pipeline"
      title={t('settings.sections.pipeline')}
      meta={
        <span className={shared.muted}>
          {t('settings.pipeline.stageCount', { count: config.pipeline.stages.length })}
        </span>
      }
    >
      <EditableSection section="pipeline" editor={(props) => <PipelineEditor {...props} />}>
        <ol className={shared.stages}>
          {resolvedStages(config).map((stage) => (
            <li key={stage.id} className={shared.stage}>
              <div className={shared.stageTop}>
                <span className={shared.stageName}>{stage.name}</span>
                <Chip>
                  {stage.kind === 'step' && stage.duty
                    ? t('settings.pipeline.stepOf', { duty: t(`dutyNames.${stage.duty}`) })
                    : t(`stageKinds.${stage.kind}`)}
                </Chip>
                <code className={shared.id}>{stage.id}</code>
                <span className={shared.muted}>
                  {config.pipeline.columns.find((column) => column.id === stage.columnId)?.name}
                </span>
              </div>
              {stage.description ? <p className={shared.muted}>{stage.description}</p> : null}
              <div className={shared.owners}>
                <span className={shared.label}>{t('settings.pipeline.owners')}</span>
                {stage.owners.length === 0 ? (
                  <span className={shared.muted}>{t('settings.pipeline.noOwners')}</span>
                ) : (
                  stage.owners.map((handle) => {
                    const member = byHandle.get(handle);
                    return (
                      <span key={handle} className={shared.owner}>
                        <Avatar
                          member={
                            member
                              ? {
                                  handle,
                                  displayName: member.displayName,
                                  kind: member.kind,
                                  role: member.kind === 'human' ? member.access : member.role,
                                  specialty: member.kind === 'ai' ? member.specialty : null,
                                }
                              : members.get(handle)
                          }
                          handle={handle}
                          isMe={handle === myHandle}
                          size="xs"
                        />
                        {nameOf(handle, members, myHandle)}
                        <LeaveChip member={member ?? members.get(handle)} />
                      </span>
                    );
                  })
                )}
              </div>
              {stage.gate ? (
                <div className={shared.gate}>
                  <span className={shared.label}>{t('settings.pipeline.gate')}</span>
                  {stage.gate.conditions.map((condition, index) => (
                    <Chip key={index} tone="needs" icon="lock">
                      {gateConditionText(condition, labels)}
                    </Chip>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      </EditableSection>
    </SettingsSection>
  );
}
