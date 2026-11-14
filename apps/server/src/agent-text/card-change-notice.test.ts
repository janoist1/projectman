import { describe, expect, it } from 'vitest';
import { cardChangeNoticeText } from '.';
import type { CardChangeNoticeItem } from '.';

const item = (n: number): CardChangeNoticeItem => ({
  kind: 'description',
  actor: 'owner',
  eventId: `evt_${n}`,
});

describe('cardChangeNoticeText (PM-1512)', () => {
  it('names the card, the actor and the source event of each change', () => {
    const text = cardChangeNoticeText('AR-1', [
      { kind: 'message', actor: 'cr', eventId: 'evt_a' },
      { kind: 'acceptance', change: 'reopen', actor: 'owner', eventId: 'evt_b' },
    ]);
    expect(text).toContain('AR-1');
    expect(text).toContain('get_task');
    expect(text).toMatch(/by cr, event_id evt_a/);
    expect(text).toMatch(/\(reopen\), by owner, event_id evt_b/);
  });

  it('tells each kind of change differently', () => {
    const kinds = (['description', 'acceptance', 'message', 'answer'] as const).map((kind) =>
      cardChangeNoticeText('AR-1', [{ kind, actor: 'owner', eventId: 'evt_x' }]),
    );
    expect(new Set(kinds).size).toBe(4);
  });

  it('lists ten changes and counts the rest', () => {
    const lines = (n: number) =>
      cardChangeNoticeText(
        'AR-1',
        Array.from({ length: n }, (_, i) => item(i)),
      )
        .split('\n')
        .filter((line) => line.startsWith('- '));
    expect(lines(10)).toHaveLength(10);
    const over = lines(12);
    expect(over).toHaveLength(11);
    expect(over.filter((line) => line.includes('event_id'))).toHaveLength(10);
    expect(over[10]).toContain('2');
  });
});
