import { describe, expect, it } from 'vitest';
import { foldHeight } from './foldHeight';

// 20 px lines, 8 px between blocks: eight lines are 160 px, four are 80 px.
const LINE = 20;

describe('foldHeight', () => {
  it('ends at the bottom of the last block that fits whole, without a fade', () => {
    const blocks = [
      { top: 0, bottom: 40 }, // paragraph, two lines
      { top: 48, bottom: 68 }, // list items of one line each
      { top: 71, bottom: 91 },
      { top: 94, bottom: 134 },
      { top: 137, bottom: 177 }, // crosses the limit of 160
      { top: 180, bottom: 200 },
    ];
    expect(foldHeight(blocks, LINE)).toEqual({ height: 134, fade: false });
  });

  it('cuts inside the block that crosses the limit, on a line, when less than four lines would show', () => {
    const blocks = [
      { top: 0, bottom: 20 }, // one line
      { top: 28, bottom: 400 }, // one long paragraph
    ];
    expect(foldHeight(blocks, LINE)).toEqual({ height: 28 + 6 * LINE, fade: true });
  });

  it('cuts a first long paragraph at eight lines', () => {
    expect(foldHeight([{ top: 0, bottom: 500 }], LINE)).toEqual({ height: 160, fade: true });
  });

  it('keeps exactly four lines of whole blocks without a fade', () => {
    const blocks = [
      { top: 0, bottom: 80 },
      { top: 88, bottom: 300 },
    ];
    expect(foldHeight(blocks, LINE)).toEqual({ height: 80, fade: false });
  });
});
