import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/t';
import { MiniMeter, meterLevel } from './MiniMeter';

describe('meterLevel', () => {
  it.each([
    [null, 'ok'],
    [0, 'ok'],
    [79, 'ok'],
    [80, 'high'],
    [94, 'high'],
    [95, 'critical'],
  ] as const)('%s with a pause limit of 80 is %s', (value, level) => {
    expect(meterLevel(value, 80)).toBe(level);
  });
});

describe('MiniMeter', () => {
  it('shows the label and the value on one row with a meter bar', () => {
    render(<MiniMeter label="Hét" value={60} pauseAbove={80} />);
    expect(screen.getByText('Hét')).toBeTruthy();
    expect(screen.getByText('60%')).toBeTruthy();
    const bar = screen.getByRole('meter', { name: 'Hét' });
    expect(bar.getAttribute('aria-valuenow')).toBe('60');
    expect(bar.getAttribute('aria-valuetext')).toBe('60%');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('60%');
  });

  it('has an empty bar and a neutral value when unknown', () => {
    render(<MiniMeter label="Hét" value={null} pauseAbove={80} />);
    const value = screen.getByText(t('planUsage.unknown'));
    expect(value.className).toMatch(/value/);
    expect(screen.getByRole('meter').hasAttribute('aria-valuenow')).toBe(false);
    expect((screen.getByRole('meter').firstElementChild as HTMLElement).style.width).toBe('0%');
  });

  it('can be hidden from assistive technology, with or without the bar', () => {
    const { container } = render(
      <>
        <MiniMeter label="CPU" value={50} pauseAbove={80} decorative />
        <MiniMeter label="AI" value={3} pauseAbove={80} decorative bar={false} />
      </>,
    );
    expect(screen.queryByRole('meter')).toBeNull();
    const meters = container.children;
    expect(meters[0]!.getAttribute('aria-hidden')).toBe('true');
    expect(meters[1]!.getAttribute('aria-hidden')).toBe('true');
    expect(meters[1]!.querySelector('[class*="track"]')).toBeNull();
  });
});
