import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ProviderLoginStatus } from '@projectman/shared';
import { renderUi } from '../test/render';
import { t } from '../i18n/t';
import { ProviderBadge } from './ProviderBadge';

describe('ProviderBadge', () => {
  it.each(['not_logged_in', 'cli_missing'] as const)(
    'opens the reason by keyboard and touch: %s',
    (problem) => {
      const status: ProviderLoginStatus = {
        provider: 'codex',
        loggedIn: false,
        problem,
        method: 'none',
        checkedAt: new Date().toISOString(),
      };
      renderUi(<ProviderBadge provider="codex" status={status} />);
      const anchor = screen.getByRole('group');
      const tooltip = screen.getByRole('tooltip');
      expect(tooltip.textContent).toBe(
        t(
          problem === 'not_logged_in'
            ? 'providerSettings.badgeLoginHelp'
            : 'providerSettings.badgeNotReadyHelp',
          { provider: t('providers.codex') },
        ),
      );
      fireEvent.focus(anchor);
      expect(tooltip.getAttribute('data-open')).toBe('true');
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(tooltip.getAttribute('data-open')).toBe('false');
      fireEvent.click(anchor);
      expect(tooltip.getAttribute('data-open')).toBe('true');
    },
  );
  it.each([true, null, undefined])('keeps the neutral badge without a known failure: %s', (loggedIn) => {
    renderUi(
      <ProviderBadge
        status={
          loggedIn === undefined
            ? undefined
            : { provider: 'claude', loggedIn, method: 'none', checkedAt: new Date().toISOString() }
        }
      />,
    );
    expect(screen.getByText(t('providers.claude'))).toBeTruthy();
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
