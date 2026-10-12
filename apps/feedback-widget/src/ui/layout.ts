import type { Point } from '../anchor';

export const CARD_WIDTH = 340;
const MARGIN = 12;
const GAP = 22;
const CARD_HEIGHT_GUESS = 380;
/** The launcher's height plus its offset: a card that has no room beside the mark sits above it. */
const LAUNCHER_CLEARANCE = 76;
/** Width of a pin's name label per character, its padding, and the room kept between label and card. */
const LABEL_CHAR_WIDTH = 6.6;
const LABEL_PADDING = 16;
const LABEL_SPACE = 12;
const MAX_CLEARANCE = 140;
/** How far above the tip a pin and its name label reach (head, label and badge). */
const PIN_REACH = 64;
/** The room kept between a revealed pin and the top of a bottom sheet. */
const SHEET_SPACE = 16;

export interface CardPlace {
  left: number;
  top: number;
  /** True when there is no room beside the mark and the card sits above the launcher instead. */
  aboveLauncher: boolean;
}

/**
 * How far to the side of the tip a card starts so that the open pin's name label (centred on the tip)
 * stays free: half the label's width plus a gap, never less than the plain gap.
 */
export function pinClearance(name: string): number {
  const half = (name.length * LABEL_CHAR_WIDTH + LABEL_PADDING) / 2;
  return Math.min(MAX_CLEARANCE, Math.max(GAP, Math.ceil(half) + LABEL_SPACE));
}

/**
 * Where a floating card goes: beside the mark (right of it, mirrored to the left near the right edge,
 * `clearance` away from the tip) and inside the viewport. All values are viewport pixels.
 */
export function cardPlace(
  tip: Point | null,
  viewport: { width: number; height: number },
  clearance: number = GAP,
): CardPlace {
  const aboveLauncher = (): CardPlace => ({
    left: Math.max(MARGIN, viewport.width - CARD_WIDTH - 20),
    top: Math.max(MARGIN, viewport.height - LAUNCHER_CLEARANCE - CARD_HEIGHT_GUESS),
    aboveLauncher: true,
  });
  if (!tip) return aboveLauncher();
  const right = tip.x + clearance;
  const left = right + CARD_WIDTH <= viewport.width - MARGIN ? right : tip.x - clearance - CARD_WIDTH;
  if (left < MARGIN) return aboveLauncher();
  const top = Math.min(
    Math.max(MARGIN, tip.y - 60),
    Math.max(MARGIN, viewport.height - CARD_HEIGHT_GUESS - MARGIN),
  );
  return { left, top, aboveLauncher: false };
}

/**
 * How far the page must scroll (positive: down) so that a pin whose tip is at `tipY` (viewport pixels)
 * shows above a bottom sheet that starts at `sheetTop`; zero when it already does.
 */
export function revealScroll(tipY: number, sheetTop: number): number {
  const lowest = sheetTop - SHEET_SPACE;
  if (tipY > lowest) return tipY - lowest;
  if (tipY < PIN_REACH + MARGIN) return tipY - (PIN_REACH + MARGIN);
  return 0;
}

export const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
