import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { planUsage } from '../mocks/fixtures';
import { t } from '../i18n/t';
import { renderUi } from '../test/render';
import { PlanUsageBadge, PlanUsageMeter } from './PlanUsageMeter';

describe('phone plan usage badge', () => {
  it('shows the highest usage across providers and windows, linking to the team page', () => {
    renderUi(
      <PlanUsageBadge
        usages={[
          { ...planUsage, fiveHourPercent: 12, weeklyPercent: 40 },
          { ...planUsage, fiveHourPercent: 66, weeklyPercent: null },
          null,
        ]}
        to="/p/AC/team"
      />,
    );
    const link = screen.getByRole('link', { name: t('planUsage.badgeLabel', { percent: '66%' }) });
    expect(link.getAttribute('href')).toBe('/p/AC/team');
    expect(link.textContent).toBe('66%');
  });

  it('is absent while no usage is known', () => {
    const { container } = renderUi(<PlanUsageBadge usages={[null, undefined]} to="/p/AC/team" />);
    expect(container.querySelector('a')).toBeNull();
  });
});

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
