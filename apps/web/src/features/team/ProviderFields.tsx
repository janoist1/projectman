import { useState } from 'react';
import {
  AgentEffort,
  AgentProvider,
  effortForProvider,
  CheapSubagentModel,
  modelForProvider,
  PROVIDER_CHEAP_SUBAGENT_MODELS,
  PROVIDER_EFFORT_OPTIONS,
} from '@projectman/shared';
import { useProviders } from '../../api/queries';
import { SelectField, TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import {
  CLAUDE_FIXED_LABELS,
  CLAUDE_ALIAS_LABELS,
  CODEX_LABELS,
  PROVIDER_MODEL_LABELS,
} from './providerModels';
import styles from './memberForm.module.css';
import { ProviderWarning } from './ProviderWarning';

/** Shared AI settings for hiring and editing, with live subscription login warnings. */
export function ProviderFields({
  provider,
  model,
  effort,
  onProviderChange,
  onModelChange,
  onEffortChange,
  cheapSubagent,
  onCheapSubagentChange,
}: {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort | undefined;
  onProviderChange: (provider: AgentProvider, model: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: AgentEffort | undefined) => void;
  /** The cheap subagent's model (PM-179); the field shows when `onCheapSubagentChange` is given. */
  cheapSubagent?: CheapSubagentModel;
  onCheapSubagentChange?: (model: CheapSubagentModel | undefined) => void;
}) {
  const providers = useProviders();
  const cheapSubagentOptions = PROVIDER_CHEAP_SUBAGENT_MODELS[provider];
  const [custom, setCustom] = useState(!Object.hasOwn(PROVIDER_MODEL_LABELS[provider], model));
  const status = providers.data?.providers.find((entry) => entry.provider === provider);
  const modelOptions = (labels: typeof CODEX_LABELS) =>
    Object.entries(labels).map(([id, key]) => (
      <option key={id} value={id}>
        {t(key)}
      </option>
    ));
  return (
    <>
      <SelectField
        label={t('providerSettings.provider')}
        hint={t(`providerSettings.runsOn.${provider}`)}
        value={provider}
        onChange={(event) => {
          const next = AgentProvider.parse(event.target.value);
          const nextModel = modelForProvider(next);
          setCustom(!Object.hasOwn(PROVIDER_MODEL_LABELS[next], nextModel));
          onEffortChange(effortForProvider(next, effort));
          onProviderChange(next, nextModel);
        }}
      >
        {AgentProvider.options.map((entry) => (
          <option key={entry} value={entry}>
            {t(`providers.${entry}`)}
          </option>
        ))}
      </SelectField>
      <SelectField
        label={t('hire.model')}
        value={custom ? 'custom' : model}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === 'custom');
          onModelChange(value === 'custom' ? '' : value);
        }}
      >
        {provider === 'claude' ? (
          <>
            <optgroup label={t('providerSettings.fixedVersion')}>
              {modelOptions(CLAUDE_FIXED_LABELS)}
            </optgroup>
            <optgroup label={t('providerSettings.alwaysLatest')}>
              {modelOptions(CLAUDE_ALIAS_LABELS)}
            </optgroup>
          </>
        ) : (
          modelOptions(PROVIDER_MODEL_LABELS[provider])
        )}
        <option value="custom">{t('providerSettings.customModel')}</option>
      </SelectField>
      {custom ? (
        <TextField
          label={t('providerSettings.modelId')}
          value={model}
          required
          onChange={(event) => onModelChange(event.target.value)}
          spellCheck={false}
          autoCapitalize="off"
        />
      ) : null}
      <SelectField
        label={t('providerSettings.effort')}
        hint={t('providerSettings.effortHint')}
        value={effort ?? ''}
        onChange={(event) =>
          onEffortChange(event.target.value ? AgentEffort.parse(event.target.value) : undefined)
        }
      >
        {provider === 'claude' ? <option value="">{t('providerSettings.defaultEffort')}</option> : null}
        {PROVIDER_EFFORT_OPTIONS[provider].map((entry) => (
          <option key={entry} value={entry}>
            {t(`providerSettings.efforts.${entry}`)}
          </option>
        ))}
      </SelectField>
      {onCheapSubagentChange ? (
        <SelectField
          label={t('providerSettings.cheapSubagent')}
          hint={t(
            cheapSubagentOptions.length > 0
              ? 'providerSettings.cheapSubagentHint'
              : 'providerSettings.cheapSubagentUnavailable',
            { provider: t(`providers.${provider}`) },
          )}
          // Kept as it is for a provider without one (Codex): it has no effect there.
          disabled={cheapSubagentOptions.length === 0}
          value={cheapSubagentOptions.length > 0 ? (cheapSubagent ?? '') : ''}
          onChange={(event) =>
            onCheapSubagentChange(
              event.target.value ? CheapSubagentModel.parse(event.target.value) : undefined,
            )
          }
        >
          <option value="">{t('providerSettings.cheapSubagentOff')}</option>
          {cheapSubagentOptions.map((entry) => (
            <option key={entry} value={entry}>
              {t(`providerSettings.cheapSubagentModels.${entry}`)}
            </option>
          ))}
        </SelectField>
      ) : null}
      {provider === 'codex' && model.trim() === 'gpt-6-astra' ? (
        <p className={styles.warning} role="alert">
          {t('providerSettings.astraWarning')}
        </p>
      ) : null}
      <ProviderWarning provider={provider} status={status} inDialog />
      {status?.loggedIn === null || providers.isError ? (
        <p className={styles.warning} role="status">
          {t('providerSettings.statusUnknown')}
        </p>
      ) : null}
    </>
  );
}
