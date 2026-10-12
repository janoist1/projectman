import { describe, expect, it } from 'vitest';
import { MAX_SHOT_BYTES, base64Bytes, encodeWithinLimit, shotScale } from './screenshot';

/** A canvas stand-in that returns a base64 payload of a given decoded size per quality. */
const canvasOf = (sizes: Record<number, number>) => ({
  asked: [] as number[],
  toDataURL(_type: string, quality: number) {
    this.asked.push(quality);
    const bytes = sizes[quality] ?? 0;
    return `data:image/jpeg;base64,${'A'.repeat(Math.ceil((bytes * 4) / 3))}`;
  },
});

describe('encodeWithinLimit', () => {
  it('uses quality 0.8 when it fits', () => {
    const canvas = canvasOf({ 0.8: 500_000 });
    expect(encodeWithinLimit(canvas)).toMatchObject({ mediaType: 'image/jpeg' });
    expect(canvas.asked).toEqual([0.8]);
  });

  it('retries at 0.6 when the first picture is over 2 MB', () => {
    const canvas = canvasOf({ 0.8: MAX_SHOT_BYTES + 100_000, 0.6: 900_000 });
    expect(encodeWithinLimit(canvas)).not.toBeNull();
    expect(canvas.asked).toEqual([0.8, 0.6]);
  });

  it('gives up (no image) when 0.6 is still over 2 MB', () => {
    const canvas = canvasOf({ 0.8: MAX_SHOT_BYTES + 1000, 0.6: MAX_SHOT_BYTES + 1000 });
    expect(encodeWithinLimit(canvas)).toBeNull();
  });

  it('treats an empty encoding (a canvas that could not encode) as no image', () => {
    expect(encodeWithinLimit({ toDataURL: () => 'data:,' })).toBeNull();
  });
});

describe('base64Bytes and shotScale', () => {
  it('counts the decoded bytes, padding included', () => {
    expect(base64Bytes('AAAA')).toBe(3);
    expect(base64Bytes('AAA=')).toBe(2);
    expect(base64Bytes('AA==')).toBe(1);
  });

  it('keeps the image at most 1600 px wide', () => {
    expect(shotScale(800)).toBe(1);
    expect(shotScale(3200)).toBe(0.5);
  });
});
