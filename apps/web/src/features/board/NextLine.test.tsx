import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { TaskNext } from '../../lib/taskNext';
import { NextLine } from './NextLine';

const next: TaskNext = {
  head: 'Kata',
  you: false,
  waiting: 'dönt',
  long: 'Egy nyitott tétel vár rá: döntés.',
  todo: 'Semmit: Kata intézi.',
  tone: 'neutral',
  who: [],
  noWho: null,
  noWhoKind: null,
  toStageId: null,
  line: 'Kata · dönt',
  title: 'Ki: Kata · Mire vár: dönt · Teendő: Semmit: Kata intézi.',
};

describe('NextLine (PM-461)', () => {
  it('has the row as its accessible name and its title', () => {
    const { container } = render(<NextLine next={next} />);
    expect(screen.getByText(next.title).className).toContain('visually-hidden');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(next.title);
  });

  it('puts the prefix of a stale map card into the hidden text and the title too', () => {
    const { container } = render(<NextLine next={next} prefix="Régóta áll" />);
    const full = `Régóta áll · ${next.title}`;
    expect(screen.getByText(full).className).toContain('visually-hidden');
    expect(container.querySelector('[title]')?.getAttribute('title')).toBe(full);
  });
});
