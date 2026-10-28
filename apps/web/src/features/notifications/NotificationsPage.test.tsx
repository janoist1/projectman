import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { ToastProvider } from '../../components/Toast';
import { t } from '../../i18n/t';
import { codeMessage } from '../../lib/errors';
import { createMockFetch, mockProject } from '../../test/mockProject';
import {
  browserHash,
  browserSubscription,
  fakeBrowser,
  pushBrowserModule,
  resetFakeBrowser,
} from '../../test/pushBrowser';
import { NotificationsPage } from './NotificationsPage';

vi.mock('../../lib/pushBrowser', async () => (await import('../../test/pushBrowser')).pushBrowserModule);

beforeEach(() => resetFakeBrowser());
afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

/** The word that opens a device's last-send line ("sent", "failed"), without the time after it. */
const stateWord = (state: 'ok' | 'failed') =>
  t(`notifications.devices.state.${state}`, { when: '' }).split(' ·')[0]!;
/** Any device's test and delete buttons, whatever the device is called. */
const testLabel = new RegExp(`^${t('notifications.devices.testLabel', { name: '' })}`);
const removeLabel = new RegExp(`^${t('notifications.devices.removeLabel', { name: '' })}`);

function renderPage() {
  const project = mockProject();
  project.render(
    <ToastProvider>
      <NotificationsPage />
    </ToastProvider>,
    '/p/AC/notifications',
  );
  return project;
}

/** This browser already has a subscription, and the server a row for it. */
function subscribedHere(project: ReturnType<typeof mockProject>, patch = {}) {
  fakeBrowser.permission = 'granted';
  fakeBrowser.subscription = browserSubscription();
  return project.backend.push.addDevice({ endpointHash: browserHash(), ...patch });
}

