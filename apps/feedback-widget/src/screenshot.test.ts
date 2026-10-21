import { describe, expect, it } from 'vitest';
import {
  BLANK_PIXEL,
  MAX_SHOT_BYTES,
  base64Bytes,
  classifyShotError,
  createImageFetcher,
  encodeWithinLimit,
  offscreenImageUrls,
  resourceUrl,
  shotFailureLine,
  shotScale,
} from './screenshot';
import type { ShotFailure } from './screenshot';

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

describe('why a picture failed', () => {
  it('prints only the origin and path of an address', () => {
    expect(resourceUrl('https://cdn.example/img/a.jpg?token=secret#frag')).toBe(
      'https://cdn.example/img/a.jpg',
    );
    expect(resourceUrl('data:image/png;base64,AAAA')).toBe('data:');
  });

  it.each<[string, unknown, string[], ShotFailure]>([
    [
      'images that did not load',
      new Error('x'),
      ['https://a/x.jpg'],
      { kind: 'resource', urls: ['https://a/x.jpg'] },
    ],
    ['a tainted canvas', new DOMException('x', 'SecurityError'), [], { kind: 'tainted' }],
    ['any other error', new RangeError('secret text'), [], { kind: 'error', name: 'RangeError' }],
  ])('classifies %s', (_label, error, missing, expected) => {
    expect(classifyShotError(error, missing)).toEqual(expected);
  });

  it('reports at most five distinct addresses', () => {
    const missing = ['a', 'a', 'b', 'c', 'd', 'e', 'f'].map((n) => `https://cdn.example/${n}.jpg`);
    const failure = classifyShotError(new Error('x'), missing);
    expect(failure).toMatchObject({ kind: 'resource' });
    expect((failure as { urls: string[] }).urls).toHaveLength(5);
  });

  it.each<[ShotFailure, string]>([
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'resource', urls: ['https://a/x.jpg', 'https://b/y.png'] }, 'https://a/x.jpg https://b/y.png'],
    [{ kind: 'tainted' }, 'tainted'],
    [{ kind: 'too_large' }, 'too large'],
    [{ kind: 'error', name: 'TypeError' }, 'TypeError'],
  ])('writes one line for %j', (failure, expected) => {
    expect(shotFailureLine(failure)).toContain(expected);
  });
});

describe('offscreenImageUrls', () => {
  const imageAt = (doc: Document, src: string, top: number): void => {
    const image = doc.createElement('img');
    image.src = src;
    image.getBoundingClientRect = () => new DOMRect(0, top, 100, 100);
    doc.body.append(image);
  };

  it('lists the images far outside the window, but not those shared with a visible one', () => {
    document.body.replaceChildren();
    imageAt(document, 'https://cdn.example/in.jpg', 50);
    imageAt(document, 'https://cdn.example/out.jpg', 5000);
    imageAt(document, 'https://cdn.example/both.jpg', 60);
    imageAt(document, 'https://cdn.example/both.jpg', 6000);
    const urls = offscreenImageUrls(document, { width: 800, height: 600 });
    expect([...urls]).toEqual(['https://cdn.example/out.jpg']);
  });
});

describe('createImageFetcher', () => {
  const fakeWin = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>): Window =>
    ({ fetch: fetchImpl }) as unknown as Window;

  it('returns a blank pixel and remembers the address when an image does not load', async () => {
    const missing = new Set<string>();
    const fetcher = createImageFetcher(
      fakeWin(async () => {
        throw new TypeError('Failed to fetch');
      }),
      { skip: new Set(), missing },
    );
    expect(await fetcher('https://cdn.example/a.jpg?sig=1')).toBe(BLANK_PIXEL);
    expect([...missing]).toEqual(['https://cdn.example/a.jpg']);
  });

  it('gives up on a slow image after its own limit', async () => {
    const missing = new Set<string>();
    const fetcher = createImageFetcher(
      fakeWin(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
          }),
      ),
      { skip: new Set(), missing, timeoutMs: 20 },
    );
    expect(await fetcher('https://cdn.example/slow.jpg')).toBe(BLANK_PIXEL);
    expect(missing.size).toBe(1);
  });

  it('does not download a skipped image and does not count it as missing', async () => {
    const missing = new Set<string>();
    let downloads = 0;
    const fetcher = createImageFetcher(
      fakeWin(async () => {
        downloads++;
        return new Response('x');
      }),
      { skip: new Set(['https://cdn.example/far.jpg']), missing },
    );
    expect(await fetcher('https://cdn.example/far.jpg')).toBe(BLANK_PIXEL);
    expect(downloads).toBe(0);
    expect(missing.size).toBe(0);
  });
});
