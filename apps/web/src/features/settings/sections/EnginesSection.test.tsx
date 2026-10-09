import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { applyServerEvent } from '../../../api/cache';
import { setFetchImplementation } from '../../../api/client';
import { MockBackend } from '../../../mocks/backend';
import { ToastContext } from '../../../components/toastContext';
import { t } from '../../../i18n/t';
import { mockProject } from '../../../test/mockProject';
import { SettingsTestRoutes } from '../testRoutes';
import { EnginesSection } from './EnginesSection';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function cloud(setup?: (backend: MockBackend) => void) {
  const backend = new MockBackend();
  backend.engineMode = 'cloud';
  setup?.(backend);
  return mockProject(backend);
}

const key = (backend: MockBackend) => backend.lastEngineKey ?? '';

/** The section with the toasts it shows collected, so a test can read them. */
function renderSection(project: ReturnType<typeof cloud>) {
  const toasts: string[] = [];
  const view = project.render(
    <ToastContext.Provider value={{ show: (message) => void toasts.push(message) }}>
      <EnginesSection />
    </ToastContext.Provider>,
  );
  return { ...view, toasts };
}

describe('engines settings', () => {
  it('offers the first engine when there is none', async () => {
    const project = cloud();
    project.render(<EnginesSection />);
    await screen.findByText(t('engines.emptyTitle'));
    fireEvent.click(screen.getByRole('button', { name: t('engines.newEngine') }));
    expect(await screen.findByRole('dialog', { name: t('engines.newTitle') })).toBeTruthy();
  });

  it('creates an engine, shows its key once and keeps it out of the cache', async () => {
    const project = cloud();
    const view = project.render(<EnginesSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('engines.newEngine') }));
    const dialog = await screen.findByRole('dialog', { name: t('engines.newTitle') });
    const create = within(dialog).getByRole('button', { name: t('engines.create') });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(t('engines.nameLabel')), {
      target: { value: '  Mac Studio ' },
    });
    fireEvent.click(create);

    const keyDialog = await screen.findByRole('dialog', {
      name: t('engines.keyTitle', { name: 'Mac Studio' }),
    });
    const secret = key(project.backend);
    expect(secret).not.toBe('');
    expect(within(keyDialog).getByLabelText(t('engines.keyAria')).textContent).toBe(secret);
    expect(within(keyDialog).getByLabelText(t('engines.commandAria')).textContent).toMatch(
      /^npm run engine -- init --cloud \S+ --id eng_/,
    );
    expect(within(keyDialog).getByLabelText(t('engines.commandAria')).textContent).not.toContain(secret);
    expect(project.requests.find((r) => r.method === 'POST' && r.path === '/api/engines')?.body).toEqual({
      name: 'Mac Studio',
    });
    // The key is nowhere in the query or mutation cache.
    const cached = JSON.stringify([
      view.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
      view.client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
    ]);
    expect(cached).not.toContain(secret);

    fireEvent.click(within(keyDialog).getByRole('button', { name: t('engines.keyDone') }));
    await waitFor(() => expect(screen.queryByText(secret)).toBeNull());
    expect(await screen.findByText('Mac Studio')).toBeTruthy();
    expect(screen.getByText(t('engines.defaultChipCap'))).toBeTruthy();
    expect(screen.getByText(t('engines.neverSeen'))).toBeTruthy();
  });

  it('names the login the owner needs when the server asks for it', async () => {
    const project = cloud();
    project.backend.engineLoginRequired = true;
    project.render(<EnginesSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('engines.newEngine') }));
    const dialog = await screen.findByRole('dialog', { name: t('engines.newTitle') });
    fireEvent.change(within(dialog).getByLabelText(t('engines.nameLabel')), { target: { value: 'Mac' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t('engines.create') }));
    expect(
      await within(dialog).findByText(
        t('errors.ownerLoginRequiredIn', { what: t('errors.ownerLoginRequiredCategory.engines') }),
      ),
    ).toBeTruthy();
  });

  it('lists what the engine reported and what waits for it', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({
        name: 'Mac Studio',
        lastSeenAt: '2026-10-01T10:00:00.000Z',
        lastSeenIp: '10.0.0.5',
        hostname: 'studio.local',
        platform: 'darwin',
        version: '1.4.0',
        versionMismatch: true,
        providers: [
          { provider: 'claude', available: true, version: '2.1.0' },
          { provider: 'codex', available: false, version: null },
        ],
        runningSessions: 2,
        waitingStarts: 3,
        waitingMessages: 1,
      });
      backend.setEngineOnline(engine.id, true);
    });
    project.render(<EnginesSection />);
    const row = (await screen.findByText('Mac Studio')).closest('li')!;
    const scope = within(row);
    expect(scope.getByText(t('engines.online'), { exact: false }).textContent).toContain('10.0.0.5');
    expect(scope.getByText(/studio\.local · macOS · v1\.4\.0/)).toBeTruthy();
    expect(scope.getByText(t('engines.mismatch'))).toBeTruthy();
    expect(scope.getByText(/Claude 2\.1\.0/)).toBeTruthy();
    expect(scope.getByText(/Codex · nincs/)).toBeTruthy();
    expect(scope.getByText(/2 munkamenet fut · 3 indítás és 1 üzenet vár rá/)).toBeTruthy();
  });

  it('makes another engine the default and says so', async () => {
    const project = cloud((backend) => {
      backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z' });
      backend.addEngine({ name: 'Linux box', lastSeenAt: '2026-10-01T10:00:00.000Z' });
    });
    const view = renderSection(project);
    const row = (await screen.findByText('Linux box')).closest('li')!;
    fireEvent.click(
      within(row).getByRole('button', { name: t('engines.rowActions', { name: 'Linux box' }) }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('engines.makeDefault') }));
    await waitFor(() => expect(view.toasts).toContain(t('engines.defaultSet', { name: 'Linux box' })));
    await waitFor(() => {
      const first = screen.getAllByRole('listitem').find((item) => item.textContent?.includes('Linux box'));
      expect(first?.textContent).toContain(t('engines.defaultChipCap'));
    });
  });

  it('revokes only after the confirmation and moves the engine to the revoked ones', async () => {
    const project = cloud((backend) => {
      backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z', runningSessions: 2 });
    });
    const view = renderSection(project);
    const row = (await screen.findByText('Mac Studio')).closest('li')!;
    fireEvent.click(
      within(row).getByRole('button', { name: t('engines.rowActions', { name: 'Mac Studio' }) }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('engines.revoke') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('engines.revokeTitle', { name: 'Mac Studio' }),
    });
    expect(within(dialog).getByText(t('engines.revokeRunning', { count: 2 }))).toBeTruthy();
    expect(within(dialog).getByText(t('engines.revokeDefault'))).toBeTruthy();
    expect(project.requests.some((r) => r.path.endsWith('/revoke'))).toBe(false);

    fireEvent.click(within(dialog).getByRole('button', { name: t('engines.revokeConfirm') }));
    await waitFor(() => expect(view.toasts).toContain(t('engines.revoked', { name: 'Mac Studio' })));
    expect(await screen.findByText(t('engines.revokedFold', { count: 1 }))).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: t('engines.rowActions', { name: 'Mac Studio' }) }),
    ).toBeNull();
  });

  it('tells the owner when the engine was revoked meanwhile', async () => {
    const project = cloud((backend) => {
      backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z' });
    });
    project.render(<EnginesSection />);
    const row = (await screen.findByText('Mac Studio')).closest('li')!;
    fireEvent.click(
      within(row).getByRole('button', { name: t('engines.rowActions', { name: 'Mac Studio' }) }),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('engines.revoke') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('engines.revokeTitle', { name: 'Mac Studio' }),
    });
    project.backend.engines[0]!.revokedAt = '2026-10-02T10:00:00.000Z';
    fireEvent.click(within(dialog).getByRole('button', { name: t('engines.revokeConfirm') }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: t('engines.revokeConfirm') })).toBeNull();
  });

  it('shows the setup command of an engine that has not connected, without its key', async () => {
    const project = cloud((backend) => {
      backend.addEngine({ name: 'Mac Studio' });
    });
    project.render(<EnginesSection />);
    fireEvent.click(await screen.findByRole('button', { name: t('engines.showCommand') }));
    const dialog = await screen.findByRole('dialog', {
      name: t('engines.commandTitle', { name: 'Mac Studio' }),
    });
    expect(within(dialog).getByLabelText(t('engines.commandAria')).textContent).toMatch(/init --cloud/);
    expect(within(dialog).getByText(t('engines.commandKeyGone'))).toBeTruthy();
  });

  it('warns when there is no default engine', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z' });
      engine.isDefault = false;
    });
    project.render(<EnginesSection />);
    expect(await screen.findByText(t('engines.noDefaultHint'))).toBeTruthy();
  });

  it('follows a connection that arrives while the page is open', async () => {
    const project = cloud((backend) => {
      backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z' });
    });
    const view = project.render(<EnginesSection />);
    await screen.findByText(t('engines.offlineSeen', { ago: '' }).split('·')[0]!.trim(), { exact: false });
    const engine = project.backend.engines[0]!;
    engine.online = true;
    act(() => {
      applyServerEvent(view.client, {
        type: 'engine_changed',
        engine: {
          id: engine.id,
          name: engine.name,
          isDefault: true,
          online: true,
          lastSeenAt: new Date().toISOString(),
        },
      });
    });
    expect(await screen.findByText(t('engines.online'))).toBeTruthy();
  });
});

describe('engines in the settings page', () => {
  it('shows the section to the host owner in cloud mode only', async () => {
    const project = cloud();
    project.context.me.hostOwner = true;
    project.render(<SettingsTestRoutes initialSection="engines" />);
    expect(await screen.findByRole('heading', { name: t('engines.settingsTitle') })).toBeTruthy();
  });

  it('lists the section among the settings sections for the host owner', async () => {
    const project = cloud();
    project.context.me.hostOwner = true;
    project.render(<SettingsTestRoutes />, '/p/AC/settings');
    const nav = await screen.findByRole('navigation', { name: t('settings.nav.label') });
    expect(
      await within(nav).findByRole('link', { name: new RegExp(t('settings.nav.engines')) }),
    ).toBeTruthy();
  });

  it('leaves the section out on a one-machine installation', async () => {
    const project = mockProject();
    project.context.me.hostOwner = true;
    project.render(<SettingsTestRoutes initialSection="engines" />);
    const nav = await screen.findByRole('navigation', { name: t('settings.nav.label') });
    expect(within(nav).queryByRole('link', { name: new RegExp(t('settings.nav.engines')) })).toBeNull();
    expect(screen.queryByRole('heading', { name: t('engines.settingsTitle') })).toBeNull();
  });
});
