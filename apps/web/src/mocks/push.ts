import {
  DEFAULT_PUSH_SETTINGS,
  PushSettings,
  SubscribePushRequest,
  UpdatePushDeviceRequest,
} from '@projectman/shared';
import type { ErrorCode, PushDeviceView, PushFailure, PushOverview, PushResult } from '@projectman/shared';
import { mockId, nowIso } from './time';

interface MockResponse {
  status: number;
  body?: unknown;
}

/** The most devices one person may register (the server's limit). */
const DEVICE_LIMIT = 20;
/** How soon a device may be tested again, in milliseconds (the server's limit). */
const TEST_SPACING_MS = 5000;

/** What the fake pretends the browser's endpoint hash is; a test replaces `lib/pushBrowser`'s hash with it. */
export function mockEndpointHash(endpoint: string): string {
  return `hash:${endpoint}`;
}

function error(status: number, code: ErrorCode, message: string): MockResponse {
  return { status, body: { error: { code, message } } };
}

/**
 * The fake web push of the backend (PM-815): the signed-in person's devices and settings, answering like
 * `apps/server/src/api/web-push.ts`. Nothing is ever sent; a test sets what the next test send reports with
 * `nextResult`, and reads `calls` to see what the screen asked for.
 */
export class MockPush {
  /** False answers every call with `web_push_unavailable` (the server has no VAPID key). */
  available = true;
  publicKey = 'BAWjAnEvcwXtkUv3Xo1ZEY7rSJbVNn0H7i1eC4xK3UNIkVbtQ6hTrX0gYkz9nEgqsd0Z9p3jX2qk8yq1Lw5YJ0E';
  settings: PushSettings = structuredClone(DEFAULT_PUSH_SETTINGS);
  devices: PushDeviceView[] = [];
  /** Endpoint hashes that belong to another person's device: subscribing with one is refused with a 409. */
  readonly foreignHashes = new Set<string>();
  /** What the next test send reports for the device. */
  nextResult: { result: PushResult; failure?: PushFailure } = { result: 'ok' };
  /** Every call, in order, as method and path after `/api/me/push`: `GET`, `PATCH /devices/<id>` and so on. */
  readonly calls: string[] = [];
  private readonly testedAt = new Map<string, number>();
  /** The clock of the test spacing; a test may move it. */
  now: () => number = () => Date.now();

  /** Adds a device row the person already has (`endpointHash` defaults to the hash of a made-up endpoint). */
  addDevice(patch: Partial<PushDeviceView> = {}): PushDeviceView {
    const id = patch.id ?? mockId('pushdev');
    const device: PushDeviceView = {
      id,
      endpointHash: mockEndpointHash(`https://fcm.googleapis.com/fcm/send/${id}`),
      browser: 'Chrome',
      os: 'macOS',
      form: 'desktop',
      installed: false,
      enabled: true,
      state: 'active',
      lastSentAt: null,
      lastResult: null,
      lastFailure: null,
      createdAt: nowIso(),
      ...patch,
    };
    this.devices.push(device);
    return device;
  }

  overview(): PushOverview {
    return {
      available: this.available,
      publicKey: this.available ? this.publicKey : null,
      settings: this.settings,
      devices: this.devices,
    };
  }

  /** `rest` is the path after `/api/me/push`. Returns undefined for a route that is not push. */
  handle(method: string, rest: string, body: unknown): MockResponse | undefined {
    const route = `${method} ${rest}`;
    const id = /^\/devices\/([^/]+)/.exec(rest)?.[1];
    this.calls.push(route.trim());
    if (route === 'GET ') return { status: 200, body: this.overview() };
    if (route === 'PUT /settings') {
      const parsed = PushSettings.safeParse(body);
      if (!parsed.success) return error(400, 'web_push_quiet_hours_invalid', 'Invalid push settings');
      this.settings = parsed.data;
      return { status: 200, body: this.settings };
    }
    if (route === 'POST /devices') return this.subscribe(body);
    if (route === 'POST /unsubscribe') return this.unsubscribe(body);
    if (!id) return undefined;
    const device = this.devices.find((d) => d.id === id);
    if (!device) return error(404, 'not_found', 'Push device not found');
    if (method === 'PATCH' && rest === `/devices/${id}`) {
      const parsed = UpdatePushDeviceRequest.safeParse(body);
      if (!parsed.success) return error(400, 'invalid_request', 'Invalid body');
      device.enabled = parsed.data.enabled;
      return { status: 200, body: device };
    }
    if (method === 'DELETE' && rest === `/devices/${id}`) {
      this.devices = this.devices.filter((d) => d.id !== id);
      return { status: 204 };
    }
    if (method === 'POST' && rest === `/devices/${id}/test`) return this.test(device);
    return undefined;
  }

  private subscribe(body: unknown): MockResponse {
    if (!this.available) return error(503, 'web_push_unavailable', 'Web push is unavailable');
    const parsed = SubscribePushRequest.safeParse(body);
    if (!parsed.success) return error(400, 'web_push_endpoint_invalid', 'Push endpoint is not allowed');
    const hash = mockEndpointHash(parsed.data.endpoint);
    if (this.foreignHashes.has(hash))
      return error(409, 'web_push_endpoint_taken', 'Push endpoint belongs to another user');
    const own = this.devices.find((d) => d.endpointHash === hash);
    if (!own && this.devices.length >= DEVICE_LIMIT)
      return error(409, 'web_push_device_limit', 'Push device limit reached');
    if (own) {
      own.enabled = true;
      own.state = 'active';
      own.installed = parsed.data.installed;
      return { status: 200, body: own };
    }
    const device = this.addDevice({ endpointHash: hash, installed: parsed.data.installed });
    return { status: 201, body: device };
  }

  private unsubscribe(body: unknown): MockResponse {
    const endpoint = (body as { endpoint?: unknown } | null)?.endpoint;
    if (typeof endpoint === 'string') {
      const hash = mockEndpointHash(endpoint);
      this.devices = this.devices.filter((d) => d.endpointHash !== hash);
    }
    return { status: 204 };
  }

  private test(device: PushDeviceView): MockResponse {
    if (!this.available) return error(503, 'web_push_unavailable', 'Web push is unavailable');
    if (device.state !== 'active') return error(400, 'web_push_endpoint_invalid', 'Push device has expired');
    const time = this.now();
    if (time - (this.testedAt.get(device.id) ?? -Infinity) < TEST_SPACING_MS)
      return error(429, 'web_push_test_too_soon', 'Wait before testing again');
    this.testedAt.set(device.id, time);
    const { result, failure } = this.nextResult;
    device.lastSentAt = nowIso();
    device.lastResult = result;
    device.lastFailure = result === 'failed' ? (failure ?? 'network') : null;
    if (result === 'expired') device.state = 'expired';
    return { status: 200, body: device };
  }
}