describe('this device', () => {
  it.each([true, false])('shows host request preferences only for the host (%s)', async (host) => {
    const project = mockProject();
    if (!host) project.backend.user.userId = 'usr_other';
    project.render(<NotificationsPage />);
    await screen.findByText(t('notifications.kinds.question'));
    await waitFor(() => expect(project.requests.some((r) => r.path === '/api/me')).toBe(true));
    await waitFor(() =>
      expect(
        Boolean(screen.queryByRole('switch', { name: new RegExp(t('notifications.kinds.hostRequest')) })),
      ).toBe(host),
    );
  });
  it('asks for the permission on the press, subscribes and shows the device as this one', async () => {
    const project = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.off.action') }));
    expect(await screen.findByText(t('notifications.on.title'))).toBeTruthy();
    expect(pushBrowserModule.requestPermission).toHaveBeenCalledTimes(1);
    const subscribe = project.requests.find((r) => r.method === 'POST' && r.path === '/api/me/push/devices');
    expect(subscribe?.body).toMatchObject({ endpoint: browserSubscription().endpoint, installed: false });
    expect(await screen.findByText(t('notifications.enabled'))).toBeTruthy();
    const row = screen.getByText(/Chrome · macOS/, { selector: 'span' }).closest('li')!;
    expect(within(row).getByText(t('notifications.devices.self'))).toBeTruthy();
  });

  it('does not subscribe when the person refuses the prompt, and then shows how to allow it', async () => {
    const project = renderPage();
    fakeBrowser.answer = 'denied';
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.off.action') }));
    expect(await screen.findByText(t('notifications.denied.title'))).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(0);
    expect(pushBrowserModule.subscribeBrowser).not.toHaveBeenCalled();
  });

  it('looks at the permission again and subscribes once the browser allows it', async () => {
    fakeBrowser.permission = 'denied';
    const project = renderPage();
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.denied.action') }));
    expect(await screen.findByText(t('notifications.denied.stillDenied'))).toBeTruthy();
    fakeBrowser.permission = 'granted';
    fireEvent.click(screen.getByRole('button', { name: t('notifications.denied.action') }));
    expect(await screen.findByText(t('notifications.on.title'))).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(1);
  });

  it('tells an iPhone browser tab to install the app first and offers no switch', async () => {
    fakeBrowser.support = 'ios_install';
    renderPage();
    expect(await screen.findByText(t('notifications.ios.title'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('notifications.off.action') })).toBeNull();
  });

  it('says so when the browser cannot receive notifications', async () => {
    fakeBrowser.support = 'unsupported';
    renderPage();
    expect(await screen.findByText(t('notifications.unsupported.title'))).toBeTruthy();
  });

  it('says so when the server has push switched off', async () => {
    const project = mockProject();
    project.backend.push.available = false;
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    expect(await screen.findByText(t('notifications.unavailable.title'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: t('notifications.off.action') })).toBeNull();
  });

  it('shows an enable failure on the card and keeps it off', async () => {
    renderPage();
    fakeBrowser.subscribeError = new Error('push service unreachable');
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.off.action') }));
    expect(await screen.findByText(t('notifications.enableFailed'))).toBeTruthy();
    expect(screen.getByText(t('notifications.off.title'))).toBeTruthy();
  });

  it('subscribes anew once when the browser still carries another person’s endpoint', async () => {
    const project = renderPage();
    project.backend.push.foreignHashes.add(browserHash('previous-user'));
    pushBrowserModule.subscribeBrowser.mockImplementationOnce(async () => {
      fakeBrowser.subscription = browserSubscription('previous-user');
      return fakeBrowser.subscription;
    });
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.off.action') }));
    expect(await screen.findByText(t('notifications.on.title'))).toBeTruthy();
    expect(pushBrowserModule.subscribeBrowser).toHaveBeenCalledTimes(2);
    expect(pushBrowserModule.unsubscribeBrowser).toHaveBeenCalledTimes(1);
    expect(project.backend.push.devices).toMatchObject([{ endpointHash: browserHash() }]);
  });

  it('shows the endpoint-taken message when the second subscribe is refused too', async () => {
    const project = renderPage();
    project.backend.push.foreignHashes.add(browserHash());
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.off.action') }));
    expect(await screen.findByText(codeMessage('web_push_endpoint_taken')!)).toBeTruthy();
    expect(pushBrowserModule.subscribeBrowser).toHaveBeenCalledTimes(2);
    expect(project.backend.push.devices).toHaveLength(0);
  });

  it('offers a one-press re-enable for a revoked subscription and replaces the dead row', async () => {
    const project = mockProject();
    fakeBrowser.permission = 'granted';
    fakeBrowser.subscription = browserSubscription();
    const dead = project.backend.push.addDevice({
      endpointHash: browserHash('old-browser'),
      state: 'expired',
      lastResult: 'expired',
    });
    // The browser's subscription is the old one, whose row the server marked expired.
    dead.endpointHash = browserHash();
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.expired.action') }));
    expect(await screen.findByText(t('notifications.on.title'))).toBeTruthy();
    // The same endpoint re-activates its row (200), so there is still exactly one.
    expect(project.backend.push.devices).toHaveLength(1);
    expect(project.backend.push.devices[0]).toMatchObject({ state: 'active', enabled: true });
  });

  it('sends a test to this device and says it went out', async () => {
    const project = mockProject();
    subscribedHere(project, { lastResult: 'ok', lastSentAt: new Date().toISOString() });
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.on.test') }));
    expect(await screen.findByText(t('notifications.devices.testOkSelf'))).toBeTruthy();
    expect(project.backend.push.calls.some((c) => /^POST \/devices\/.+\/test$/.test(c))).toBe(true);
  });

  it('turns this device off: unsubscribes the browser and drops the row', async () => {
    const project = mockProject();
    subscribedHere(project);
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.on.disable') }));
    expect(await screen.findByText(t('notifications.on.disabled'))).toBeTruthy();
    expect(await screen.findByText(t('notifications.off.title'))).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(0);
    expect(fakeBrowser.subscription).toBeNull();
    expect(project.backend.push.calls).toContain('POST /unsubscribe');
  });
});

