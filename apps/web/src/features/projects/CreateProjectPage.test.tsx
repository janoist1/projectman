import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation } from 'react-router';
import { afterEach, expect, it } from 'vitest';
import type { CreateProjectRequest } from '@projectman/shared';
import { setFetchImplementation } from '../../api/client';
import { MeContext } from '../../app/contexts';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { createMockFetch, mockProject } from '../../test/mockProject';
import { CreateProjectPage } from './CreateProjectPage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));
function CreatedProjectProbe() {
  const location = useLocation();
  return (
    <output data-testid="created-project">
      {JSON.stringify({ path: location.pathname, state: location.state })}
    </output>
  );
}

function renderForm(project = mockProject(), route = '/projects/new') {
  project.render(
    <MeContext.Provider value={project.context.me}>
      <Routes>
        <Route path="/projects/new" element={<CreateProjectPage />} />
        <Route path="/p/:projectKey" element={<CreatedProjectProbe />} />
        <Route path="/welcome/:projectKey" element={<CreatedProjectProbe />} />
        <Route path="/welcome" element={<CreatedProjectProbe />} />
      </Routes>
    </MeContext.Provider>,
    route,
  );
  return project;
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: t('projects.create.submit') }));
const creates = (project: ReturnType<typeof mockProject>) =>
  project.requests.filter((request) => request.method === 'POST' && request.path === '/api/projects');
function fill() {
  fireEvent.change(screen.getByLabelText(t('projects.create.name')), { target: { value: 'Acme Web' } });
  fireEvent.change(screen.getByLabelText(t('projects.create.workspace')), {
    target: { value: '/work/acme' },
  });
}
async function ready() {
  await waitFor(() =>
    expect(
      screen.getByRole('group', { name: t('projects.create.providerLegend') }).getAttribute('aria-busy'),
    ).toBe('false'),
  );
}

it('shows provider status and login instructions and defaults to the first ready provider', async () => {
  const project = mockProject();
  project.backend.providerStatus.claude = { loggedIn: false, problem: 'not_logged_in' };
  renderForm(project);
  await ready();
  expect(screen.getByText('claude auth login')).toBeTruthy();
  expect((screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement).checked).toBe(true);
});

it('submits the chosen provider, language, suggested key and repos without a template or mover', async () => {
  const project = renderForm();
  await ready();
  fill();
  fireEvent.change(screen.getByLabelText(t('projects.create.language')), { target: { value: 'en' } });
  fireEvent.click(screen.getByRole('radio', { name: 'Gemini' }));
  fireEvent.click(screen.getByRole('button', { name: t('projects.create.addRepo') }));
  const group = screen.getByRole('group', { name: t('projects.create.repoLabel', { index: 1 }) });
  fireEvent.change(group.querySelectorAll('input')[0]!, { target: { value: 'app' } });
  fireEvent.change(group.querySelectorAll('input')[1]!, { target: { value: '.' } });
  submit();
  await waitFor(() => expect(creates(project)).toHaveLength(1));
  expect(creates(project)[0]!.body as CreateProjectRequest).toEqual({
    key: 'AW',
    name: 'Acme Web',
    workspacePath: '/work/acme',
    language: 'en',
    provider: 'gemini',
    repos: [{ name: 'app', path: '.', defaultBranch: 'main' }],
  });
  expect(JSON.parse((await screen.findByTestId('created-project')).textContent!)).toEqual({
    path: '/p/AW',
    state: { operatorChecklist: true },
  });
});

it('refetches on demand and preserves a manual selection', async () => {
  const project = renderForm();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: 'Codex' }));
  project.backend.providerStatus.codex = { loggedIn: false, problem: 'not_logged_in' };
  fireEvent.click(screen.getByRole('button', { name: t('projects.create.recheck') }));
  await screen.findByText('codex login');
  expect((screen.getByRole('radio', { name: 'Codex' }) as HTMLInputElement).checked).toBe(true);
  expect(project.requests.filter((request) => request.path === '/api/providers')).toHaveLength(2);
  expect(screen.getByRole('note')).toBeTruthy();
});

