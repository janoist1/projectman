import { describe, expect, it } from 'vitest';
import { CARD_WIDTH, cardPlace, clamp01 } from './layout';

const VIEWPORT = { width: 1200, height: 800 };

describe('cardPlace', () => {
  it('puts the card right of the mark, inside the viewport', () => {
    const place = cardPlace({ x: 300, y: 300 }, VIEWPORT);
    expect(place.aboveLauncher).toBe(false);
    expect(place.left).toBeGreaterThan(300);
    expect(place.left + CARD_WIDTH).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('mirrors the card to the left near the right edge', () => {
    const place = cardPlace({ x: 1150, y: 300 }, VIEWPORT);
    expect(place.left + CARD_WIDTH).toBeLessThan(1150);
    expect(place.aboveLauncher).toBe(false);
  });

  it('keeps the card inside the viewport near the top and bottom', () => {
    expect(cardPlace({ x: 300, y: 0 }, VIEWPORT).top).toBeGreaterThanOrEqual(12);
    const low = cardPlace({ x: 300, y: 790 }, VIEWPORT);
    expect(low.top).toBeLessThan(VIEWPORT.height - 100);
  });

  it('goes above the launcher when there is no mark place or no room on either side', () => {
    expect(cardPlace(null, VIEWPORT).aboveLauncher).toBe(true);
    expect(cardPlace({ x: 200, y: 300 }, { width: 400, height: 800 }).aboveLauncher).toBe(true);
  });
});

describe('clamp01', () => {
  it('limits a number to 0..1', () => {
    expect([clamp01(-1), clamp01(0.4), clamp01(3)]).toEqual([0, 0.4, 1]);
  });
});
