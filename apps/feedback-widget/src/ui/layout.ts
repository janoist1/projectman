import type { Point } from '../anchor';

export const CARD_WIDTH = 340;
const MARGIN = 12;
const GAP = 22;
const CARD_HEIGHT_GUESS = 380;
/** The launcher's height plus its offset: a card that has no room beside the mark sits above it. */
const LAUNCHER_CLEARANCE = 76;

export interface CardPlace {
  left: number;
  top: number;
  /** True when there is no room beside the mark and the card sits above the launcher instead. */
  aboveLauncher: boolean;
}

/**
 * Where a floating card goes: beside the mark (right of it, mirrored to the left near the right edge)
 * and inside the viewport. All values are viewport pixels.
 */
export function cardPlace(tip: Point | null, viewport: { width: number; height: number }): CardPlace {
  const aboveLauncher = (): CardPlace => ({
    left: Math.max(MARGIN, viewport.width - CARD_WIDTH - 20),
    top: Math.max(MARGIN, viewport.height - LAUNCHER_CLEARANCE - CARD_HEIGHT_GUESS),
    aboveLauncher: true,
  });
  if (!tip) return aboveLauncher();
  const right = tip.x + GAP;
  const left = right + CARD_WIDTH <= viewport.width - MARGIN ? right : tip.x - GAP - CARD_WIDTH;
  if (left < MARGIN) return aboveLauncher();
  const top = Math.min(
    Math.max(MARGIN, tip.y - 60),
    Math.max(MARGIN, viewport.height - CARD_HEIGHT_GUESS - MARGIN),
  );
  return { left, top, aboveLauncher: false };
}

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
