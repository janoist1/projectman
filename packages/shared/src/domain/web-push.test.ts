import { describe, expect, it } from 'vitest';
import { TODO_DONE_OPTION, TODO_CANNOT_OPTION } from './inbox';
import type { InboxItem, QuietHours as QuietHoursType } from '../index';
import {
  DEFAULT_PUSH_SETTINGS,
  deviceLabelOf,
  isAllowedPushEndpoint,
  isPushableItem,
  pushCategoryOf,
  QuietHours,
  quietWindowAt,
} from './web-push';

const item: InboxItem = {
  id: 'one',
  kind: 'question',
  assignees: ['owner'],
  projectKey: 'AR',
  source: 'dev',
  sessionId: null,
  taskKey: 'AR-1',
  title: 'Private title',
  body: 'Private body',
  payload: {},
  options: [],
  state: 'open',
  resolution: null,
  createdAt: '2026-10-20T10:00:00Z',
};
describe('push eligibility', () => {
  it.each([
    ['question', 'question'],
    ['decision', 'decision'],
    ['approval', 'approval'],
    ['permission', 'permission'],
    ['release', 'release'],
    ['hand_on', 'decision'],
    ['merge_request', 'decision'],
    ['alert', null],
  ] as const)('maps %s to %s', (kind, category) => expect(pushCategoryOf({ ...item, kind })).toBe(category));
  it('maps a gate approval decision to approval', () =>
    expect(
      pushCategoryOf({
        ...item,
        kind: 'decision',
        payload: {
          gate: {
            requestId: 'req',
            taskKey: 'AR-1',
            fromStageId: 'dev',
            toStageId: 'review',
            stageId: 'review',
            label: 'approved',
            requestedBy: { kind: 'human', handle: 'owner' },
          },
        },
      }),
    ).toBe('approval'));
  it('accepts an open human assignment', () => expect(isPushableItem(item, 'owner')).toBe(true));
  it.each([
    { state: 'screening' },
    { kind: 'alert' },
    { assignees: ['other'] },
    {
      options: [TODO_DONE_OPTION, TODO_CANNOT_OPTION],
      payload: {
        recipient: 'integrator',
        question: 'private',
        integratorOpenedAt: item.createdAt,
        screening: {
          until: item.createdAt,
          outcome: 'todo',
          todo: { what: 'Measure', where: 'Hub', expected: 'Result', recipient: 'integrator' },
        },
      },
    },
  ])('refuses ineligible assignments: %j', (change) =>
    expect(isPushableItem({ ...item, ...change } as InboxItem, 'owner')).toBe(false),
  );
});
describe('quiet hours', () => {
  const q: QuietHoursType = { enabled: true, start: '22:00', end: '07:00', timeZone: 'UTC' };
  it.each([
    ['2026-10-20T22:00:45Z', true, '2026-10-21T07:00:00.000Z'],
    ['2026-10-21T06:59:59Z', true, '2026-10-21T07:00:00.000Z'],
    ['2026-10-21T07:00:00Z', false, null],
  ])('handles overnight boundaries at %s', (time, quiet, endsAt) =>
    expect(quietWindowAt(q, new Date(time))).toMatchObject({ quiet, endsAt }),
  );
  it('returns the next start outside a daytime window', () =>
    expect(quietWindowAt({ ...q, start: '10:00', end: '12:00' }, new Date('2026-10-20T13:00:59Z'))).toEqual({
      quiet: false,
      endsAt: null,
      nextStartAt: '2026-10-21T10:00:00.000Z',
    }));
  it('handles a daytime window in another timezone', () =>
    expect(
      quietWindowAt(
        { ...q, start: '10:00', end: '12:00', timeZone: 'Asia/Tokyo' },
        new Date('2026-10-20T02:00:30Z'),
      ),
    ).toEqual({ quiet: true, endsAt: '2026-10-20T03:00:00.000Z', nextStartAt: null }));
  it('does not schedule a disabled window', () =>
    expect(quietWindowAt(DEFAULT_PUSH_SETTINGS.quietHours, new Date())).toEqual({
      quiet: false,
      endsAt: null,
      nextStartAt: null,
    }));
  it.each([
    ['2026-03-29T00:30:00Z', '2026-03-29T06:00:00.000Z'],
    ['2026-10-25T00:30:00Z', '2026-10-25T05:00:00.000Z'],
  ])('documents the one-hour DST approximation at %s', (time, endsAt) =>
    expect(quietWindowAt({ ...q, timeZone: 'Europe/Budapest' }, new Date(time)).endsAt).toBe(endsAt),
  );
  it.each([
    { ...q, start: '07:00' },
    { ...q, timeZone: 'not-a-zone' },
    { ...q, end: '24:00' },
  ])('rejects invalid quiet hours: %j', (value) => expect(QuietHours.safeParse(value).success).toBe(false));
});
describe('endpoint allowlist', () => {
  it.each([
    'fcm.googleapis.com',
    'android.googleapis.com',
    'updates.push.services.mozilla.com',
    'region.push.services.mozilla.com',
    'web.push.apple.com',
    'region.push.apple.com',
    'region.notify.windows.com',
  ])('allows %s', (host) => expect(isAllowedPushEndpoint(`https://${host}/endpoint`)).toBe(true));
  it.each([
    'http://fcm.googleapis.com/a',
    'https://127.0.0.1/a',
    'https://[::1]/a',
    'https://example.com/a',
    'https://fcm.googleapis.com:443/a',
    ' https://fcm.googleapis.com:443/a',
    'https://fcm.googleapis.com\\@127.0.0.1/a',
    'https://%66cm.googleapis.com/a',
    'https://fcm.googleapis.com:8443/a',
    'https://fcm.googleapis.com.evil.test/a',
    'https://user@fcm.googleapis.com/a',
    'https://push.apple.com/a',
    'garbage',
  ])('rejects %s', (url) => expect(isAllowedPushEndpoint(url)).toBe(false));
});
it.each([
  ['Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/141.0 Safari/537.36', 'Chrome', 'macOS', 'desktop'],
  ['Mozilla/5.0 (iPhone; CPU iPhone OS) AppleWebKit Mobile Safari/604.1', 'Safari', 'iOS', 'phone'],
  ['Mozilla/5.0 (Android) Chrome/141.0 Mobile', 'Chrome', 'Android', 'phone'],
  ['Mozilla/5.0 (Windows NT 10.0) Firefox/140.0', 'Firefox', 'Windows', 'desktop'],
  ['', 'other', 'other', 'desktop'],
])('labels %s without storing the UA', (ua, browser, os, form) =>
  expect(deviceLabelOf(ua)).toEqual({ browser, os, form }),
);
