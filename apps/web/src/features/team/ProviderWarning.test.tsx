import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderUi } from '../../test/render';
import { t } from '../../i18n/t';
import { ProviderWarning } from './ProviderWarning';

describe('ProviderWarning', () => {
  it.each([undefined, 'not_logged_in'] as const)('gives login steps for a missing login: %s', (problem) => {
    renderUi(
      <ProviderWarning
        provider="claude"
        status={{
          provider: 'claude',
          loggedIn: false,
          problem,
          method: 'none',
          checkedAt: new Date().toISOString(),
        }}
        inDialog
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      t('providerSettings.loginWarning', { provider: t('providers.claude') }),
    );
    expect(screen.getByText('claude auth login').tagName).toBe('CODE');
  });
  it('uses no alert on the profile and gives no login command for incomplete providers', () => {
    renderUi(
      <ProviderWarning
        provider="nanogpt"
        status={{
          provider: 'nanogpt',
          loggedIn: false,
          problem: 'no_key',
          method: 'none',
          checkedAt: new Date().toISOString(),
        }}
      />,
    );
    expect(screen.getByText(t('providerSettings.nanogptNoKey'))).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(document.querySelector('code')).toBeNull();
  });
});
