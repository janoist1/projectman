import { describe, expect, it } from 'vitest';
import { MARKER_COLORS, colorIndexOf, monogramOf } from './palette';
import { statusOf } from './status';
import { person } from './test/helpers';

describe('marker colours', () => {
  it('maps a person colour to the palette and falls back to the first', () => {
    expect(colorIndexOf(person({ color: 3 }))).toBe(3);
    expect(colorIndexOf(person({ color: null }))).toBe(0);
    expect(colorIndexOf(person({ color: 8 }))).toBe(0);
    expect(colorIndexOf(null)).toBe(0);
    expect(MARKER_COLORS).toHaveLength(8);
  });

  it('builds a monogram from a human name and from an AI handle', () => {
    expect(monogramOf(person({ name: 'Kovács Anna' }))).toBe('KA');
    expect(monogramOf(person({ name: 'Anna' }))).toBe('AN');
    expect(monogramOf(person({ kind: 'ai', handle: 'pm', name: 'Projektmenedzser' }))).toBe('PM');
  });
});

describe('statusOf', () => {
  it('picks the label state of a mark', () => {
    const base = { status: 'new', outcome: null, working: false } as const;
    expect(statusOf(base)).toBe('new');
    expect(statusOf({ ...base, working: true })).toBe('working');
    expect(statusOf({ ...base, status: 'waiting_owner' })).toBe('waiting_owner');
    expect(statusOf({ ...base, status: 'handled', outcome: 'answered' })).toBe('answered');
    expect(statusOf({ ...base, status: 'handled', outcome: 'card_created' })).toBe('card');
    expect(statusOf({ ...base, status: 'closed', working: true })).toBe('closed');
  });
});
