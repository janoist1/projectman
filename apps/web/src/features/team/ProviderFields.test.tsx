import { useState } from 'react';
import type { AgentEffort, AgentProvider } from '@projectman/shared';
import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { ProviderFields } from './ProviderFields';
import { CLAUDE_FIXED_LABELS, CLAUDE_ALIAS_LABELS, GEMINI_LABELS } from './providerModels';

function Fields({ initialModel = 'opus' }: { initialModel?: string }) {
  const [provider, setProvider] = useState<AgentProvider>('claude');
  const [model, setModel] = useState(initialModel);
  const [effort, setEffort] = useState<AgentEffort>();
  return (
    <ProviderFields
      provider={provider}
      model={model}
      effort={effort}
      onProviderChange={(next, nextModel) => {
        setProvider(next);
        setModel(nextModel);
      }}
      onModelChange={setModel}
      onEffortChange={setEffort}
    />
  );
}

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

describe('ProviderFields', () => {
  it('shows provider runtime hints and clamps NanoGPT effort', () => {
    mockProject().render(<Fields />);
    expect(screen.getByText(t('providerSettings.runsOn.claude'))).toBeTruthy();
    fireEvent.change(screen.getByLabelText(t('providerSettings.effort')), { target: { value: 'max' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.provider')), { target: { value: 'nanogpt' } });
    expect(screen.getByText(t('providerSettings.runsOn.nanogpt'))).toBeTruthy();
    expect((screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement).value).toBe('xhigh');
  });
  it('offers Gemini families and resets the model and unsupported effort on provider change', () => {
    mockProject().render(<Fields />);
    fireEvent.change(screen.getByLabelText(t('providerSettings.effort')), { target: { value: 'max' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.provider')), { target: { value: 'gemini' } });
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('gemini-3.8-flash');
    expect((screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement).value).toBe('high');
    for (const [id, key] of Object.entries(GEMINI_LABELS)) {
      expect((screen.getByRole('option', { name: t(key) }) as HTMLOptionElement).value).toBe(id);
    }
    expect(screen.queryByRole('option', { name: t('providerSettings.models.sol') })).toBeNull();
    expect(screen.getByText(t('providerSettings.runsOn.gemini'))).toBeTruthy();
  });
  it('groups fixed Claude versions and latest aliases with translated labels and custom ids', () => {
    mockProject().render(<Fields />);
    for (const [group, labels] of [
      ['providerSettings.fixedVersion', CLAUDE_FIXED_LABELS],
      ['providerSettings.alwaysLatest', CLAUDE_ALIAS_LABELS],
    ] as const) {
      const options = within(screen.getByRole('group', { name: t(group) }));
      for (const [id, key] of Object.entries(labels)) {
        expect((options.getByRole('option', { name: t(key) }) as HTMLOptionElement).value).toBe(id);
      }
    }
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('opus');
    fireEvent.change(screen.getByLabelText(t('hire.model')), { target: { value: 'custom' } });
    fireEvent.change(screen.getByLabelText(t('providerSettings.modelId')), {
      target: { value: 'claude-fictional-model' },
    });
    expect((screen.getByLabelText(t('providerSettings.modelId')) as HTMLInputElement).value).toBe(
      'claude-fictional-model',
    );
  });

  it('shows an existing unknown Claude id as a custom model', () => {
    mockProject().render(<Fields initialModel="claude-fictional-model" />);
    expect((screen.getByLabelText(t('hire.model')) as HTMLSelectElement).value).toBe('custom');
    expect((screen.getByLabelText(t('providerSettings.modelId')) as HTMLInputElement).value).toBe(
      'claude-fictional-model',
    );
  });

  it('offers Claude default and max and clamps unset and max when switching to Codex', () => {
    mockProject().render(<Fields />);
    const effort = screen.getByLabelText(t('providerSettings.effort')) as HTMLSelectElement;
    const provider = screen.getByLabelText(t('providerSettings.provider'));
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([
      '',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(effort.options[0]?.text).toBe(t('providerSettings.defaultEffort'));
    expect(effort.value).toBe('');
    fireEvent.change(provider, { target: { value: 'codex' } });
    expect(effort.value).toBe('medium');
    expect(Array.from(effort.options).map((option) => option.value)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    fireEvent.change(provider, { target: { value: 'claude' } });
    expect(effort.value).toBe('medium');
    fireEvent.change(effort, { target: { value: 'max' } });
    fireEvent.change(provider, { target: { value: 'codex' } });
    expect(effort.value).toBe('xhigh');
    fireEvent.change(provider, { target: { value: 'claude' } });
    expect(effort.value).toBe('xhigh');
  });
});