it('keeps the recheck button focused and blocks duplicate requests while refreshing', async () => {
  const project = renderForm();
  await ready();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fetch = createMockFetch(project.backend, project.requests);
  setFetchImplementation(async (path, init) => {
    if (path === '/api/providers') await pending;
    return fetch(path, init);
  });
  const button = screen.getByRole('button', { name: t('projects.create.recheck') });
  button.focus();
  fireEvent.click(button);
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBe('true'));
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(document.activeElement).toBe(button);
  fireEvent.click(button);
  release();
  await waitFor(() => expect(button.getAttribute('aria-busy')).toBeNull());
  expect(project.requests.filter((request) => request.path === '/api/providers')).toHaveLength(2);
});

it.each(['cli_missing', 'cli_too_old'] as const)(
  'explains the %s provider setup problem',
  async (problem) => {
    const project = mockProject();
    project.backend.providerStatus.gemini = {
      loggedIn: false,
      problem,
      cliVersion: '1.0.0',
      minCliVersion: '2.0.0',
    };
    renderForm(project);
    await ready();
    expect(
      screen.getByText(
        t(problem === 'cli_missing' ? 'projects.create.cliMissing' : 'projects.create.cliTooOld'),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        problem === 'cli_missing'
          ? t('projects.create.installProvider', { cli: t('projects.create.cliNames.gemini') })
          : t('projects.create.updateProvider', {
              cli: t('projects.create.cliNames.gemini'),
              cliVersion: '1.0.0',
              minCliVersion: '2.0.0',
            }),
      ),
    ).toBeTruthy();
  },
);

it('warns when none are ready while still allowing creation', async () => {
  const project = mockProject();
  for (const provider of ['claude', 'codex', 'gemini', 'nanogpt'] as const)
    project.backend.providerStatus[provider] = { loggedIn: false, problem: 'not_logged_in' };
  renderForm(project);
  await ready();
  expect(screen.getByRole('note')).toBeTruthy();
  fill();
  submit();
  await waitFor(() => expect(creates(project)).toHaveLength(1));
});

it('blocks submission only during the first provider check', async () => {
  const project = mockProject();
  const fetch = createMockFetch(project.backend, project.requests);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  setFetchImplementation(async (path, init) => {
    if (path === '/api/providers') await pending;
    return fetch(path, init);
  });
  renderForm(project);
  fill();
  submit();
  expect(creates(project)).toHaveLength(0);
  expect(
    screen.getByRole('button', { name: t('projects.create.submit') }).getAttribute('aria-disabled'),
  ).toBe('true');
  release();
  await ready();
});

it('allows creation when provider lookup fails without a not-ready warning', async () => {
  const project = mockProject();
  project.backend.providersFail = true;
  renderForm(project);
  await ready();
  expect(screen.getByText(t('projects.create.providersError'))).toBeTruthy();
  expect(screen.queryByRole('note')).toBeNull();
  fill();
  submit();
  await waitFor(() => expect(creates(project)).toHaveLength(1));
});

it('focuses the first invalid field on submit', async () => {
  renderForm();
  await ready();
  submit();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText(t('projects.create.name'))));
  expect(screen.getByText(t('projects.validation.workspaceRequired'))).toBeTruthy();
});

it('shows workspace_not_found under the field and focuses it', async () => {
  const project = mockProject();
  const fetch = createMockFetch(project.backend, project.requests);
  setFetchImplementation(async (path, init) =>
    path === '/api/projects' && init?.method === 'POST'
      ? new Response(
          JSON.stringify({ error: { code: 'workspace_not_found', message: 'Missing workspace' } }),
          { status: 400 },
        )
      : fetch(path, init),
  );
  renderForm(project);
  await ready();
  fill();
  submit();
  await screen.findByText(t('errors.codes.workspace_not_found'));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByLabelText(t('projects.create.workspace'))),
  );
});

