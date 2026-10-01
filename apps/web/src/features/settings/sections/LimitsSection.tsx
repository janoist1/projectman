import type { ProjectConfig } from '@projectman/shared';
import { useRoles } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { aiRoleView } from '../../../lib/roles';
import { EditableSection } from '../SettingsEditor';
import type { SectionEditorProps } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The number the field starts at when the owner turns "no limit" off. */
const DEFAULT_MAX_CONCURRENT_AI_CHOICE = 3;

function LimitsEditor({ draft, change, isOwner }: SectionEditorProps) {
  const { key } = useProject();
  const roles = useRoles(key);
  const { limits } = draft.team;
  return (
    <>
      <label className={shared.field}>
        {t('settings.limits.boundaryEnabled')}
        <input
          type="checkbox"
          disabled={!isOwner}
          checked={draft.team.boundary?.enabled ?? false}
          onChange={(event) =>
            change((config) => {
              config.team.boundary = {
                enabled: event.target.checked,
                leadTimeoutSeconds: config.team.boundary?.leadTimeoutSeconds ?? 120,
              };
            })
          }
        />
      </label>
      <p>{t('settings.limits.boundaryHelp')}</p>
      <label className={shared.field}>
        {t('settings.limits.boundaryTimeout')}
        <input
          type="number"
          min={1}
          max={600}
          disabled={!isOwner}
          value={draft.team.boundary?.leadTimeoutSeconds ?? 120}
          onChange={(event) =>
            change((config) => {
              config.team.boundary = {
                enabled: config.team.boundary?.enabled ?? false,
                leadTimeoutSeconds: Number(event.target.value),
              };
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.limits.aiEnabled')}
        <input
          type="checkbox"
          checked={limits.aiEnabled}
          aria-describedby="ai-enabled-help"
          onChange={(event) =>
            change((config) => {
              config.team.limits.aiEnabled = event.target.checked;
            })
          }
        />
      </label>
      <p id="ai-enabled-help">{t('settings.limits.aiEnabledHelp')}</p>
      <label className={shared.field}>
        {t('settings.limits.noAiLimit')}
        <input
          type="checkbox"
          checked={limits.maxConcurrentAi === undefined}
          aria-describedby="ai-limit-help"
          onChange={(event) =>
            change((config) => {
              if (event.target.checked) delete config.team.limits.maxConcurrentAi;
              else config.team.limits.maxConcurrentAi = DEFAULT_MAX_CONCURRENT_AI_CHOICE;
            })
          }
        />
      </label>
      <p id="ai-limit-help">{t('settings.limits.noAiLimitHelp')}</p>
      {limits.maxConcurrentAi !== undefined ? (
        <label className={shared.field}>
          {t('settings.limits.maxConcurrentAi')}
          <input
            type="number"
            min={1}
            max={20}
            value={limits.maxConcurrentAi}
            onChange={(event) =>
              change((config) => {
                config.team.limits.maxConcurrentAi = Number(event.target.value);
              })
            }
          />
        </label>
      ) : null}
      <label className={shared.field}>
        {t('settings.limits.pauseAbove')}
        <input
          type="range"
          min={10}
          max={100}
          value={limits.pauseAbovePlanUsagePercent}
          onChange={(event) =>
            change((config) => {
              config.team.limits.pauseAbovePlanUsagePercent = Number(event.target.value);
            })
          }
        />
        <output>
          {t('settings.limits.pauseAboveValue', {
            percent: limits.pauseAbovePlanUsagePercent,
          })}
        </output>
      </label>
      <label className={shared.field}>
        {t('settings.limits.tempWorkers')}
        <input
          type="checkbox"
          checked={limits.tempWorkers.enabled}
          onChange={(event) =>
            change((config) => {
              config.team.limits.tempWorkers.enabled = event.target.checked;
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.edit.tempMax')}
        <input
          type="number"
          min={0}
          max={5}
          value={limits.tempWorkers.max}
          onChange={(event) =>
            change((config) => {
              config.team.limits.tempWorkers.max = Number(event.target.value);
            })
          }
        />
      </label>
      <label className={shared.field}>
        {t('settings.team.role')}
        <select
          value={limits.tempWorkers.role}
          disabled={!roles.data}
          onChange={(event) =>
            change((config) => {
              config.team.limits.tempWorkers.role = event.target.value;
            })
          }
        >
          {(roles.data?.roles ?? [])
            .filter((role) => role.holders !== 'human')
            .map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
        </select>
      </label>
      {roles.isError ? <p role="alert">{errorMessage(roles.error)}</p> : null}
    </>
  );
}

/** The team's limits: the AI switch, concurrency, the plan-usage pause and temp workers. */
export function LimitsSection({ config }: { config: ProjectConfig }) {
  const { key } = useProject();
  const roles = useRoles(key);
  const { limits } = config.team;
  return (
    <SettingsSection id="settings-limits" title={t('settings.sections.limits')}>
      <EditableSection section="limits" editor={(props) => <LimitsEditor {...props} />}>
        <dl className={shared.facts}>
          <div>
            <dt>{t('settings.limits.boundaryEnabled')}</dt>
            <dd>
              {t(
                config.team.boundary?.enabled
                  ? 'settings.limits.aiEnabledOn'
                  : 'settings.limits.aiEnabledOff',
              )}
            </dd>
          </div>
          <div>
            <dt>{t('settings.limits.aiEnabled')}</dt>
            <dd>{t(limits.aiEnabled ? 'settings.limits.aiEnabledOn' : 'settings.limits.aiEnabledOff')}</dd>
          </div>
          <div>
            <dt>{t('settings.limits.maxConcurrentAi')}</dt>
            <dd>
              {limits.maxConcurrentAi === undefined
                ? t('settings.limits.noAiLimit')
                : t('settings.limits.maxConcurrentAiValue', { count: limits.maxConcurrentAi })}
            </dd>
          </div>
          <div>
            <dt>{t('settings.limits.pauseAbove')}</dt>
            <dd>{t('settings.limits.pauseAboveValue', { percent: limits.pauseAbovePlanUsagePercent })}</dd>
          </div>
          <div>
            <dt>{t('settings.limits.tempWorkers')}</dt>
            <dd>
              {limits.tempWorkers.enabled
                ? t('settings.limits.tempWorkersOn', {
                    max: limits.tempWorkers.max,
                    role: aiRoleView(limits.tempWorkers.role, undefined, roles.data?.roles).name,
                  })
                : t('settings.limits.tempWorkersOff')}
            </dd>
          </div>
        </dl>
      </EditableSection>
    </SettingsSection>
  );
}