describe('devices', () => {
  it('lists the devices with the last send of each, and the reason a send failed', async () => {
    const project = mockProject();
    const now = new Date().toISOString();
    project.backend.push.addDevice({ id: 'd-ok', lastResult: 'ok', lastSentAt: now });
    project.backend.push.addDevice({
      id: 'd-bad',
      browser: 'Firefox',
      os: 'Windows',
      lastResult: 'failed',
      lastFailure: 'timeout',
      lastSentAt: now,
    });
    project.backend.push.addDevice({
      id: 'd-new',
      browser: 'Safari',
      os: 'iOS',
      form: 'phone',
      installed: true,
    });
    project.backend.push.addDevice({ id: 'd-dead', browser: 'other', os: 'other', state: 'expired' });
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    const ok = (await screen.findByText('Chrome · macOS')).closest('li')!;
    expect(ok.textContent).toContain(stateWord('ok'));
    const bad = screen.getByText('Firefox · Windows').closest('li')!;
    expect(bad.textContent).toContain(stateWord('failed'));
    expect(bad.textContent).toContain(t('notifications.failure.timeout'));
    const fresh = screen.getByText(/Safari · /).closest('li')!;
    expect(fresh.textContent).toContain(t('notifications.devices.installed', { name: '' }).trim());
    expect(fresh.textContent).toContain(t('notifications.devices.state.none'));
    const dead = screen.getByText(t('notifications.devices.unknownBrowser'), { exact: false }).closest('li')!;
    expect(dead.textContent).toContain(t('notifications.devices.expiredWhy'));
    // An expired device has neither a switch nor a test; it can still be deleted.
    expect(within(dead).queryByRole('switch')).toBeNull();
    expect(within(dead).queryByRole('button', { name: testLabel })).toBeNull();
    expect(within(dead).getByRole('button', { name: removeLabel })).toBeTruthy();
  });

  it('shows an empty state, and an error with a retry when the list cannot be loaded', async () => {
    const project = mockProject();
    const reachable = createMockFetch(project.backend, project.requests);
    let down = true;
    setFetchImplementation(async (input, init) =>
      down && String(input) === '/api/me/push'
        ? new Response('{}', { status: 500 })
        : reachable(String(input), init),
    );
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    expect(await screen.findByText(t('notifications.devices.loadFailed'))).toBeTruthy();
    down = false;
    fireEvent.click(screen.getByRole('button', { name: t('app.retry') }));
    expect(await screen.findByText(t('notifications.devices.empty'))).toBeTruthy();
  });

  it('pauses and resumes a device with its switch', async () => {
    const project = mockProject();
    project.backend.push.addDevice({ id: 'd1' });
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    const toggle = await screen.findByRole('switch', {
      name: t('notifications.devices.switchLabel', { name: 'Chrome · macOS' }),
    });
    fireEvent.click(toggle);
    expect(await screen.findByText(t('notifications.devices.pausedToast'))).toBeTruthy();
    expect(project.backend.push.devices[0]!.enabled).toBe(false);
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
    const row = toggle.closest('li')!;
    expect(row.textContent).toContain(t('notifications.devices.state.paused'));
    // A paused device is not tested.
    expect(within(row).queryByRole('button', { name: testLabel })).toBeNull();
    fireEvent.click(toggle);
    expect(await screen.findByText(t('notifications.devices.enabledToast'))).toBeTruthy();
    expect(project.backend.push.devices[0]!.enabled).toBe(true);
  });

  it('tests another device and reports a failed send on its row', async () => {
    const project = mockProject();
    project.backend.push.addDevice({ id: 'd1' });
    project.backend.push.nextResult = { result: 'failed', failure: 'rejected' };
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('notifications.devices.testLabel', { name: 'Chrome · macOS' }),
      }),
    );
    expect(await screen.findByText(t('notifications.devices.testFailed'))).toBeTruthy();
    const row = screen.getByText('Chrome · macOS').closest('li')!;
    expect(row.textContent).toContain(stateWord('failed'));
    expect(row.textContent).toContain(t('notifications.failure.rejected'));
  });

  it('says when a test is asked for too soon', async () => {
    const project = mockProject();
    project.backend.push.addDevice({ id: 'd1' });
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    const test = await screen.findByRole('button', {
      name: t('notifications.devices.testLabel', { name: 'Chrome · macOS' }),
    });
    fireEvent.click(test);
    await screen.findByText(t('notifications.devices.testOkOther'));
    await waitFor(() => expect((test as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(test);
    expect(await screen.findByText(codeMessage('web_push_test_too_soon')!)).toBeTruthy();
  });

  it('deletes a device only after a confirmation', async () => {
    const project = mockProject();
    project.backend.push.addDevice({ id: 'd1' });
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('notifications.devices.removeLabel', { name: 'Chrome · macOS' }),
      }),
    );
    expect(await screen.findByText(t('notifications.devices.removeTitle'))).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(1);
    // The safe choice has the focus: Enter alone must not delete anything.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('common.cancel') }));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    await waitFor(() => expect(screen.queryByText(t('notifications.devices.removeTitle'))).toBeNull());
    expect(project.backend.push.devices).toHaveLength(1);

    fireEvent.click(
      screen.getByRole('button', {
        name: t('notifications.devices.removeLabel', { name: 'Chrome · macOS' }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.devices.removeConfirm') }));
    expect(await screen.findByText(t('notifications.devices.removed'))).toBeTruthy();
    expect(project.backend.push.devices).toHaveLength(0);
    expect(await screen.findByText(t('notifications.devices.empty'))).toBeTruthy();
  });

  it('forgets the browser subscription when the deleted row was this device', async () => {
    const project = mockProject();
    subscribedHere(project);
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: t('notifications.devices.removeLabel', { name: 'Chrome · macOS' }),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('notifications.devices.removeConfirm') }));
    expect(await screen.findByText(t('notifications.off.title'))).toBeTruthy();
    expect(fakeBrowser.subscription).toBeNull();
  });
});

