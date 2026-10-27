import { z } from 'zod';
import { gateRequestOf, humanInboxAssignment } from './inbox';
import type { InboxItem } from './inbox';

export const PushCategory = z.enum(['question', 'decision', 'approval', 'permission', 'release']);
export type PushCategory = z.infer<typeof PushCategory>;
export const PushResult = z.enum(['ok', 'failed', 'expired']);
export type PushResult = z.infer<typeof PushResult>;
export const PushFailure = z.enum([
  'timeout',
  'network',
  'rejected',
  'rate_limited',
  'service_error',
  'payload_too_large',
]);
export type PushFailure = z.infer<typeof PushFailure>;
const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
export const QuietHours = z
  .object({
    enabled: z.boolean(),
    start: ClockTime,
    end: ClockTime,
    timeZone: z.string().refine(isValidTimeZone),
  })
  .refine((q) => q.start !== q.end);
export type QuietHours = z.infer<typeof QuietHours>;
export const PushCategories = z.object({
  question: z.boolean(),
  decision: z.boolean(),
  approval: z.boolean(),
  permission: z.boolean(),
  release: z.boolean(),
});
export type PushCategories = z.infer<typeof PushCategories>;
export const PushSettings = z.object({ categories: PushCategories, quietHours: QuietHours });
export type PushSettings = z.infer<typeof PushSettings>;
export const DEFAULT_PUSH_SETTINGS: PushSettings = {
  categories: { question: true, decision: true, approval: true, permission: true, release: true },
  quietHours: { enabled: false, start: '22:00', end: '07:00', timeZone: 'UTC' },
};
export const PushDeviceView = z.object({
  id: z.string(),
  endpointHash: z.string(),
  browser: z.string(),
  os: z.string(),
  form: z.enum(['desktop', 'phone']),
  installed: z.boolean(),
  enabled: z.boolean(),
  state: z.enum(['active', 'expired']),
  lastSentAt: z.string().nullable(),
  lastResult: PushResult.nullable(),
  lastFailure: PushFailure.nullable(),
  createdAt: z.string(),
});
export type PushDeviceView = z.infer<typeof PushDeviceView>;
export const PushOverview = z.object({
  available: z.boolean(),
  publicKey: z.string().nullable(),
  settings: PushSettings,
  devices: z.array(PushDeviceView),
});
export type PushOverview = z.infer<typeof PushOverview>;
export const SubscribePushRequest = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
  }),
  installed: z.boolean(),
});
export type SubscribePushRequest = z.infer<typeof SubscribePushRequest>;
export const UpdatePushDeviceRequest = z.object({ enabled: z.boolean() });
export type UpdatePushDeviceRequest = z.infer<typeof UpdatePushDeviceRequest>;
export const UnsubscribePushRequest = z.object({ endpoint: z.string().url().max(2048) });
export type UnsubscribePushRequest = z.infer<typeof UnsubscribePushRequest>;
export const PushPayload = z.object({
  v: z.literal(1),
  kind: z.enum(['item', 'digest', 'test']),
  title: z.string(),
  body: z.string(),
  tag: z.string(),
  url: z.string().startsWith('/'),
  itemId: z.string().optional(),
  projectKey: z.string().optional(),
});
export type PushPayload = z.infer<typeof PushPayload>;

export function pushCategoryOf(item: InboxItem): PushCategory | null {
  switch (item.kind) {
    case 'alert':
      return null;
    case 'decision':
      return gateRequestOf(item) ? 'approval' : 'decision';
    case 'hand_on':
    case 'merge_request':
      return 'decision';
    default:
      return item.kind;
  }
}
export function isPushableItem(item: InboxItem, handle: string): boolean {
  return item.state === 'open' && pushCategoryOf(item) !== null && humanInboxAssignment(item, handle);
}
const minuteOf = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
/** Minute arithmetic deliberately tolerates a one-hour DST offset during a transition night. */
export function quietWindowAt(
  q: QuietHours,
  now: Date,
): { quiet: boolean; endsAt: string | null; nextStartAt: string | null } {
  if (!q.enabled) return { quiet: false, endsAt: null, nextStartAt: null };
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: q.timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const current =
    Number(parts.find((p) => p.type === 'hour')!.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')!.value);
  const start = minuteOf(q.start),
    end = minuteOf(q.end);
  const quiet = start < end ? current >= start && current < end : current >= start || current < end;
  const atMinute = (target: number) =>
    new Date(
      Math.floor(now.getTime() / 60000) * 60000 + ((target - current + 1440) % 1440) * 60000,
    ).toISOString();
  return { quiet, endsAt: quiet ? atMinute(end) : null, nextStartAt: quiet ? null : atMinute(start) };
}
export function isAllowedPushEndpoint(value: string): boolean {
  try {
    // Require a plain authority with no port or credentials; reject parser normalization ambiguities.
    if (!/^https:\/\/[a-z0-9.-]+(?:[/?#]|$)/i.test(value) || /[\s\\]/.test(value)) return false;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password) return false;
    const host = url.hostname;
    return (
      [
        'fcm.googleapis.com',
        'android.googleapis.com',
        'updates.push.services.mozilla.com',
        'web.push.apple.com',
      ].includes(host) ||
      ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'].some((suffix) =>
        host.endsWith(suffix),
      )
    );
  } catch {
    return false;
  }
}
export function deviceLabelOf(ua: string): { browser: string; os: string; form: 'desktop' | 'phone' } {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome|CriOS/.test(ua)
        ? 'Chrome'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'other';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Macintosh|Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'other';
  return { browser, os, form: /Mobile|Android|iPhone|iPad|iPod/.test(ua) ? 'phone' : 'desktop' };
}
