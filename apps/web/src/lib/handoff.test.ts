import { describe, expect, it } from 'vitest';
import { noteExcerpt } from './handoff';

describe('the excerpt of a handoff note', () => {
  it('is the first line of a plain note', () => {
    expect(noteExcerpt('Restore drill is half done.\nNext: the cart.')).toBe('Restore drill is half done.');
  });

  it('drops the Markdown marks and joins a heading with the line under it', () => {
    expect(noteExcerpt('## Állapot\n\nA kosár kész, a fizetési oldal félkész.')).toBe(
      'Állapot · A kosár kész, a fizetési oldal félkész.',
    );
    expect(noteExcerpt('# **Állapot**\n- `cart.ts` kész')).toBe('Állapot · cart.ts kész');
  });

  it('drops list and quote markers and skips empty lines', () => {
    expect(noteExcerpt('\n\n- **Kész:** a kosár')).toBe('Kész: a kosár');
    expect(noteExcerpt('> idézet')).toBe('idézet');
    expect(noteExcerpt('1. első lépés')).toBe('első lépés');
  });

  it('is empty for an empty note, and a lone heading stays as it is', () => {
    expect(noteExcerpt('  \n ')).toBe('');
    expect(noteExcerpt('## Állapot')).toBe('Állapot');
  });

  it('cuts a long line at about 120 characters with an ellipsis', () => {
    const cut = noteExcerpt(`## Cím\n${'a'.repeat(300)}`);
    expect(cut.length).toBe(120);
    expect(cut.endsWith('…')).toBe(true);
  });
});
