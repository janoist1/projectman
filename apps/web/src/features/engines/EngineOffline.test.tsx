import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { MockBackend } from '../../mocks/backend';
import { t } from '../../i18n/t';
import { mockProject } from '../../test/mockProject';
import { MachineIndicator } from '../machine/MachineIndicator';
import { SessionPage } from '../session/SessionPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const sessionRoute = (
  <Routes>
    <Route path="/sessions/:sessionId" element={<SessionPage />} />
  </Routes>
);

function cloud(setup?: (backend: MockBackend) => void) {
  const backend = new MockBackend();
  backend.engineMode = 'cloud';
  setup?.(backend);
  return mockProject(backend);
}

describe('a session while its engine is offline', () => {
  it('waits quietly instead of failing, and still takes a message', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio' });
      backend.setEngineOnline(engine.id, false);
      backend.sessionErrors.set('ses_ac21_fe1', 'engine_offline');
    });
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    expect(await screen.findByRole('heading', { name: t('engines.chatOfflineTitle') })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(t('engines.composerNote'))).toBeTruthy();
    expect(screen.getByRole('textbox')).toBeTruthy();
    // The way back stays, and the answer is asked for once: an engine that is away does not answer sooner.
    const crumbs = screen.getByRole('navigation', { name: t('session.breadcrumb') });
    expect(within(crumbs).getByRole('link', { name: t('nav.board') })).toBeTruthy();
    expect(project.requests.filter((r) => r.path.endsWith('/sessions/ses_ac21_fe1')).length).toBe(1);
  });

  it('names the engine in the header of a running session in cloud mode only', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio' });
      backend.setEngineOnline(engine.id, true);
      const session = backend.sessions.find((s) => s.id === 'ses_ac21_fe1')!;
      session.engineId = engine.id;
    });
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    expect(await screen.findByText(t('engines.chatEngine', { name: 'Mac Studio' }))).toBeTruthy();
  });

  it('shows no engine in the header on a one-machine installation', async () => {
    const backend = new MockBackend();
    const session = backend.sessions.find((s) => s.id === 'ses_ac21_fe1')!;
    session.engineId = 'eng_abcdefghijkl';
    const project = mockProject(backend);
    project.render(sessionRoute, '/sessions/ses_ac21_fe1');
    await screen.findByRole('button', { name: t('common.moreActions') });
    expect(screen.queryByText(/^Motor: /)).toBeNull();
  });
});

describe('the machine panel while the engine is offline', () => {
  it('says the engine is away, with its name, and offers no retry', async () => {
    const project = cloud((backend) => {
      const engine = backend.addEngine({ name: 'Mac Studio', lastSeenAt: '2026-10-01T10:00:00.000Z' });
      backend.setEngineOnline(engine.id, false);
      backend.machineError = 'engine_offline';
    });
    project.render(<MachineIndicator />);
    fireEvent.click(await screen.findByRole('button', { name: /Gép/ }));
    const panel = await screen.findByRole('dialog');
    await waitFor(() => expect(within(panel).getByText(t('machine.engineOfflineTitle'))).toBeTruthy());
    expect(within(panel).getByText(t('machine.engineOfflineBody'), { exact: false })).toBeTruthy();
    expect(
      within(panel).getByText(t('machine.engineName', { name: 'Mac Studio' }), { exact: false }),
    ).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: t('app.retry') })).toBeNull();
  });
});
