import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../api/client';
import { createMockFetch, mockProject } from '../test/mockProject';
import {
  browserHash,
  browserSubscription,
  fakeBrowser,
  pushBrowserModule,
  resetFakeBrowser,
} from '../test/pushBrowser';
import { unsubscribeThisDevice } from './pushDevice';

vi.mock('./pushBrowser', async () => (await import('../test/pushBrowser')).pushBrowserModule);

beforeEach(() => resetFakeBrowser());
afterEach(() => {
  vi.useRealTimers();
  setFetchImplementation((input, init) => globalThis.fetch(input, init));
});

describe('unsubscribeThisDevice', () => {
  it('takes this browser off the server list, then drops the browser subscription', async () => {
    const project = mockProject();
    fakeBrowser.subscription = browserSubscription();
    project.backend.push.addDevice({ endpointHash: browserHash() });
    project.backend.push.addDevice({ endpointHash: browserHash('other-browser') });
    await unsubscribeThisDevice();
    expect(project.backend.push.devices.map((d) => d.endpointHash)).toEqual([browserHash('other-browser')]);
    expect(pushBrowserModule.unsubscribeBrowser).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.subscription).toBeNull();
  });

  it('does nothing when this browser has no subscription', async () => {
    const project = mockProject();
    await unsubscribeThisDevice();
    expect(project.requests).toHaveLength(0);
  });

  it('swallows a failure, so it can never keep anyone from logging out', async () => {
    const project = mockProject();
    fakeBrowser.subscription = browserSubscription();
    project.backend.push.addDevice({ endpointHash: browserHash() });
    setFetchImplementation(async () => new Response('{}', { status: 500 }));
    await expect(unsubscribeThisDevice()).resolves.toBeUndefined();
    // The browser keeps its subscription: the server row is still there to be deleted from the page.
    expect(pushBrowserModule.unsubscribeBrowser).not.toHaveBeenCalled();
  });

  it('stops waiting for a server that does not answer', async () => {
    vi.useFakeTimers();
    const project = mockProject();
    fakeBrowser.subscription = browserSubscription();
    const reachable = createMockFetch(project.backend, project.requests);
    setFetchImplementation((input, init) =>
      String(input).endsWith('/unsubscribe')
        ? new Promise<Response>(() => {})
        : reachable(String(input), init),
    );
    let done = false;
    void unsubscribeThisDevice().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });
});
