import { describe, expect, it } from 'vitest';
import { BoardColumn, BoardColumnColor, defaultBoardColumnColor } from './pipeline';
import { BoardColumnView } from '../api/dto';

describe('board column colours', () => {
  it('keeps legacy columns valid without persisting a default', () => {
    expect(BoardColumn.parse({ id: 'ready', name: 'Ready' })).toEqual({ id: 'ready', name: 'Ready' });
  });

  it('accepts the palette in config and board views and rejects arbitrary colours', () => {
    for (const color of BoardColumnColor.options) {
      expect(BoardColumnView.parse({ id: 'ready', name: 'Ready', color, stageIds: [] }).color).toBe(color);
    }
    expect(BoardColumn.safeParse({ id: 'ready', name: 'Ready', color: '#123456' }).success).toBe(false);
  });

  it('cycles deterministic defaults by position', () => {
    expect(Array.from({ length: 9 }, (_, index) => defaultBoardColumnColor(index))).toEqual(
      BoardColumnColor.options,
    );
    expect(defaultBoardColumnColor(9)).toBe('gray');
    expect(defaultBoardColumnColor(10)).toBe('blue');
  });
});
