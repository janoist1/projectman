/**
 * PM-1182: the machines, the engine chip and the owner onboarding in English. The same faked cloud answers as
 * `settings-machines.mjs`, `header-engine-chip.mjs` and `owner-onboarding.mjs` (`context.route`); the owner's language
 * is set through the API first, so every page reads English. The machine key in the pictures is a visible demo value.
 *
 *   a. the engine chip, the machine online and not reachable   b. Settings > Engines (project machines, Your machines)
 *   c. the attach dialog and the rename dialog                 d. a project without a machine
 *   e. the owner invite, step 1 and step 2 (both tabs)
 *
 *   npm run shots -- scripts/scenarios/english-machines.mjs --widths 1512,390
 */
const WIDTHS = [1512, 390];
const DEMO_KEY = 'pme_DEMO_not_a_real_key';
const NOW = () => new Date().toISOString();
const MINUTES_AGO = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function engine(patch) {
  return {
    id: 'eng_aaaaaaaaaaaa',
    name: 'Eszter MacBook',
    isDefault: false,
    online: true,
    lastSeenAt: NOW(),
    keyPrefix: 'pme_0001',
    createdAt: '2026-10-01T10:00:00.000Z',
    createdBy: 'usr_owner2',
    revokedAt: null,
    lastSeenIp: '192.168.1.20',
    hostname: 'eszter-mbp.local',
    platform: 'darwin',
    version: '1.0.0',
    versionMismatch: false,
    providers: [{ provider: 'claude', available: true, version: '2.1.0' }],
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
    ownedByMe: true,
    ...patch,
  };
}

export default async ({ instance, open, shoot, step }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });

  const state = { engines: [], bound: [], projectEngine: null, onboarding: false };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  const context = (await open({ path: '/' })).context();
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && pathname === '/api/owner-invites/demo')
      return json(route, {
        inviterName: 'Ist1',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        requiresLogin: false,
      });
    if (method === 'GET' && pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      return json(route, {
        ...real,
        hostOwner: false,
        ownerAccount: true,
        ...(state.onboarding ? { name: 'Eszter', handles: {}, projects: [] } : {}),
      });
    }
    if (method === 'GET' && pathname === '/api/projects' && state.onboarding) return json(route, []);
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
        projectEngines: { AC: state.projectEngine },
      });
    if (method === 'GET' && pathname === '/api/engines') return json(route, state.engines);
    if (method === 'POST' && pathname === '/api/engines') {
      const created = engine({ name: request.postDataJSON().name, online: false, lastSeenAt: null });
      state.engines = [created];
      return json(route, { engine: created, key: DEMO_KEY }, 201);
    }
    if (method === 'GET' && pathname === '/api/projects/AC/engines')
      return json(route, {
        engines: state.bound.flatMap(([id, isDefault, holds]) => {
          const entry = state.engines.find((candidate) => candidate.id === id);
          return entry
            ? [
                {
                  id,
                  name: entry.name,
                  online: entry.online,
                  isDefault,
                  holdsProject: holds,
                  ownedByMe: true,
                },
              ]
            : [];
        }),
      });
    return route.fallback();
  });

  const eszter = engine({});
  const office = engine({
    id: 'eng_bbbbbbbbbbbb',
    name: 'Office Mac mini',
    online: false,
    lastSeenAt: MINUTES_AGO(42),
    hostname: 'office-mini.local',
    createdAt: '2026-10-05T10:00:00.000Z',
  });
  // Owned, but not attached to the project: the attach dialog has a machine to offer.
  const oldLaptop = engine({
    id: 'eng_cccccccccccc',
    name: 'Old laptop',
    online: false,
    lastSeenAt: MINUTES_AGO(5000),
    createdAt: '2026-09-20T10:00:00.000Z',
  });
  state.engines = [eszter, office, oldLaptop];
  state.bound = [
    [eszter.id, true, true],
    [office.id, false, false],
  ];
  state.projectEngine = eszter.id;

  await step('a. the engine chip: online and not reachable', async () => {
    for (const [name, online] of [
      ['chip-online-en', true],
      ['chip-offline-en', false],
    ]) {
      state.engines = [
        online ? eszter : { ...eszter, online: false, lastSeenAt: MINUTES_AGO(42) },
        office,
        oldLaptop,
      ];
      for (const width of WIDTHS) {
        const page = await open({ path: '/p/AC', width });
        await page.waitForLoadState('networkidle');
        const chip = page.getByRole('button', { name: /^(Engine:|No engine)/ });
        if ((await chip.count()) > 0) {
          await chip.first().click();
          await page.getByRole('heading', { name: /^Engine/ }).waitFor();
        }
        await shoot(page, name, { widths: [width], fullPage: false });
      }
    }
    state.engines = [eszter, office, oldLaptop];
  });

  await step('b. Settings > Engines', async () => {
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('heading', { name: 'The project runs on these machines' }).waitFor();
    await page.getByRole('heading', { name: 'Your machines' }).waitFor();
    await shoot(page, 'engines-en', { widths: WIDTHS });
  });

  await step('c. the attach and rename dialogs', async () => {
    let page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('button', { name: 'Attach another machine' }).click();
    await page.getByRole('dialog').waitFor();
    await shoot(page, 'engine-attach-en', { widths: WIDTHS });
    page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('heading', { name: 'Your machines' }).waitFor();
    await page.getByRole('button', { name: 'Actions for Eszter MacBook' }).last().click();
    await page.getByRole('button', { name: 'Rename…' }).click();
    await page.getByRole('dialog', { name: 'Rename machine' }).waitFor();
    await shoot(page, 'engine-rename-en', { widths: WIDTHS });
  });

  await step('d. a project without a machine', async () => {
    state.bound = [];
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByText('No machine is attached to this project yet', { exact: false }).first().waitFor();
    await shoot(page, 'engines-empty-en', { widths: WIDTHS });
  });

  await step('e. owner invite and the first steps', async () => {
    state.onboarding = true;
    state.engines = [];
    let page = await open({ path: '/owner-invite/demo' });
    await page.getByText('Owner invite', { exact: false }).first().waitFor();
    await shoot(page, 'owner-invite-en', { widths: WIDTHS });
    page = await open({ path: '/welcome' });
    await page.getByText('Name your machine').first().waitFor();
    await shoot(page, 'welcome-1-en', { widths: WIDTHS });
    await page.getByLabel('The machine’s name').fill("Eszter's MacBook");
    await page.getByRole('button', { name: 'Create key' }).click();
    await page.getByText(DEMO_KEY).first().waitFor();
    await shoot(page, 'welcome-2-assistant-en', { widths: WIDTHS });
    await page.getByText('I’ll do it myself', { exact: true }).first().click();
    // The engine app's manual steps have no fixed text to wait for: the assistant's instruction goes away.
    await page
      .getByText('Paste it into the Claude or Codex desktop app')
      .first()
      .waitFor({ state: 'hidden' });
    await shoot(page, 'welcome-2-manual-en', { widths: WIDTHS });
  });
};
