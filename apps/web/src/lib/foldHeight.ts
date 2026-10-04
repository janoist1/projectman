/** Where a block (paragraph, list item, code block) sits inside the folded text, in px from its top. */
export interface BlockBox {
  top: number;
  bottom: number;
}

export interface FoldHeight {
  /** The height of the folded text, in px. */
  height: number;
  /** True when the cut falls inside a block: the last line then fades out. */
  fade: boolean;
}

/**
 * How tall a long text is while folded: at most `maxLines` lines, but ending at the bottom of a
 * block, the last one that fits whole, so that the cut never falls through the middle of a list
 * item. When that would leave fewer than `minLines` lines (a long paragraph fills the space), the
 * cut falls inside the block that crosses the limit, on one of its line boundaries.
 */
export function foldHeight(
  blocks: readonly BlockBox[],
  lineHeight: number,
  maxLines = 8,
  minLines = 4,
): FoldHeight {
  const limit = maxLines * lineHeight;
  // Half a pixel of slack for the rounding of the measured boxes.
  const fits = (block: BlockBox) => block.bottom <= limit + 0.5;
  let whole = 0;
  for (const block of blocks) {
    if (!fits(block)) break;
    whole = Math.max(whole, block.bottom);
  }
  if (whole >= minLines * lineHeight) return { height: whole, fade: false };
  const crossing = blocks.find((block) => !fits(block) && block.top < limit);
  const top = crossing?.top ?? 0;
  const lines = Math.max(1, Math.floor((limit - top) / lineHeight));
  return { height: top + lines * lineHeight, fade: true };
}
