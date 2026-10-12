import { beforeEach, describe, expect, it } from 'vitest';
import type { FeedbackAnchor } from '@projectman/shared';
import { findElement, groupForPanel, isSamePage, resolveAnchor, snippetOf, tipOf } from './anchor';
import { mark, pageAnchor, pointAnchor } from './test/helpers';

const SIZE = { width: 1000, height: 2000 };

const elementAnchor = (overrides: Partial<FeedbackAnchor> = {}): FeedbackAnchor => ({
  kind: 'element',
  selector: '#buy',
  textSnippet: 'Buy now',
  elementOffset: { x: 0.5, y: 0.5 },
  pagePoint: { x: 300, y: 400 },
  rect: null,
  ...overrides,
});

describe('anchor lookup', () => {
  beforeEach(() => {
    document.body.innerHTML = '<main><button id="buy">  Buy   now </button><p class="dup">a</p><p class="dup">b</p></main>';
  });

  it('finds an element mark by its unique selector and unchanged text', () => {
    const resolution = resolveAnchor(elementAnchor(), document, SIZE);
    expect(resolution).toMatchObject({ place: 'located', changed: false });
    expect(resolution.place === 'located' && resolution.element?.id).toBe('buy');
  });

  it('flags the mark as changed when the element text no longer holds the snippet', () => {
    const resolution = resolveAnchor(elementAnchor({ textSnippet: 'Add to cart' }), document, SIZE);
    expect(resolution).toMatchObject({ place: 'located', changed: true, element: null, point: { x: 300, y: 400 } });
  });

  it('falls back to the saved coordinate when the selector matches nothing', () => {
    const resolution = resolveAnchor(elementAnchor({ selector: '#gone' }), document, SIZE);
    expect(resolution).toMatchObject({ place: 'located', changed: true, element: null });
  });

  it('does not trust a selector that matches several elements', () => {
    expect(findElement('.dup', document)).toBeNull();
    const resolution = resolveAnchor(elementAnchor({ selector: '.dup', textSnippet: null }), document, SIZE);
    expect(resolution).toMatchObject({ place: 'located', changed: true });
  });

  it('survives a selector the browser rejects', () => {
    expect(findElement('div[[', document)).toBeNull();
    const resolution = resolveAnchor(elementAnchor({ selector: 'div[[' }), document, SIZE);
    expect(resolution).toMatchObject({ place: 'located', changed: true });
  });

  it('is lost when neither the element nor the coordinate is on the page', () => {
    const resolution = resolveAnchor(elementAnchor({ selector: '#gone', pagePoint: { x: 300, y: 9000 } }), document, SIZE);
    expect(resolution).toEqual({ place: 'lost' });
  });

  it('places a point mark at its coordinate and an area mark at its rectangle', () => {
    expect(resolveAnchor(pointAnchor(10, 20), document, SIZE)).toMatchObject({ place: 'located', point: { x: 10, y: 20 } });
    const rect = { x: 50, y: 60, width: 200, height: 100 };
    const area: FeedbackAnchor = { ...pointAnchor(), kind: 'area', pagePoint: null, rect };
    expect(resolveAnchor(area, document, SIZE)).toMatchObject({ place: 'located', rect, point: { x: 50, y: 60 } });
  });

  it('keeps a whole-page mark off the page', () => {
    expect(resolveAnchor(pageAnchor(), document, SIZE)).toEqual({ place: 'page' });
  });

  it('puts a point past the document edge in the lost group', () => {
    expect(resolveAnchor(pointAnchor(5000, 10), document, SIZE)).toEqual({ place: 'lost' });
  });

  it('takes a collapsed, bounded snippet of an element text', () => {
    expect(snippetOf(document.getElementById('buy')!)).toBe('Buy now');
    const long = document.createElement('p');
    long.textContent = 'x'.repeat(500);
    expect(snippetOf(long)).toHaveLength(120);
    expect(snippetOf(document.createElement('div'))).toBeNull();
  });

  it('gives a tip only for a located mark and follows a live element box', () => {
    const resolution = resolveAnchor(pointAnchor(10, 20), document, SIZE);
    expect(tipOf(resolution, pointAnchor(10, 20), { x: 0, y: 0 })).toEqual({ x: 10, y: 20 });
    expect(tipOf({ place: 'lost' }, pointAnchor(), { x: 0, y: 0 })).toBeNull();
    expect(tipOf({ place: 'page' }, pageAnchor(), { x: 0, y: 0 })).toBeNull();
  });
});

describe('isSamePage', () => {
  const here = { origin: 'http://shop.test', pathname: '/page' };

  it('compares origin and path and ignores query, fragment and a trailing slash', () => {
    expect(isSamePage('http://shop.test/page', here)).toBe(true);
    expect(isSamePage('http://shop.test/page/?a=1#x', here)).toBe(true);
    expect(isSamePage('http://shop.test/other', here)).toBe(false);
    expect(isSamePage('https://shop.test/page', here)).toBe(false);
    expect(isSamePage('not a url', here)).toBe(false);
  });
});

describe('groupForPanel', () => {
  it('splits marks into the whole-page, pinned and lost groups', () => {
    const marks = [
      mark({ id: 'fbm_a', anchor: pageAnchor(), kind: 'page' }),
      mark({ id: 'fbm_b' }),
      mark({ id: 'fbm_c', anchor: pointAnchor(9000, 9000) }),
    ];
    const groups = groupForPanel(marks, (m) => resolveAnchor(m.anchor, document, SIZE));
    expect(groups.page.map((m) => m.id)).toEqual(['fbm_a']);
    expect(groups.pinned.map((m) => m.id)).toEqual(['fbm_b']);
    expect(groups.lost.map((m) => m.id)).toEqual(['fbm_c']);
  });
});
