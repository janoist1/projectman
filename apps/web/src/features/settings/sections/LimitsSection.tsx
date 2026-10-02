import { DEFAULT_AUTO_COMPACT_WINDOW_TOKENS, messageBurstOf } from '@projectman/shared';
import type { ProjectConfig } from '@projectman/shared';
import { isApiError } from '../../../api/client';
import { useRoles } from '../../../api/queries';
import { useProject } from '../../../app/contexts';
import { SelectField } from '../../../components/Field';
import { formatTokens } from '../../../i18n/format';
import { t } from '../../../i18n/t';
import { errorMessage } from '../../../lib/errors';
import { aiRoleView } from '../../../lib/roles';
import { InstantNumber, InstantRange, ToggleField } from '../InstantFields';
import { useInstantLimits } from '../SettingsEditor';
import shared from '../settings.module.css';
import { SettingsSection } from './SettingsSection';

/** The number the field starts at when the owner turns "no limit" off. */
const DEFAULT_MAX_CONCURRENT_AI_CHOICE = 3;

/** The number the token warning field starts at when the owner turns "no warning" off (PM-187). */
const DEFAULT_TOKEN_WARNING_CHOICE = 5_000_000;

/** The limits as controls that save as soon as they change; no edit mode, no save button. */
function LimitsControls({ config }: { config: ProjectConfig }) {
  const { key, isOwner } = useProject();
  const roles = useRoles(key);
  const { shown, saving, commit, error, locked } = useInstantLimits(config);
  const { limits } = shown.team;
  const messageBurst = messageBurstOf(limits);
  return (
    <fieldset className={shared.controls} disabled={locked}>
      {locked ? <p className={shared.help}>{t('settings.limits.locked')}</p> : null}
      <ToggleField
        label={t('settings.limits.boundaryEnabled')}
        help={t('settings.limits.boundaryHelp')}
        disabled={!isOwner}
        checked={shown.team.boundary?.enabled ?? false}
        onChange={(enabled) =>
          commit((draft) => {
            draft.team.boundary = {
              enabled,
              leadTimeoutSeconds: draft.team.boundary?.leadTimeoutSeconds ?? 120,
            };
          })
        }
      />
      <InstantNumber
        label={t('settings.limits.boundaryTimeout')}
        min={1}
        max={600}
        disabled={!isOwner}
        value={shown.team.boundary?.leadTimeoutSeconds ?? 120}
        onCommit={(seconds) =>
          commit((draft) => {
            draft.team.boundary = {
              enabled: draft.team.boundary?.enabled ?? false,
              leadTimeoutSeconds: seconds ?? 120,
            };
          })
        }
      />
      <ToggleField
        label={t('settings.limits.aiEnabled')}
        help={t('settings.limits.aiEnabledHelp')}
        checked={limits.aiEnabled}
        onChange={(enabled) =>
          commit((draft) => {
            draft.team.limits.aiEnabled = enabled;
          })
        }
      />
      <ToggleField
        label={t('settings.limits.noAiLimit')}
        help={t('settings.limits.noAiLimitHelp')}
        checked={limits.maxConcurrentAi === undefined}
        onChange={(noLimit) =>
          commit((draft) => {
            if (noLimit) delete draft.team.limits.maxConcurrentAi;
            else draft.team.limits.maxConcurrentAi = DEFAULT_MAX_CONCURRENT_AI_CHOICE;
          })
        }
      />
      {limits.maxConcurrentAi !== undefined ? (
        <InstantNumber
          label={t('settings.limits.maxConcurrentAi')}
          min={1}
          max={20}
          value={limits.maxConcurrentAi}
          onCommit={(count) =>
            commit((draft) => {
              draft.team.limits.maxConcurrentAi = count;
            })
          }
        />
      ) : null}
      <InstantRange
        label={t('settings.limits.pauseAbove')}
        min={10}
        max={100}
        value={limits.pauseAbovePlanUsagePercent}
        format={(percent) => t('settings.limits.pauseAboveValue', { percent })}
        onCommit={(percent) =>
          commit((draft) => {
            draft.team.limits.pauseAbovePlanUsagePercent = percent;
          })
        }
      />
      <ToggleField
        label={t('settings.limits.noTokenWarning')}
        help={t('settings.limits.noTokenWarningHelp')}
        checked={limits.warnAboveSessionTokens === undefined}
        onChange={(noWarning) =>
          commit((draft) => {
            if (noWarning) delete draft.team.limits.warnAboveSessionTokens;
            else draft.team.limits.warnAboveSessionTokens = DEFAULT_TOKEN_WARNING_CHOICE;
          })
        }
      />
      {limits.warnAboveSessionTokens !== undefined ? (
        <InstantNumber
          label={t('settings.limits.warnAboveSessionTokens')}
          min={10_000}
          max={1_000_000_000}
          step={10_000}
          value={limits.warnAboveSessionTokens}
          onCommit={(tokens) =>
            commit((draft) => {
              draft.team.limits.warnAboveSessionTokens = tokens;
            })
          }
        />
      ) : null}
      <InstantNumber
        label={t('settings.limits.autoCompactWindow')}
        hint={t('settings.limits.autoCompactWindowHelp')}
        min={100_000}
        max={1_000_000}
        step={10_000}
        optional
        placeholder={String(DEFAULT_AUTO_COMPACT_WINDOW_TOKENS)}
        value={limits.autoCompactWindowTokens}
        onCommit={(tokens) =>
          commit((draft) => {
            if (tokens === undefined) delete draft.team.limits.autoCompactWindowTokens;
            else draft.team.limits.autoCompactWindowTokens = tokens;
          })
        }
      />
      <p className={shared.help}>{t('settings.limits.messageBurstHelp')}</p>
      <div className={shared.fieldRow}>
        <InstantNumber
          label={t('settings.limits.messageBurstCount')}
          min={3}
          max={100}
          value={messageBurst.count}
          onCommit={(count) =>
            commit((draft) => {
              draft.team.limits.messageBurst = { ...messageBurstOf(draft.team.limits), count: count ?? 10 };
            })
          }
        />
        <InstantNumber
          label={t('settings.limits.messageBurstMinutes')}
          min={1}
          max={240}
          value={messageBurst.minutes}
          onCommit={(minutes) =>
            commit((draft) => {
              draft.team.limits.messageBurst = {
                ...messageBurstOf(draft.team.limits),
                minutes: minutes ?? 15,
              };
            })
          }
        />
      </div>
      <ToggleField
        label={t('settings.limits.tempWorkers')}
        checked={limits.tempWorkers.enabled}
        onChange={(enabled) =>
          commit((draft) => {
            draft.team.limits.tempWorkers.enabled = enabled;
          })
        }
      />
      <div className={shared.fieldRow}>
        <InstantNumber
          label={t('settings.edit.tempMax')}
          min={0}
          max={5}
          value={limits.tempWorkers.max}
          onCommit={(max) =>
            commit((draft) => {
              draft.team.limits.tempWorkers.max = max ?? 0;
            })
          }
        />
        <SelectField
          label={t('settings.team.role')}
          value={limits.tempWorkers.role}
          disabled={!roles.data}
          onChange={(event) =>
            commit((draft) => {
              draft.team.limits.tempWorkers.role = event.target.value;
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
        </SelectField>
      </div>
      {roles.isError ? <p role="alert">{errorMessage(roles.error)}</p> : null}
      {saving ? (
        <p role="status" className={shared.help}>
          {t('settings.edit.saving')}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className={shared.validation}>
          {isApiError(error) && error.code === 'config_conflict'
            ? t('settings.limits.conflict')
            : errorMessage(error)}
        </p>
      ) : null}
    </fieldset>
  );
}

/**
 * The team's limits: the AI switch, concurrency, the plan-usage pause, the warning limit of a
 * session's tokens and temp workers. Admins change them in place and each change is saved at
 * once; others see the values.
 */
export function LimitsSection({ config }: { config: ProjectConfig }) {
  const { key, can } = useProject();
  const roles = useRoles(key);
  const { limits } = config.team;
  return (
    <SettingsSection id="settings-limits" title={t('settings.sections.limits')}>
      {can.manageTeam ? (
        <LimitsControls config={config} />
      ) : (
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
            <dt>{t('settings.limits.warnAboveSessionTokens')}</dt>
            <dd>
              {limits.warnAboveSessionTokens === undefined
                ? t('settings.limits.noTokenWarning')
                : t('settings.limits.warnAboveSessionTokensValue', {
                    count: formatTokens(limits.warnAboveSessionTokens),
                  })}
            </dd>
          </div>
          <div>
            <dt>{t('settings.limits.autoCompactWindow')}</dt>
            <dd>
              {t('settings.limits.autoCompactWindowValue', {
                count: formatTokens(limits.autoCompactWindowTokens ?? DEFAULT_AUTO_COMPACT_WINDOW_TOKENS),
              })}
            </dd>
          </div>
          <div>
            <dt>{t('settings.limits.messageBurst')}</dt>
            <dd>{t('settings.limits.messageBurstValue', messageBurstOf(limits))}</dd>
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
      )}
    </SettingsSection>
  );
}
