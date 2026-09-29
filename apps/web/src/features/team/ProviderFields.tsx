import { useState } from 'react';
import { AgentEffort, AgentProvider, modelForProvider } from '@projectman/shared';
import { useProviders } from '../../api/queries';
import { SelectField, TextField } from '../../components/Field';
import { t } from '../../i18n/t';
import type { PlainMessageKey } from '../../i18n/t';
import styles from './HireDialog.module.css';

const CLAUDE_MODELS = ['opus', 'sonnet', 'haiku'];
const CODEX_LABELS: Record<string, PlainMessageKey> = {
  'gpt-6.1-sol': 'providerSettings.models.sol',
  'gpt-6-luna': 'providerSettings.models.luna',
  'gpt-6-astra': 'providerSettings.models.astra',
};
const CODEX_MODELS = Object.keys(CODEX_LABELS);

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
  effort: AgentEffort;
  onProviderChange: (provider: AgentProvider, model: string) => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: AgentEffort) => void;
}) {
  const providers = useProviders();
  const [custom, setCustom] = useState(provider === 'codex' && !CODEX_MODELS.includes(model));
  const status = providers.data?.providers.find((entry) => entry.provider === provider);
  const models = provider === 'codex' ? CODEX_MODELS : [...new Set([model, ...CLAUDE_MODELS])];
  return (
    <>
      <SelectField
        label={t('providerSettings.provider')}
        value={provider}
        onChange={(event) => {
          const next = AgentProvider.parse(event.target.value);
          const nextModel = modelForProvider(next, model);
          setCustom(next === 'codex' && !CODEX_MODELS.includes(nextModel));
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
        value={custom && provider === 'codex' ? 'custom' : model}
        onChange={(event) => {
          const value = event.target.value;
          setCustom(value === 'custom');
          onModelChange(value === 'custom' ? '' : value);
        }}
      >
        {models.map((entry) => (
          <option key={entry} value={entry}>
            {provider === 'codex' ? t(CODEX_LABELS[entry]!) : entry}
          </option>
        ))}
        {provider === 'codex' ? <option value="custom">{t('providerSettings.customModel')}</option> : null}
      </SelectField>
      {provider === 'codex' && custom ? (
        <TextField
          label={t('providerSettings.modelId')}
          value={model}
          required
          onChange={(event) => onModelChange(event.target.value)}
          spellCheck={false}
          autoCapitalize="off"
        />
      ) : null}
      {provider === 'codex' ? (
        <SelectField
          label={t('providerSettings.effort')}
          hint={t('providerSettings.effortHint')}
          value={effort}
          onChange={(event) => onEffortChange(AgentEffort.parse(event.target.value))}
        >
          {AgentEffort.options.map((entry) => (
            <option key={entry} value={entry}>
              {t(`providerSettings.efforts.${entry}`)}
            </option>
          ))}
        </SelectField>
      ) : null}
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
