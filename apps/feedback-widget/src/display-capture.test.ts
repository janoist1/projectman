import { describe, expect, it, vi } from 'vitest';
import { ShareRefused, canShareDisplay, framesMatch, startShare } from './display-capture';

type Fakes = {
  isSecureContext?: boolean;
  getDisplayMedia?: unknown;
  policy?: { allowsFeature: (feature: string) => boolean };
};

const windowWith = ({ isSecureContext = true, getDisplayMedia, policy }: Fakes): Window =>
  ({
    isSecureContext,
    navigator: { mediaDevices: getDisplayMedia ? { getDisplayMedia } : undefined },
    document: { permissionsPolicy: policy },
  }) as unknown as Window;

describe('canShareDisplay', () => {
  const share = vi.fn();
  it.each([
    ['the browser can share', { getDisplayMedia: share }, true],
    ['the page is not a secure context', { getDisplayMedia: share, isSecureContext: false }, false],
    ['the browser has no screen sharing', {}, false],
    ['the page policy forbids it', { getDisplayMedia: share, policy: { allowsFeature: () => false } }, false],
  ])('when %s', (_name, fakes, expected) => {
    expect(canShareDisplay(windowWith(fakes))).toBe(expected);
  });
});

describe('framesMatch', () => {
  const view = { width: 1280, height: 800 };
  it('accepts a tab frame with the window proportions', () => {
    expect(framesMatch({ width: 1920, height: 1200 }, view, 'browser')).toBe(true);
  });
  it('refuses a tab frame whose proportions differ (the sharing bar narrowed the view)', () => {
    expect(framesMatch({ width: 1920, height: 1100 }, view, 'browser')).toBe(false);
  });
  it('refuses a window or a screen: the place cannot be found on it', () => {
    expect(framesMatch({ width: 1920, height: 1200 }, view, 'window')).toBe(false);
  });
});

describe('startShare', () => {
  const refuse = (name: string) =>
    startShare(
      windowWith({
        getDisplayMedia: vi.fn(async () => {
          throw Object.assign(new Error('x'), { name });
        }),
      }),
    );

  it('reports a denial', async () => {
    await expect(refuse('NotAllowedError')).rejects.toMatchObject({ reason: 'denied' });
  });
  it('reports any other failure as an error', async () => {
    const failure = refuse('NotFoundError');
    await expect(failure).rejects.toBeInstanceOf(ShareRefused);
    await expect(failure).rejects.toMatchObject({ reason: 'error' });
  });
});
