import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { planUsage } from '../mocks/fixtures';
import { t } from '../i18n/t';
import { PlanUsageMeter } from './PlanUsageMeter';

describe('provider plan usage meter', () => {
  it('labels both providers and shows both windows including unknown usage', () => {
    render(
      <>
        <PlanUsageMeter provider="claude" usage={planUsage} />
        <PlanUsageMeter provider="codex" usage={null} />
      </>,
    );
    expect(screen.getByText(t('planUsage.providerLabel', { provider: t('providers.claude') }))).toBeTruthy();
    expect(screen.getByText(t('planUsage.providerLabel', { provider: t('providers.codex') }))).toBeTruthy();
    expect(screen.getAllByRole('meter')).toHaveLength(4);
    expect(screen.getAllByRole('meter')[2]!.hasAttribute('aria-valuenow')).toBe(false);
    expect(screen.getAllByRole('meter')[0]!.getAttribute('aria-valuetext')).toContain(
      t('planUsage.resets', { time: '' }).trim(),
    );
  });
});
