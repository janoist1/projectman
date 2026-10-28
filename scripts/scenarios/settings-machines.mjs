/**
 * Scenario for PM-1078 (docs/SCREENSHOTS.md): Settings → Motorok and Integrátor for an owner account. The disposable
 * instance runs in single-machine mode and its user is the host owner, so the browser's answers for the signed-in
 * owner account, the cloud mode, its machines, the project's machines and the integrator keys are faked
 * (`context.route`, as `owner-onboarding.mjs` does); everything else is the real UI. The machine key and the
 * integrator key in the pictures are visible demo values, never real keys.
 *
 *   j. Motorok: the project's machines (one holds the project, one waits for its command) and "Gépeid"
 *   k. the bind dialog                          l. the rename dialog
 *   m. Integrátor: the new key with the assistant instruction
 *   n. Motorok of a project without a machine   o. Motorok as the host owner (the default engine stays)
 *
 *   npm run shots -- scripts/scenarios/settings-machines.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const DEMO_KEY = 'pmi_DEMO_not_a_real_key';
const NOW = () => new Date().toISOString();
const MINUTES_AGO = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

// The texts of the Hungarian UI the scenario waits for or clicks (apps/web/src/i18n/hu.ts).
const TEXT = {
  yours: 'Gépeid',
  projectMachines: 'Ezeken a gépeken fut a projekt',
  projectMachine: 'Ezen a gépen fut a projekt',
  bindMore: 'Másik gép hozzákötése',
  bindFirst: 'Gép hozzákötése',
  renameTitle: 'Gép átnevezése',
  createKey: 'Kulcs létrehozása',
  submit: 'Létrehozás',
  assistant: 'AI-asszisztenssel',
  emptyWarn: 'Ehhez a projekthez még nincs gép kötve',
};

function engine(patch) {
  return {
    id: 'eng_aaaaaaaaaaaa',
    name: 'Eszter MacBookja',
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

export default async ({ open, shoot, step }) => {
  const state = {
    owner: true,
    engines: [],
    // The machines bound to AC: [engineId, isDefault, holdsProject]
    bound: [],
    keys: [],
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const projectView = (entry, isDefault, holds) => ({
    id: entry.id,
    name: entry.name,
    online: entry.online,
    isDefault,
    holdsProject: holds,
    ownedByMe: entry.ownedByMe,
  });

  const context = (await open({ path: '/' })).context();
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      return json(route, state.owner ? { ...real, hostOwner: false, ownerAccount: true } : real);
    }
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
    if (method === 'GET' && pathname === '/api/projects/AC/engines')
      return json(route, {
        engines: state.bound.flatMap(([id, isDefault, holds]) => {
          const entry = state.engines.find((candidate) => candidate.id === id);
          return entry ? [projectView(entry, isDefault, holds)] : [];
        }),
      });
    if (method === 'GET' && pathname === '/api/auth/integrator-keys')
      return json(route, { keys: state.keys });
    if (method === 'POST' && pathname === '/api/auth/integrator-keys') {
      const info = {
        id: 'key_demo',
        mode: 'super',
        prefix: 'pmi_DEMO',
        state: 'active',
        createdAt: NOW(),
        expiresAt: null,
        lastUsedAt: null,
        lastUsedChannel: null,
        revokedAt: null,
      };
      state.keys = [info];
      return json(route, { key: info, secret: DEMO_KEY }, 201);
    }
    return route.fallback();
  });

  state.engines = [
    engine({ id: 'eng_aaaaaaaaaaaa', name: 'Eszter MacBookja' }),
    engine({
      id: 'eng_bbbbbbbbbbbb',
      name: 'Irodai Mac mini',
      online: false,
      lastSeenAt: MINUTES_AGO(42),
      hostname: 'iroda-mini.local',
      createdAt: '2026-10-05T10:00:00.000Z',
    }),
    engine({
      id: 'eng_cccccccccccc',
      name: 'Régi laptop',
      online: false,
      lastSeenAt: MINUTES_AGO(5000),
      createdAt: '2026-09-20T10:00:00.000Z',
    }),
  ];
  state.bound = [
    ['eng_aaaaaaaaaaaa', true, true],
    ['eng_bbbbbbbbbbbb', false, false],
  ];

  await step('j. Motorok: the project machines and Gépeid', async () => {
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('heading', { name: TEXT.projectMachines }).waitFor();
    await page.getByRole('heading', { name: TEXT.yours }).waitFor();
    await shoot(page, 'j-engines', { widths: WIDTHS });
  });

  await step('k. the bind dialog', async () => {
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('button', { name: TEXT.bindMore }).click();
    await page.getByRole('dialog').waitFor();
    await shoot(page, 'k-bind', { widths: WIDTHS });
  });

  await step('l. the rename dialog', async () => {
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('heading', { name: TEXT.yours }).waitFor();
    await page.getByRole('button', { name: 'Eszter MacBookja műveletei' }).last().click();
    await page.getByRole('button', { name: 'Átnevezés…' }).click();
    await page.getByRole('dialog', { name: TEXT.renameTitle }).waitFor();
    await shoot(page, 'l-rename', { widths: WIDTHS });
  });

  await step('m. Integrátor: the new key with the assistant instruction', async () => {
    const page = await open({ path: '/p/AC/settings/integrator' });
    await page.getByRole('button', { name: TEXT.createKey }).click();
    await page.getByRole('dialog').getByRole('button', { name: TEXT.submit }).click();
    await page.getByText(DEMO_KEY).first().waitFor();
    await page.getByText(TEXT.assistant, { exact: true }).first().waitFor();
    await shoot(page, 'm-integrator-key', { widths: WIDTHS });
  });

  await step('n. a project without a machine', async () => {
    state.bound = [];
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByText(TEXT.emptyWarn, { exact: false }).first().waitFor();
    await shoot(page, 'n-engines-empty', { widths: WIDTHS });
  });

  await step('o. Motorok as the host owner', async () => {
    state.owner = false;
    state.bound = [['eng_aaaaaaaaaaaa', true, true]];
    state.engines = state.engines.map((entry) => ({ ...entry, isDefault: entry.id === 'eng_aaaaaaaaaaaa' }));
    const page = await open({ path: '/p/AC/settings/engines' });
    await page.getByRole('heading', { name: TEXT.yours }).waitFor();
    await shoot(page, 'o-engines-host', { widths: WIDTHS });
  });
};
