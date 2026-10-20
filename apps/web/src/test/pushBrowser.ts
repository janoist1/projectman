import { vi } from 'vitest';
import type { PushPermission, PushSupport } from '../lib/pushBrowser';
import type { BrowserSubscription } from '../lib/pushBrowser';
import { mockEndpointHash } from '../mocks/push';

/**
 * A fake browser for web push tests (PM-815): what `lib/pushBrowser` reports, and what a press on the permission
 * prompt or a subscribe does. No test ever reaches `Notification`, `PushManager` or a real push service.
 * Use it as `vi.mock('../../lib/pushBrowser', async () => (await import('../../test/pushBrowser')).pushBrowserModule)`.
 */
export const fakeBrowser: {
  support: PushSupport;
  permission: PushPermission;
  /** What the person answers when the browser asks. */
  answer: NotificationPermission;
  subscription: BrowserSubscription | null;
  installed: boolean;
  /** The next subscribe call fails with this. */
  subscribeError: Error | null;
} = {
  support: 'supported',
  permission: 'default',
  answer: 'granted',
  subscription: null,
  installed: false,
  subscribeError: null,
};

const KEYS = { p256dh: 'p'.repeat(87), auth: 'a'.repeat(22) };

/** A browser subscription with a made-up endpoint of a push service the server accepts. */
export function browserSubscription(name = 'this-browser'): BrowserSubscription {
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: KEYS };
}

/** The hash the fake backend gives a device that subscribed with `browserSubscription(name)`. */
export function browserHash(name = 'this-browser'): string {
  return mockEndpointHash(browserSubscription(name).endpoint);
}

/** Back to a supported browser that was never asked. */
export function resetFakeBrowser() {
  fakeBrowser.support = 'supported';
  fakeBrowser.permission = 'default';
  fakeBrowser.answer = 'granted';
  fakeBrowser.subscription = null;
  fakeBrowser.installed = false;
  fakeBrowser.subscribeError = null;
  pushBrowserModule.requestPermission.mockClear();
  pushBrowserModule.subscribeBrowser.mockClear();
  pushBrowserModule.unsubscribeBrowser.mockClear();
}

export const pushBrowserModule = {
  isInstalledApp: () => fakeBrowser.installed,
  pushSupport: () => fakeBrowser.support,
  readPermission: () => fakeBrowser.permission,
  requestPermission: vi.fn(async () => {
    fakeBrowser.permission = fakeBrowser.answer;
    return fakeBrowser.answer;
  }),
  currentSubscription: async () => fakeBrowser.subscription,
  subscribeBrowser: vi.fn(async () => {
    if (fakeBrowser.subscribeError) throw fakeBrowser.subscribeError;
    fakeBrowser.subscription = browserSubscription();
    return fakeBrowser.subscription;
  }),
  unsubscribeBrowser: vi.fn(async () => {
    const had = fakeBrowser.subscription !== null;
    fakeBrowser.subscription = null;
    return had;
  }),
  endpointHash: async (endpoint: string) => mockEndpointHash(endpoint),
};
