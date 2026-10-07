import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const usage = {
  ...planUsage,
  fiveHourPercent: 27,
  weeklyPercent: 60,
  fiveHourResetsAt: '2030-01-01T10:00:00.000Z',
  weeklyResetsAt: '2030-01-01T11:00:00.000Z',
};

describe('provider plan usage meter, full', () => {
  it('names the provider and shows both windows, without the old "Keret ·" prefix', () => {
    render(
      <>
        <PlanUsageMeter provider="claude" usage={usage} />
        <PlanUsageMeter provider="codex" usage={null} />
      </>,
    );
    expect(screen.getByText(t('providers.claude'))).toBeTruthy();
    expect(screen.getByText(t('providers.codex'))).toBeTruthy();
    expect(screen.queryByText(/Keret ·/)).toBeNull();
    const meters = screen.getAllByRole('meter');
    expect(meters).toHaveLength(4);
    expect(meters.map((meter) => meter.getAttribute('aria-label'))).toEqual([
      t('planUsage.fiveHour'),
      t('planUsage.weekly'),
      t('planUsage.fiveHour'),
      t('planUsage.weekly'),
    ]);
    expect(meters[0]!.getAttribute('aria-valuenow')).toBe('27');
    expect(meters[2]!.hasAttribute('aria-valuenow')).toBe(false);
    expect(meters[2]!.getAttribute('aria-valuetext')).toBe(t('planUsage.unknown'));
    expect(meters[0]!.getAttribute('aria-valuetext')).toMatch(/^27%, Visszaáll: /);
    expect(screen.getAllByText(t('planUsage.unknown'))).toHaveLength(2);
  });

  it('marks the level by the bar and by the value', () => {
    const { container } = render(
      <PlanUsageMeter usage={{ ...usage, fiveHourPercent: 85, weeklyPercent: 97 }} pauseAbove={80} />,
    );
    const fills = [...container.querySelectorAll('[role="meter"] > span')];
    expect(fills[0]!.className).toMatch(/fill_high/);
    expect(fills[1]!.className).toMatch(/fill_critical/);
    expect(screen.getByText('85%').className).toMatch(/value_high/);
    expect(screen.getByText('97%').className).toMatch(/value_critical/);
  });
});

describe('provider plan usage meter, peak', () => {
  it('does not claim a threshold pause for measured NanoGPT weekly usage', () => {
    render(
      <PlanUsageMeter
        provider="nanogpt"
        variant="peak"
        usage={{ ...usage, fiveHourPercent: null, weeklyPercent: 100 }}
        pauseAbove={80}
      />,
    );
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).not.toContain(
      t('planUsage.paused', { limit: 80 }),
    );
  });
  function peakText(five: number | null, week: number | null) {
    const { unmount } = render(
      <PlanUsageMeter
        variant="peak"
        usage={{ ...usage, fiveHourPercent: five, weeklyPercent: week }}
        pauseAbove={80}
      />,
    );
    const meter = screen.getByRole('meter');
    const text = { shown: meter.parentElement!.textContent, valuetext: meter.getAttribute('aria-valuetext') };
    expect(meter.getAttribute('aria-label')).toBe(t('providers.claude'));
    unmount();
    return text;
  }

  it('shows the higher of the two windows', () => {
    expect(peakText(27, 60).shown).toBe('Claude60%');
    expect(peakText(71, 60).shown).toBe('Claude71%');
  });

  it('shows the known window when the other is unknown, and n. a. when neither is known', () => {
    expect(peakText(null, 33).shown).toBe('Claude33%');
    expect(peakText(null, null).shown).toBe(`Claude${t('planUsage.unknown')}`);
  });

  it('reads both windows and the resets out through aria-valuetext', () => {
    const text = peakText(27, 60).valuetext!;
    expect(text.startsWith('60% · Claude-előfizetés: 5 órás keret 27% (visszaáll: ')).toBe(true);
    expect(text).toContain('heti keret 60% (visszaáll: ');
  });

  it('takes its level from the peak', () => {
    const { container } = render(<PlanUsageMeter variant="peak" usage={{ ...usage, fiveHourPercent: 90 }} />);
    expect(container.querySelector('[role="meter"] > span')!.className).toMatch(/fill_high/);
  });
});

