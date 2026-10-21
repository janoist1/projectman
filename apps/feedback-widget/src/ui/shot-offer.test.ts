import { describe, expect, it } from 'vitest';
import type { Draft, ShotState } from '../controller';
import { browserOffer, shotNote } from './shot-offer';

const draft = (shot: Partial<ShotState>, shotEnabled = true): Draft =>
  ({
    shotEnabled,
    shot: { status: 'ready', preview: 'data:x', source: 'auto', unmarked: false, browser: 'idle', ...shot },
  }) as Draft;

describe('browserOffer', () => {
  it.each([
    ['sharing is not possible', draft({ status: 'failed' }), false, false, 'none'],
    ['an answer is awaited', draft({ browser: 'asking' }), true, false, 'asking'],
    ['a good browser picture is there', draft({ source: 'browser' }), true, true, 'none'],
    ['a shared window is there', draft({ source: 'browser', unmarked: true }), true, true, 'link'],
    ['the picture is slow', draft({ status: 'pending', preview: null }), true, false, 'link'],
    ['the picture is slow but a share is open', draft({ status: 'pending' }), true, true, 'none'],
    ['the automatic picture failed', draft({ status: 'failed' }), true, false, 'button'],
    ['the automatic picture is not good', draft({}), true, false, 'link'],
  ])('when %s', (_name, given, canShare, sharing, expected) => {
    expect(browserOffer(given, canShare, sharing)).toBe(expected);
  });
});

describe('shotNote', () => {
  it.each([
    ['failed, sharing possible', draft({ status: 'failed' }), true, 'new.screenshotFailedOffer', false],
    ['failed, sharing impossible', draft({ status: 'failed' }), false, 'new.screenshotFailed', false],
    [
      'failed after a denial',
      draft({ status: 'failed', browser: 'denied' }),
      true,
      'new.browserDeniedNone',
      true,
    ],
    ['switched off', draft({}, false), true, 'new.screenshotOff', false],
    ['pending', draft({ status: 'pending' }), true, 'new.screenshotWait', false],
    ['from the tab', draft({ source: 'browser' }), true, 'new.shotFromBrowser', false],
    ['from a window', draft({ source: 'browser', unmarked: true }), true, 'new.shotFromWindow', false],
    ['automatic after an error', draft({ browser: 'error' }), true, 'new.browserErrorAuto', true],
    ['automatic', draft({}), true, 'new.screenshotOn', false],
  ])('says the right thing when %s', (_name, given, canShare, key, warn) => {
    expect(shotNote(given, canShare)).toEqual({ key, warn });
  });
});
