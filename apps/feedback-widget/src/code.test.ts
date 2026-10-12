import { describe, expect, it, vi } from 'vitest';
import { isWellFormedCode, takeLaunchParams } from './code';
import { CODE } from './test/helpers';

/** A window stand-in whose `replaceState` really changes the address, so the removal can be asserted. */
function fakeWindow(href: string) {
  const location = { href };
  const replaceState = vi.fn((_state: unknown, _title: string, url: string) => {
    location.href = new URL(url, location.href).href;
  });
  return {
    win: { location, history: { state: { keep: true }, replaceState } } as unknown as Pick<Window, 'location' | 'history'>,
    location,
    replaceState,
  };
}

const MARK = 'fbm_abcdefghij';

describe('takeLaunchParams', () => {
  it('reads the code from the fragment and removes the whole fragment', () => {
    const { win, location, replaceState } = fakeWindow(`http://shop.test/page#pm-feedback=${CODE}`);
    expect(takeLaunchParams(win)).toEqual({ code: CODE, markId: null });
    expect(location.href).toBe('http://shop.test/page');
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState.mock.calls[0]?.[0]).toEqual({ keep: true });
  });

  it('reads the code and the mark id and keeps the rest of the address', () => {
    const { win, location } = fakeWindow(`http://shop.test/page?a=1#pm-feedback=${CODE}&pm-feedback-mark=${MARK}`);
    expect(takeLaunchParams(win)).toEqual({ code: CODE, markId: MARK });
    expect(location.href).toBe('http://shop.test/page?a=1');
  });

  it('reads the code from the query and keeps other query parameters and the fragment', () => {
    const { win, location } = fakeWindow(`http://shop.test/page?x=1&pm-feedback=${CODE}&y=2#top`);
    expect(takeLaunchParams(win)?.code).toBe(CODE);
    expect(location.href).toBe('http://shop.test/page?x=1&y=2#top');
  });

  it('reads the code from the query of a hash route and keeps the route', () => {
    const { win, location } = fakeWindow(`http://shop.test/#/products?sort=asc&pm-feedback=${CODE}`);
    expect(takeLaunchParams(win)?.code).toBe(CODE);
    expect(location.href).toBe('http://shop.test/#/products?sort=asc');
  });

  it('ignores a mark id of the wrong shape', () => {
    const { win } = fakeWindow(`http://shop.test/page#pm-feedback=${CODE}&pm-feedback-mark=../../x`);
    expect(takeLaunchParams(win)).toEqual({ code: CODE, markId: null });
  });

  it('does nothing without launch parameters', () => {
    const { win, replaceState } = fakeWindow('http://shop.test/page?a=1#section');
    expect(takeLaunchParams(win)).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('isWellFormedCode', () => {
  it('accepts exactly 43 base64url characters', () => {
    expect(isWellFormedCode(CODE)).toBe(true);
    expect(isWellFormedCode('short')).toBe(false);
    expect(isWellFormedCode(`${CODE.slice(1)}!`)).toBe(false);
    expect(isWellFormedCode(`${CODE}a`)).toBe(false);
  });
});