describe('plan usage tooltip', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is described by the group, has no title and opens on focus', () => {
    render(<PlanUsageMeter usage={usage} />);
    const group = screen.getByRole('group', { name: t('providers.claude') });
    expect(group.hasAttribute('title')).toBe(false);
    const tip = screen.getByRole('tooltip', { hidden: true });
    expect(group.getAttribute('aria-describedby')).toBe(tip.id);
    expect(tip.getAttribute('data-open')).toBe('false');
    expect(tip.textContent).toMatch(
      /^Claude-előfizetés: 5 órás keret 27% \(visszaáll: .+\), heti keret 60% \(visszaáll: .+\)$/,
    );
    act(() => group.focus());
    expect(tip.getAttribute('data-open')).toBe('true');
    fireEvent.keyDown(group, { key: 'Escape' });
    expect(tip.getAttribute('data-open')).toBe('false');
  });

  it('closes on blur', () => {
    render(<PlanUsageMeter usage={usage} />);
    const group = screen.getByRole('group');
    act(() => group.focus());
    expect(screen.getByRole('tooltip', { hidden: true }).getAttribute('data-open')).toBe('true');
    act(() => group.blur());
    expect(screen.getByRole('tooltip', { hidden: true }).getAttribute('data-open')).toBe('false');
  });

  it('opens on hover after a delay and stays open while the pointer is on it', () => {
    render(<PlanUsageMeter usage={usage} />);
    const group = screen.getByRole('group');
    const tip = screen.getByRole('tooltip', { hidden: true });
    fireEvent.pointerEnter(group, { pointerType: 'mouse' });
    act(() => void vi.advanceTimersByTime(200));
    expect(tip.getAttribute('data-open')).toBe('false');
    act(() => void vi.advanceTimersByTime(150));
    expect(tip.getAttribute('data-open')).toBe('true');
    // The pointer crosses to the tooltip: the leave is followed by an enter before the delay ends.
    fireEvent.pointerLeave(group, { pointerType: 'mouse' });
    act(() => void vi.advanceTimersByTime(50));
    fireEvent.pointerEnter(group, { pointerType: 'mouse' });
    act(() => void vi.advanceTimersByTime(500));
    expect(tip.getAttribute('data-open')).toBe('true');
    fireEvent.pointerLeave(group, { pointerType: 'mouse' });
    act(() => void vi.advanceTimersByTime(200));
    expect(tip.getAttribute('data-open')).toBe('false');
  });

  it('shows one tooltip at a time', () => {
    render(
      <>
        <PlanUsageMeter provider="claude" usage={usage} />
        <PlanUsageMeter provider="codex" usage={usage} />
      </>,
    );
    const [claude, codex] = screen.getAllByRole('group');
    const [claudeTip, codexTip] = screen.getAllByRole('tooltip', { hidden: true });
    act(() => claude!.focus());
    act(() => codex!.focus());
    expect(claudeTip!.getAttribute('data-open')).toBe('false');
    expect(codexTip!.getAttribute('data-open')).toBe('true');
  });

  it('adds the pause sentence above the limit and says n. a. without the resets for an unknown window', () => {
    render(
      <>
        <PlanUsageMeter provider="claude" usage={{ ...usage, fiveHourPercent: 85 }} pauseAbove={80} />
        <PlanUsageMeter provider="codex" usage={{ ...usage, fiveHourPercent: null }} pauseAbove={80} />
      </>,
    );
    const [claudeTip, codexTip] = screen.getAllByRole('tooltip', { hidden: true });
    expect(claudeTip!.textContent).toMatch(/ · A keret 80% fölött van: új AI-munka nem indul\.$/);
    expect(codexTip!.textContent).toMatch(
      /^Codex-előfizetés: 5 órás keret n\. a\., heti keret 60% \(visszaáll/,
    );
    expect(codexTip!.textContent).not.toMatch(/A keret 80%/);
  });
});