const OWNER = { userId: 'usr_owner2', name: 'Eszter', email: 'eszter@owner.test' };
/** A signed-in owner account (PM-1062) with a connected machine of its own that has a provider login. */
function ownerProject() {
  const backend = new MockBackend();
  backend.user = OWNER;
  backend.viewerHandle = '';
  backend.ownerAccountIds.add(OWNER.userId);
  backend.engineMode = 'cloud';
  const laptop = backend.addEngine({ name: 'Laptop', createdBy: OWNER.userId, online: true });
  backend.engineProviderLogins.set(laptop.id, { claude: true });
  return { project: mockProject(backend), backend, laptop };
}

it('creates a project on the preselected machine of an owner account and goes on to its set-up page', async () => {
  const { project, laptop } = ownerProject();
  renderForm(project, `/projects/new?engine=${laptop.id}`);
  await ready();
  expect(((await screen.findByRole('radio', { name: /Laptop/ })) as HTMLInputElement).checked).toBe(true);
  // The providers are those of the chosen machine, and the page says so instead of naming the server.
  expect(screen.getByText(t('projects.create.providersHelpMachine', { machine: 'Laptop' }))).toBeTruthy();
  fill();
  submit();
  const probe = await screen.findByTestId('created-project');
  expect(creates(project)[0]?.body).toMatchObject({ engineId: laptop.id, workspacePath: '/work/acme' });
  expect(JSON.parse(probe.textContent ?? '')).toMatchObject({
    path: '/welcome/AW',
    state: { folder: '/work/acme' },
  });
});

it('lists only connected machines of the owner as choices and names the machine in a missing folder', async () => {
  const { project, backend, laptop } = ownerProject();
  backend.addEngine({ name: 'Old PC', createdBy: OWNER.userId });
  backend.addEngine({ name: 'Foreign', createdBy: 'usr_other', online: true });
  backend.missingWorkspaces.add('/work/acme');
  renderForm(project, `/projects/new?engine=${laptop.id}`);
  await ready();
  expect(((await screen.findByRole('radio', { name: /Old PC/ })) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('radio', { name: /Foreign/ })).toBeNull();
  fill();
  submit();
  await screen.findByText(t('projects.create.workspaceNotOnEngine', { machine: 'Laptop' }));
});

it('blocks an owner account without a connected machine and points to the first steps', async () => {
  const { project, backend, laptop } = ownerProject();
  backend.setEngineOnline(laptop.id, false);
  renderForm(project);
  const link = await screen.findByRole('link', { name: t('projects.create.connectEngine') });
  expect(link.getAttribute('href')).toBe('/welcome');
  fill();
  submit();
  expect(creates(project)).toHaveLength(0);
});

it.each([
  ['one machine', 1, false],
  ['several machines', 2, true],
])('shows the machine choice to the host in cloud mode only with %s', async (_name, count, shown) => {
  const project = mockProject();
  project.backend.engineMode = 'cloud';
  for (let n = 0; n < count; n += 1)
    project.backend.addEngine({ name: `Host ${n}`, createdBy: project.backend.user.userId, online: true });
  renderForm(project);
  await ready();
  const choice = () => screen.queryByRole('group', { name: t('projects.create.engineLegend') });
  if (shown) {
    await waitFor(() => expect(choice()).not.toBeNull());
    return;
  }
  // The list of machines is read before the choice is decided; wait for the answer, then check.
  await waitFor(() => expect(project.requests.some((request) => request.path === '/api/engines')).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(choice()).toBeNull();
});

it('saves a NanoGPT key, refreshes status and returns focus to its radio', async () => {
  renderForm();
  await ready();
  fireEvent.click(screen.getByRole('radio', { name: 'NanoGPT' }));
  fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.add') }));
  fireEvent.change(screen.getByLabelText(t('nanogptKey.field')), { target: { value: 'test-key' } });
  fireEvent.click(screen.getByRole('button', { name: t('nanogptKey.save') }));
  await screen.findByText(t('providerSettings.nanogptSet'));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'NanoGPT' })));
});