describe('kinds', () => {
  it('saves a kind at once with the other settings kept', async () => {
    const project = renderPage();
    const decision = await screen.findByRole('switch', {
      name: new RegExp(t('notifications.kinds.decision')),
    });
    fireEvent.click(decision);
    expect(await screen.findByText(t('notifications.kinds.saved'))).toBeTruthy();
    expect(project.backend.push.settings.categories).toEqual({
      question: true,
      decision: false,
      approval: true,
      permission: true,
      release: true,
      host_request: true,
    });
    expect(project.backend.push.settings.quietHours.enabled).toBe(false);
  });

  it('puts the switch back and says so when the save fails', async () => {
    const project = renderPage();
    const reachable = createMockFetch(project.backend, project.requests);
    setFetchImplementation(async (input, init) =>
      init?.method === 'PUT' ? new Response('{}', { status: 500 }) : reachable(String(input), init),
    );
    const release = await screen.findByRole('switch', { name: new RegExp(t('notifications.kinds.release')) });
    fireEvent.click(release);
    expect(await screen.findByText(t('notifications.kinds.saveFailed'))).toBeTruthy();
    await waitFor(() => expect((release as HTMLInputElement).checked).toBe(true));
    expect(project.backend.push.settings.categories.release).toBe(true);
  });
});

describe('quiet hours', () => {
  it('switches on with the default window and shows the live now line', async () => {
    const project = renderPage();
    fireEvent.click(
      await screen.findByRole('switch', { name: new RegExp(t('notifications.quiet.switchLabel')) }),
    );
    expect(await screen.findByLabelText(t('notifications.quiet.start'))).toBeTruthy();
    expect(project.backend.push.settings.quietHours).toMatchObject({
      enabled: true,
      start: '22:00',
      end: '07:00',
    });
    // The first time it goes on, the zone is the one of this device.
    expect(project.backend.push.settings.quietHours.timeZone).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    await waitFor(() => expect(document.querySelector('[class*="quietNow"]')?.textContent).toBeTruthy());
    // An overnight window names the next day.
    expect(screen.getByLabelText(t('notifications.quiet.endNextDay'))).toBeTruthy();
  });

  it('saves a new time and a new zone', async () => {
    const project = mockProject();
    project.backend.push.settings = {
      ...project.backend.push.settings,
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Europe/Budapest' },
    };
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    fireEvent.change(await screen.findByLabelText(t('notifications.quiet.start')), {
      target: { value: '23:30' },
    });
    await waitFor(() => expect(project.backend.push.settings.quietHours.start).toBe('23:30'));
    fireEvent.change(screen.getByLabelText(t('notifications.quiet.timeZone')), {
      target: { value: 'America/New_York' },
    });
    await waitFor(() => expect(project.backend.push.settings.quietHours.timeZone).toBe('America/New_York'));
    expect((await screen.findAllByText(t('notifications.quiet.saved'))).length).toBeGreaterThan(0);
  });

  it('refuses a window that starts and ends at the same time, without saving it', async () => {
    const project = mockProject();
    project.backend.push.settings = {
      ...project.backend.push.settings,
      quietHours: { enabled: true, start: '22:00', end: '07:00', timeZone: 'Europe/Budapest' },
    };
    project.render(
      <ToastProvider>
        <NotificationsPage />
      </ToastProvider>,
      '/p/AC/notifications',
    );
    const end = await screen.findByLabelText(t('notifications.quiet.endNextDay'));
    const putsBefore = project.requests.filter((r) => r.method === 'PUT').length;
    fireEvent.change(end, { target: { value: '22:00' } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(t('notifications.quiet.sameTime'));
    expect(end.getAttribute('aria-invalid')).toBe('true');
    expect(project.requests.filter((r) => r.method === 'PUT')).toHaveLength(putsBefore);
    expect(project.backend.push.settings.quietHours.end).toBe('07:00');
    // Fixing it saves.
    fireEvent.change(end, { target: { value: '06:00' } });
    await waitFor(() => expect(project.backend.push.settings.quietHours.end).toBe('06:00'));
    await waitFor(() => expect(screen.queryByText(t('notifications.quiet.sameTime'))).toBeNull());
  });
});
