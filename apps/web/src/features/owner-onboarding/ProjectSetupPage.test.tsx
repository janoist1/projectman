import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { ProjectSetupPage } from './ProjectSetupPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const OWNER = { userId: 'usr_owner2', name: 'Eszter', email: 'eszter@owner.test' };

function renderSetup(state: unknown, held = false) {
  const backend = new MockBackend();
  backend.user = OWNER;
  backend.viewerHandle = '';
  backend.ownerAccountIds.add(OWNER.userId);
  backend.engineMode = 'cloud';
  const engine = backend.addEngine({ name: 'Laptop', createdBy: OWNER.userId, online: true });
  const created = backend.handle('POST', '/api/projects', {
    key: 'SHOP',
    name: 'Shop',
    workspacePath: "/work/Eszter's shop",
    engineId: engine.id,
  });
  expect(created.status).toBe(200);
  if (held) backend.engineHolds.add(`SHOP/${engine.id}`);
  const project = mockProject(backend);
  project.render(
    <Routes>
      <Route path="/welcome/:projectKey" element={<ProjectSetupPage />} />
    </Routes>,
    { pathname: '/welcome/SHOP', state },
  );
  return { backend, engine, project };
}

beforeEach(() => window.localStorage.clear());

it('shows the command for the folder of the wizard, quoted, and waits for the machine to hold it', async () => {
  renderSetup({ folder: "/work/Eszter's shop" });
  const command = await screen.findByText((text) => text.includes('project set SHOP'));
  expect(command.textContent).toContain(`'/work/Eszter'\\''s shop'`);
  expect(command.textContent).toContain('/projectman-engine" project set');
  expect(command.textContent).toMatch(/service restart$/);
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('waiting');
});

it('shows the checkout command once the checkout install is chosen, for the repos as well', async () => {
  renderSetup({ folder: '/work/shop', repos: [{ name: 'web', path: './web' }] });
  fireEvent.click(await screen.findByRole('radio', { name: t('engines.mode.checkout') }));
  const command = await screen.findByText((text) => text.startsWith('npm run engine -- project set SHOP'));
  expect(command.textContent).toMatch(/service install$/);
  expect(screen.getByText((text) => text.startsWith('npm run engine -- repo add SHOP web'))).toBeTruthy();
});

it('switches to running once the machine reports that it holds the project', async () => {
  renderSetup({ folder: '/work/shop' }, true);
  await waitFor(() => expect(screen.getByRole('status').getAttribute('data-state')).toBe('ok'));
});

it('asks for the folder when the page was opened without the wizard state', async () => {
  renderSetup(undefined);
  expect(await screen.findByLabelText(t('projects.create.workspace'))).toBeTruthy();
  expect(screen.queryByText((text) => text.includes('project set'))).toBeNull();
});
