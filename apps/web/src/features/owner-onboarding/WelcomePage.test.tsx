import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setFetchImplementation } from '../../api/client';
import { t } from '../../i18n/t';
import { MockBackend } from '../../mocks/backend';
import { mockProject } from '../../test/mockProject';
import { assistantInstruction } from './EngineSetupGuide';
import { WelcomePage } from './WelcomePage';

afterEach(() => setFetchImplementation((input, init) => globalThis.fetch(input, init)));

const OWNER = { userId: 'usr_owner2', name: 'Eszter', email: 'eszter@owner.test' };

/** A signed-in owner account (PM-1062): no project yet, machines of its own only. */
function ownerBackend() {
  const backend = new MockBackend();
  backend.user = OWNER;
  backend.viewerHandle = '';
  backend.ownerAccountIds.add(OWNER.userId);
  backend.engineMode = 'cloud';
  return backend;
}
function renderWelcome(backend: MockBackend) {
  const project = mockProject(backend);
  project.render(
    <Routes>
      <Route path="/welcome" element={<WelcomePage />} />
    </Routes>,
    '/welcome',
  );
  return project;
}
const stepOf = (name: string) => screen.getByText(name).closest('li');

describe('the step the server state puts the owner at', () => {
  it.each([
    ['no machine yet', 1, () => undefined],
    [
      'a machine that has not connected',
      2,
      (b: MockBackend) => b.addEngine({ name: 'Laptop', createdBy: OWNER.userId }),
    ],
    [
      'a connected machine without a login',
      3,
      (b: MockBackend) => b.addEngine({ name: 'Laptop', createdBy: OWNER.userId, online: true }),
    ],
    [
      'a connected machine with a login',
      4,
      (b: MockBackend) => {
        const engine = b.addEngine({ name: 'Laptop', createdBy: OWNER.userId, online: true });
        b.engineProviderLogins.set(engine.id, { claude: true });
      },
    ],
  ] as const)('%s opens step %i', async (_name, step, setup) => {
    const backend = ownerBackend();
    setup(backend);
    renderWelcome(backend);
    const titles = [1, 2, 3, 4].map((n) => t(`ownerOnboarding.welcome.step${n as 1 | 2 | 3 | 4}`));
    await waitFor(() => expect(stepOf(titles[step - 1]!)?.getAttribute('aria-current')).toBe('step'));
    expect(
      screen.getAllByRole('listitem').filter((item) => item.getAttribute('aria-current') === 'step'),
    ).toHaveLength(1);
  });

  it('offers the first project on the connected machine once it is ready', async () => {
    const backend = ownerBackend();
    const engine = backend.addEngine({ name: 'Laptop', createdBy: OWNER.userId, online: true });
    backend.engineProviderLogins.set(engine.id, { codex: true });
    renderWelcome(backend);
    const link = await screen.findByRole('link', { name: t('ownerOnboarding.welcome.createProject') });
    expect(link.getAttribute('href')).toBe(`/projects/new?engine=${engine.id}`);
  });
});

describe('connecting the first machine', () => {
  it('creates the machine by its name and shows its key once, but not in the assistant text', async () => {
    const backend = ownerBackend();
    const project = renderWelcome(backend);
    fireEvent.change(await screen.findByLabelText(t('ownerOnboarding.welcome.nameLabel')), {
      target: { value: 'Eszter Mac' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('ownerOnboarding.welcome.createKey') }));
    const key = await screen.findByText((text) => text.startsWith('pme_'));
    expect(key.textContent).toBe(backend.lastEngineKey);
    expect(
      project.requests.filter((request) => request.method === 'POST' && request.path === '/api/engines'),
    ).toHaveLength(1);
    expect(
      project.requests.find((request) => request.path === '/api/engines' && request.method === 'POST')?.body,
    ).toEqual({
      name: 'Eszter Mac',
    });
    const created = backend.engines.at(-1)!;
    expect(created.createdBy).toBe(OWNER.userId);
    expect(assistantInstruction(created, null, 'checkout', { state: 'none' })).not.toContain(
      backend.lastEngineKey!,
    );
  });

  it('keeps the key out of the page after a reload and offers a new one', async () => {
    const backend = ownerBackend();
    backend.addEngine({ name: 'Laptop', createdBy: OWNER.userId });
    renderWelcome(backend);
    expect(await screen.findByText(t('ownerOnboarding.guide.keyGone'))).toBeTruthy();
    expect(screen.getByRole('button', { name: t('ownerOnboarding.guide.newKey') })).toBeTruthy();
  });

  it('quotes a machine name with an apostrophe in the command run on the machine', () => {
    const text = assistantInstruction({ id: 'eng_aaaaaaaaaaaa', name: "Eszter's Mac" }, null, 'checkout', {
      state: 'none',
    });
    expect(text).toContain(`--name 'Eszter'\\''s Mac'`);
  });
});

describe('the motor app install in the guide', () => {
  const RELEASE = { tag: 'v2026.10.11', url: 'https://github.com/acme/tool/releases/tag/v2026.10.11' };

  /** The "Magam csinálom" tab of a machine that has not connected yet. */
  async function openManualTab(latestRelease: typeof RELEASE | null) {
    const backend = ownerBackend();
    backend.serverVersion = { ...backend.serverVersion, latestRelease };
    backend.addEngine({ name: 'Laptop', createdBy: OWNER.userId });
    renderWelcome(backend);
    fireEvent.click(await screen.findByRole('button', { name: t('ownerOnboarding.guide.tabManual') }));
  }

  beforeEach(() => window.localStorage.clear());

  it('offers the dmg of the latest release to download', async () => {
    await openManualTab(RELEASE);
    const link = await screen.findByRole('link', { name: t('ownerOnboarding.guide.appDownloadAria') });
    expect(link.getAttribute('href')).toBe(
      'https://github.com/acme/tool/releases/latest/download/projectman-motor.dmg',
    );
    expect(link.hasAttribute('download')).toBe(true);
    expect(screen.queryByText((text) => text.startsWith('git clone'))).toBeNull();
  });

  it('points to the install guide instead when no release is published', async () => {
    await openManualTab(null);
    const docs = await screen.findByRole('link', { name: t('ownerOnboarding.guide.appNoReleaseLink') });
    expect(docs.getAttribute('href')).toContain('docs/DEPLOY.md');
    expect(screen.queryByRole('link', { name: t('ownerOnboarding.guide.appDownloadAria') })).toBeNull();
  });

  it('shows the checkout install once the checkout mode is chosen', async () => {
    await openManualTab(RELEASE);
    fireEvent.click(await screen.findByRole('radio', { name: t('engines.mode.checkout') }));
    expect(await screen.findByText((text) => text.startsWith('git clone'))).toBeTruthy();
    expect(screen.queryByRole('link', { name: t('ownerOnboarding.guide.appDownloadAria') })).toBeNull();
  });
});
