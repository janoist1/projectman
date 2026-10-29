/**
 * Scenario for PM-1127 (docs/SCREENSHOTS.md): the install mode switch ("Telepítés": motor app or checkout) in the
 * places that show an engine command. The disposable instance runs in single-machine mode, so the browser's answers
 * for the owner account, its machines, the project's machines and the server version (`latestReleaseTag`) are faked
 * (`context.route`, as `owner-onboarding.mjs` and `settings-machines.mjs` do); everything else is the real UI. The
 * machine key in the pictures is a visible demo value, never a real key. The texts of the mode switch and the tabs
 * come from `apps/web/src/i18n/hu.ts`, loaded through Vite.
 *
 *   a. new machine guide, "Magam csinálom", motor app mode, a release is published
 *   b. the same without a published release          c. the same in checkout mode
 *   d. "AI-asszisztenssel" tab, motor app mode       e. the "Beállító parancs" dialog of a machine, motor app mode
 *   f. the project's Motorok card, motor app mode, a machine with a command
 *   g. 1512 only: the switch with keyboard focus (Tab to the pill, then right arrow), and the download button focused
 *
 *   npm run shots -- scripts/scenarios/engine-mode.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const DEMO_KEY = 'pme_DEMO_not_a_real_key';
const NOW = () => new Date().toISOString();

// The texts of the Hungarian UI that are not in the mode switch or the tabs (apps/web/src/i18n/hu.ts).
const TEXT = {
  nameLabel: 'A gép neve',
  createKey: 'Kulcs létrehozása',
};

function engine(patch) {
  return {
    id: 'eng_aaaaaaaaaaaa',
    name: 'Eszter MacBookja',
    isDefault: false,
    online: false,
    lastSeenAt: null,
    keyPrefix: 'pme_0001',
    createdAt: NOW(),
    createdBy: 'usr_owner2',
    revokedAt: null,
    lastSeenIp: null,
    hostname: null,
    platform: null,
    version: null,
    versionMismatch: false,
    providers: [],
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
    ownedByMe: true,
    ...patch,
  };
}

export default async ({ open, shoot, step }) => {
  const state = {
    // 'welcome': an owner account without a project (the new machine guide); 'settings': the owner of AC.
    view: 'welcome',
    engines: [],
    bound: [],
    latestReleaseTag: 'v2026.10.29',
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  const first = await open({ path: '/' });
  const ui = await first.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const mode = ui.engines.mode;
  const guide = ui.ownerOnboarding.guide;

  const context = first.context();
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      if (state.view === 'settings') return json(route, { ...real, hostOwner: false, ownerAccount: true });
      return json(route, {
        ...real,
        name: 'Eszter',
        hostOwner: false,
        instanceOwner: false,
        ownerAccount: true,
        handles: {},
        projects: [],
      });
    }
    if (method === 'GET' && pathname === '/api/projects' && state.view === 'welcome') return json(route, []);
    if (method === 'GET' && pathname === '/api/version')
      return json(route, {
        version: 'dev',
        commit: null,
        tag: null,
        latestReleaseTag: state.latestReleaseTag,
      });
    if (method === 'GET' && pathname === '/api/engines/status')
      return json(route, {
        mode: 'cloud',
        engines: state.engines.map(({ id, name, isDefault, online, lastSeenAt }) => ({
          id,
          name,
          isDefault,
          online,
          lastSeenAt,
        })),
      });
    if (method === 'GET' && pathname === '/api/engines') return json(route, state.engines);
    if (method === 'POST' && pathname === '/api/engines') {
      const created = engine({ name: request.postDataJSON().name });
      state.engines = [created];
      return json(route, { engine: created, key: DEMO_KEY }, 201);
    }
    if (method === 'GET' && /^\/api\/engines\/eng_[a-z0-9]{12}\/providers$/.test(pathname))
      return json(route, { providers: [] });
    if (method === 'GET' && pathname === '/api/projects/AC/engines')
      return json(route, {
        engines: state.bound.flatMap(([id, isDefault, holds]) => {
          const entry = state.engines.find((candidate) => candidate.id === id);
          return entry
            ? [
                {
                  id: entry.id,
                  name: entry.name,
                  online: entry.online,
                  isDefault,
                  holdsProject: holds,
                  ownedByMe: entry.ownedByMe,
                },
              ]
            : [];
        }),
      });
    return route.fallback();
  });

  /** The new machine guide of a freshly created machine, in the install mode `installMode` ('app' or 'checkout'). */
  async function openGuide(installMode, tab) {
    state.view = 'welcome';
    state.engines = [];
    const page = await open({ path: '/welcome' });
    await page.getByLabel(TEXT.nameLabel).fill('Eszter MacBookja');
    await page.getByRole('button', { name: TEXT.createKey }).click();
    await page.getByText(DEMO_KEY).first().waitFor();
    await page.getByRole('radio', { name: mode[installMode] }).click();
    await page.getByRole('button', { name: guide[tab] }).click();
    return page;
  }

  await step('a. the manual tab, motor app mode, with a release', async () => {
    state.latestReleaseTag = 'v2026.10.29';
    const page = await openGuide('app', 'tabManual');
    await page.getByRole('link', { name: guide.appDownloadAria }).waitFor();
    await shoot(page, 'a-guide-app-release', { widths: WIDTHS });
  });

  await step('b. the manual tab, motor app mode, without a release', async () => {
    state.latestReleaseTag = null;
    const page = await openGuide('app', 'tabManual');
    await page.getByRole('link', { name: guide.appNoReleaseLink }).waitFor();
    await shoot(page, 'b-guide-app-no-release', { widths: WIDTHS });
  });

  await step('c. the manual tab, checkout mode', async () => {
    state.latestReleaseTag = 'v2026.10.29';
    const page = await openGuide('checkout', 'tabManual');
    await page.getByText('git clone', { exact: false }).first().waitFor();
    await shoot(page, 'c-guide-checkout', { widths: WIDTHS });
  });

  await step('d. the assistant tab, motor app mode', async () => {
    state.latestReleaseTag = 'v2026.10.29';
    const page = await openGuide('app', 'tabAssistant');
    await shoot(page, 'd-guide-assistant-app', { widths: WIDTHS });
  });

  await step('e. the "Beállító parancs" dialog, motor app mode', async () => {
    state.view = 'settings';
    state.engines = [engine({})];
    state.bound = [];
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('button', { name: 'Eszter MacBookja műveletei' }).last().click();
    await page.getByRole('button', { name: ui.engines.setupCommand }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: mode.app }).click();
    await shoot(page, 'e-command-dialog-app', { widths: WIDTHS });
  });

  await step('f. the project Motorok card, motor app mode', async () => {
    state.view = 'settings';
    state.engines = [
      engine({
        online: true,
        lastSeenAt: NOW(),
        hostname: 'eszter-mbp.local',
        platform: 'darwin',
        version: '1.0.0',
      }),
    ];
    // The machine is bound to AC but does not hold the project yet: its command is shown.
    state.bound = [['eng_aaaaaaaaaaaa', true, false]];
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('radio', { name: mode.app }).first().waitFor();
    await page.getByRole('radio', { name: mode.app }).first().click();
    await shoot(page, 'f-project-engines-app', { widths: WIDTHS });
  });

  await step('g. the switch and the download button with keyboard focus', async () => {
    state.latestReleaseTag = 'v2026.10.29';
    const page = await openGuide('app', 'tabManual');
    await page.getByRole('link', { name: guide.appDownloadAria }).waitFor();
    // Focus the pill with the keyboard, then move the choice with the right arrow (checkout), and back with the left.
    await page.getByRole('radio', { name: mode.app }).focus();
    await page.keyboard.press('ArrowRight');
    await shoot(page, 'g-switch-focus', { widths: [1512] });
    await page.keyboard.press('ArrowLeft');
    await page.getByRole('link', { name: guide.appDownloadAria }).focus();
    await shoot(page, 'g-download-focus', { widths: [1512] });
  });
};
