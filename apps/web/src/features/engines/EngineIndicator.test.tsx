import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { EngineView } from '@projectman/shared';
import { applyServerEvent } from '../../api/cache';
import { setFetchImplementation } from '../../api/client';
import { MockBackend } from '../../mocks/backend';
import { t } from '../../i18n/t';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { EngineIndicator } from './EngineIndicator';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

function cloud(setup?: (backend: MockBackend) => void) {
  const backend = new MockBackend();
  backend.engineMode = 'cloud';
  setup?.(backend);
  return mockProject(backend);
}

describe('engine indicator', () => {
  it('shows nothing on a one-machine installation', async () => {
    const backend = new MockBackend();
    const project = mockProject(backend);
    project.render(<EngineIndicator />);
    await waitFor(() => expect(project.requests.some((r) => r.path === '/api/engines/status')).toBe(true));
    expect(screen.queryByRole('button', { name: /Motor/ })).toBeNull();
  });

  it('shows the default engine by name while it is connected', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio' });
      backend.setEngineOnline(engine.id, true);
    });
    project.render(<EngineIndicator />);
    const button = await screen.findByRole('button', {
      name: t('engines.labelOnline', { name: 'Mac Studio' }),
    });
    expect(button.textContent).toContain('Mac Studio');
    expect(button.textContent).not.toContain(t('engines.offlineSuffix'));
  });

  it('turns to a waiting state when the engine goes away and back when it returns', async () => {
    const backend = new MockBackend();
    backend.engineMode = 'cloud';
    const engine = backend.addEngine({ name: 'Mac Studio' });
    backend.setEngineOnline(engine.id, true);
    const project = mockProject(backend);
    const view = project.render(<EngineIndicator />);
    await screen.findByRole('button', { name: t('engines.labelOnline', { name: 'Mac Studio' }) });

    // The reload that follows the event reads the registry, so it changes first, as on the server.
    engine.online = false;
    act(() => {
      applyServerEvent(view.client, {
        type: 'engine_changed',
        engine: {
          id: engine.id,
          name: 'Mac Studio',
          isDefault: true,
          online: false,
          lastSeenAt: new Date().toISOString(),
        },
      });
    });
    const offline = await screen.findByRole('button', { name: /Mac Studio, nem elérhető/ });
    expect(offline.textContent).toContain(t('engines.offlineSuffix'));
    expect(screen.getByRole('status').textContent).toBe(t('engines.announceOffline', { name: 'Mac Studio' }));

    engine.online = true;
    act(() => {
      applyServerEvent(view.client, {
        type: 'engine_changed',
        engine: {
          id: engine.id,
          name: 'Mac Studio',
          isDefault: true,
          online: true,
          lastSeenAt: new Date().toISOString(),
        },
      });
    });
    await screen.findByRole('button', { name: t('engines.labelOnline', { name: 'Mac Studio' }) });
  });

  it('drops an engine another tab revoked from the list', async () => {
    const backend = new MockBackend();
    backend.engineMode = 'cloud';
    const main = backend.addEngine({ name: 'Mac Studio' });
    backend.setEngineOnline(main.id, true);
    const old = backend.addEngine({ name: 'Régi iMac', lastSeenAt: '2026-01-01T10:00:00.000Z' });
    const project = mockProject(backend);
    const view = project.render(<EngineIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: /Motor: Mac Studio/ }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(/Régi iMac/)).toBeTruthy();

    // The server announces a revoked engine with the ordinary change event, nothing on it says "revoked".
    old.revokedAt = new Date().toISOString();
    old.online = false;
    act(() => {
      applyServerEvent(view.client, {
        type: 'engine_changed',
        engine: { id: old.id, name: old.name, isDefault: false, online: false, lastSeenAt: old.lastSeenAt },
      });
    });
    await waitFor(() => expect(within(panel).queryByText(/Régi iMac/)).toBeNull());
    expect(within(panel).getByText(/Mac Studio/)).toBeTruthy();
  });

  it('says there is no engine and sends the owner to the settings', async () => {
    const project = cloud();
    project.render(<EngineIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: t('engines.labelNone') }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(t('engines.panelNone'))).toBeTruthy();
    const link = within(panel).getByRole('link', { name: t('engines.panelAddEngine') });
    expect(link.getAttribute('href')).toBe('/p/AC/settings/engines');
  });

  it('lists the engines in the panel and gives the owner the work that waits for them', async () => {
    const project = cloud((backend) => {
      const main = backend.addEngine({
        name: 'Mac Studio',
        runningSessions: 2,
        waitingStarts: 3,
        waitingMessages: 1,
      });
      backend.setEngineOnline(main.id, true);
      backend.addEngine({ name: 'Linux box', lastSeenAt: '2026-01-01T10:00:00.000Z' });
    });
    project.render(<EngineIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: /Motor: Mac Studio/ }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText(t('engines.online'))).toBeTruthy();
    expect(within(panel).getByText(t('engines.defaultChip'))).toBeTruthy();
    expect(within(panel).getByText(/Linux box/)).toBeTruthy();
    expect(await within(panel).findByText(/2 munkamenet fut · 3 indítás és 1 üzenet vár rá/)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: t('engines.panelManage') })).toBeTruthy();
  });

  describe('a viewer who is not the host owner (PM-1093)', () => {
    /** A friend's project: the host's global default exists, the friend's own machine may be bound. */
    function friend(setup: (backend: MockBackend, own: EngineView) => void) {
      const backend = new MockBackend();
      backend.engineMode = 'cloud';
      backend.user = { ...backend.user, userId: 'usr_friend' };
      const global = backend.addEngine({ name: 'Host Mac' });
      backend.setEngineOnline(global.id, true);
      const own = backend.addEngine({ name: 'Friend Mac', createdBy: 'usr_friend', isDefault: false });
      setup(backend, own);
      return mockProject(backend);
    }
    const bind = (backend: MockBackend, own: EngineView) =>
      backend.projectEngineBindings.set('AC', [{ engineId: own.id, isDefault: true }]);

    it("shows the project's own engine quietly, with the owner's links and counts", async () => {
      const project = friend((backend, own) => {
        backend.setEngineOnline(own.id, true);
        own.runningSessions = 1;
        bind(backend, own);
      });
      project.render(<EngineIndicator />);
      const button = await screen.findByRole('button', {
        name: t('engines.labelOnline', { name: 'Friend Mac' }),
      });
      expect(button.getAttribute('data-state')).toBe('online');
      fireEvent.click(button);
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText(t('engines.defaultChip')).parentElement?.textContent).toContain(
        'Friend Mac',
      );
      expect(await within(panel).findByText(/1 munkamenet fut/)).toBeTruthy();
      expect(within(panel).getByRole('link', { name: t('engines.panelManage') })).toBeTruthy();
    });

    /** The host's global default is not the friend's to use; nothing is bound. */
    const unbound = (backend: MockBackend) => {
      backend.engines[0]!.isDefault = false;
    };

    it('warns the owner when the project has no engine and points to the settings', async () => {
      const project = friend(unbound);
      project.render(<EngineIndicator />);
      const button = await screen.findByRole('button', { name: t('engines.labelNoProjectEngine') });
      expect(button.getAttribute('data-state')).toBe('none');
      fireEvent.click(button);
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText(new RegExp(t('engines.panelBindOwner')))).toBeTruthy();
      expect(
        within(panel)
          .getByRole('link', { name: t('engines.panelManage') })
          .getAttribute('href'),
      ).toBe('/p/AC/settings/engines');
    });

    it('gives a member who is not an owner the hint without a link', async () => {
      const project = friend(unbound);
      project.render(<EngineIndicator />, '/', { isOwner: false });
      fireEvent.click(await screen.findByRole('button', { name: t('engines.labelNoProjectEngine') }));
      const panel = await screen.findByRole('dialog');
      expect(within(panel).getByText(new RegExp(t('engines.panelBindMember')))).toBeTruthy();
      expect(within(panel).queryByRole('link')).toBeNull();
    });
  });

  it('falls back to the global default when an older server sends no project engines', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio', isDefault: false });
      backend.setEngineOnline(engine.id, true);
    });
    const answer = createMockFetch(project.backend);
    setFetchImplementation(async (path, init) => {
      const response = await answer(path, init);
      if (path !== '/api/engines/status') return response;
      const { projectEngines: _newer, ...older } = await response.json();
      return Response.json(older);
    });
    project.render(<EngineIndicator />);
    expect(await screen.findByRole('button', { name: t('engines.labelNoDefault') })).toBeTruthy();
  });

  it('shows the engine to a client member like to any other member (PM-79)', async () => {
    const backend = new MockBackend();
    backend.engineMode = 'cloud';
    backend.viewerHandle = 'kata';
    backend.user = { ...backend.user, userId: 'usr_client' };
    const engine = backend.addEngine({ name: 'Mac Studio' });
    backend.setEngineOnline(engine.id, true);
    const project = mockProject(backend);
    project.render(<EngineIndicator />);
    expect(
      await screen.findByRole('button', { name: t('engines.labelOnline', { name: 'Mac Studio' }) }),
    ).toBeTruthy();
    expect(project.requests.some((r) => r.path.startsWith('/api/engines'))).toBe(true);
  });
});
