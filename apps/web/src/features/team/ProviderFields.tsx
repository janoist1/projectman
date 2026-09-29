import { useState } from 'react';
import { AgentEffort, AgentProvider, modelForProvider, PROVIDER_EFFORT_OPTIONS } from '@projectman/shared';
import { useProviders } from '../../api/queries';
import { SelectField, TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import {
  CLAUDE_FIXED_LABELS,
  CLAUDE_ALIAS_LABELS,
  CODEX_LABELS,
  PROVIDER_MODEL_LABELS,
} from './providerModels';
import styles from './HireDialog.module.css';

/** Shared AI settings for hiring and editing, with live subscription login warnings. */
export function ProviderFields({
  provider,
  model,
  effort,
  onProviderChange,
  onModelChange,
  onEffortChange,
}: {
  provider: AgentProvider;
  model: string;
  effort: AgentEffort | undefined;
  onProviderChange: (provider: AgentProvider, model: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: AgentEffort | undefined) => void;
}) {
  const providers = useProviders();
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
        value={provider}
        onChange={(event) => {
          const next = AgentProvider.parse(event.target.value);
          const nextModel = modelForProvider(next, model);
          setCustom(!Object.hasOwn(PROVIDER_MODEL_LABELS[next], nextModel));
          onEffortChange(next === 'codex' ? (effort === 'max' ? 'xhigh' : (effort ?? 'medium')) : effort);
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
          modelOptions(CODEX_LABELS)
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
      {provider === 'codex' && model.trim() === 'gpt-6-astra' ? (
        <p className={styles.warning} role="alert">
          {t('providerSettings.astraWarning')}
        </p>
      ) : null}
      {status?.loggedIn === false ? (
        <p className={styles.warning} role="alert">
          {t('providerSettings.loginWarning', { provider: t(`providers.${provider}`) })}{' '}
          <code>{t(`providerSettings.loginCommands.${provider}`)}</code>
        </p>
      ) : null}
      {status?.loggedIn === null || providers.isError ? (
        <p className={styles.warning} role="status">
          {t('providerSettings.statusUnknown')}
        </p>
      ) : null}
    </>
  );
}
