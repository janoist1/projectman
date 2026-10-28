/**
 * Scenario for PM-1067 (docs/SCREENSHOTS.md): the new owner's way from the invitation to a project on their own
 * machine. The disposable instance runs in single-machine mode and has no owner account, so the browser's answers
 * for the owner invitation, the signed-in owner account, its machines, their provider logins and the project's
 * machines are faked (`context.route`, as `work-outage.mjs` does); everything else is the real UI. The machine key in
 * the pictures is a visible demo value, never a real key.
 *
 *   a. the invitation                      b. an invalid invitation
 *   c. step 1 (name the machine)           d. step 2, "AI-asszisztenssel" tab, with the key
 *   n. step 2, "Magam csinálom" tab        e. step 3 (provider logins)
 *   f. step 4 (first project)              g. the wizard with the machine choice (one offline machine)
 *   h. the wizard without a connected machine
 *   i. the set-up page of the created project, optional part open
 *
 *   npm run shots -- scripts/scenarios/owner-onboarding.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const DEMO_KEY = 'pme_DEMO_not_a_real_key';
const NOW = () => new Date().toISOString();

// The texts of the Hungarian UI the scenario waits for or clicks (apps/web/src/i18n/hu.ts).
const TEXT = {
  invite: 'Tulajdonosi meghívó',
  invalid: 'Ez a meghívó már nem érvényes',
  step1: 'Nevezd el a gépedet',
  nameLabel: 'A gép neve',
  createKey: 'Kulcs létrehozása',
  manualTab: 'Magam csinálom',
  step3: 'Lépj be az AI-szolgáltatóba a gépeden',
  createProject: 'Projekt létrehozása',
  engineLegend: 'Gép',
  noEngine: 'Nincs csatlakozott géped',
  projectName: 'Név',
  workspace: 'Munkaterület útvonala',
  optionalSummary: 'Nem kötelező: kösd be az asszisztensedet a projectmanhez is',
  setCommand: 'engine -- project set',
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

const connected = (patch = {}) =>
  engine({
    online: true,
    lastSeenAt: NOW(),
    hostname: 'eszter-mbp.local',
    platform: 'darwin',
    version: '1.0.0',
    ...patch,
  });

function login(provider, state) {
  const base = { provider, method: null, checkedAt: NOW() };
  if (state === 'in') return { ...base, loggedIn: true, method: 'subscription' };
  if (state === 'missing') return { ...base, loggedIn: false, problem: 'cli_missing' };
  return { ...base, loggedIn: false, problem: 'not_logged_in' };
}

export default async ({ open, shoot, step, log }) => {
  const state = { engines: [], logins: [], projects: [], holds: false };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  // One real page first, to get the browser context the faked answers are installed on.
  const context = (await open({ path: '/' })).context();
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && pathname === '/api/owner-invites/demo') {
      return json(route, {
        inviterName: 'Ist1',
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        requiresLogin: false,
      });
    }
    if (method === 'GET' && pathname.startsWith('/api/owner-invites/'))
      return json(route, { error: { code: 'invite_invalid', message: 'Invalid invitation' } }, 404);
    if (method === 'GET' && pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      return json(route, {
        ...real,
        name: 'Eszter',
        hostOwner: false,
        instanceOwner: false,
        ownerAccount: true,
        handles: {},
        projects: state.projects.map((project) => ({ ...project, access: 'owner', roles: [] })),
      });
    }
    if (method === 'GET' && pathname === '/api/projects')
      return json(
        route,
        state.projects.map((project) => ({ ...project, configVersion: '0000000' })),
      );
    if (method === 'POST' && pathname === '/api/projects') {
      const body = request.postDataJSON();
      const project = { key: body.key, name: body.name, templateId: 'starter' };
      state.projects.push(project);
      return json(route, { ...project, configVersion: '0000000' });
    }
    if (method === 'GET' && pathname === '/api/engines') return json(route, state.engines);
    if (method === 'POST' && pathname === '/api/engines') {
      const created = engine({ name: request.postDataJSON().name });
      state.engines = [created];
      return json(route, { engine: created, key: DEMO_KEY }, 201);
    }
    if (method === 'GET' && /^\/api\/engines\/eng_[a-z0-9]{12}\/providers$/.test(pathname))
      return json(route, { providers: state.logins });
    if (method === 'GET' && /^\/api\/projects\/[A-Z][A-Z0-9]*\/engines$/.test(pathname)) {
      return json(route, {
        engines: state.engines
          .filter((entry) => entry.online)
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            online: entry.online,
            isDefault: true,
            holdsProject: state.holds,
            ownedByMe: true,
          })),
      });
    }
    return route.fallback();
  });

  await step('a. the invitation', async () => {
    const page = await open({ path: '/owner-invite/demo' });
    await page.getByText(TEXT.invite, { exact: false }).first().waitFor();
    await shoot(page, 'a-invite', { widths: WIDTHS });
  });

  await step('b. an invalid invitation', async () => {
    const page = await open({ path: '/owner-invite/expired' });
    await page.getByText(TEXT.invalid).first().waitFor();
    await shoot(page, 'b-invite-invalid', { widths: WIDTHS });
  });

  let welcome;
  await step('c. step 1', async () => {
    welcome = await open({ path: '/welcome' });
    await welcome.getByText(TEXT.step1).first().waitFor();
    await shoot(welcome, 'c-welcome-1', { widths: WIDTHS });
  });

  await step('d. step 2, assistant tab, with the key', async () => {
    await welcome.getByLabel(TEXT.nameLabel).fill('Eszter MacBookja');
    await welcome.getByRole('button', { name: TEXT.createKey }).click();
    await welcome.getByText(DEMO_KEY).first().waitFor();
    await shoot(welcome, 'd-welcome-2-assistant', { widths: WIDTHS });
  });

  await step('n. step 2, manual tab', async () => {
    await welcome.getByText(TEXT.manualTab, { exact: true }).first().click();
    await welcome.getByText('engine -- init', { exact: false }).first().waitFor();
    await shoot(welcome, 'n-welcome-2-manual', { widths: WIDTHS });
  });

  await step('e. step 3, provider logins', async () => {
    state.engines = [connected()];
    // Nobody is logged in yet: the step is open, the project manager's provider (Claude) is the one to fix first.
    state.logins = [login('claude', 'out'), login('codex', 'out'), login('gemini', 'missing')];
    welcome = await open({ path: '/welcome' });
    await welcome.getByText(TEXT.step3).first().waitFor();
    await welcome.getByText('Codex', { exact: false }).first().waitFor();
    await shoot(welcome, 'e-welcome-3', { widths: WIDTHS });
  });

  await step('f. step 4', async () => {
    state.logins = [login('claude', 'in'), login('codex', 'in'), login('gemini', 'missing')];
    welcome = await open({ path: '/welcome' });
    await welcome.getByRole('link', { name: TEXT.createProject }).waitFor();
    await shoot(welcome, 'f-welcome-4', { widths: WIDTHS });
  });

  await step('g. the wizard with the machine choice', async () => {
    const online = connected();
    state.engines = [
      online,
      engine({ id: 'eng_bbbbbbbbbbbb', name: 'Régi gép', createdAt: '2026-01-01T10:00:00.000Z' }),
    ];
    const page = await open({ path: `/projects/new?engine=${online.id}` });
    await page.getByText(TEXT.engineLegend, { exact: true }).first().waitFor();
    await shoot(page, 'g-wizard-engine', { widths: WIDTHS });
    // The sticky bottom bar covers the lower machine in a full-page image, so the machine block also gets a viewport shot.
    await page.getByText(TEXT.engineLegend, { exact: true }).first().scrollIntoViewIfNeeded();
    await shoot(page, 'g-wizard-engine-viewport', { widths: [390], fullPage: false });
  });

  await step('h. the wizard without a connected machine', async () => {
    state.engines = [engine({})];
    const page = await open({ path: '/projects/new' });
    await page.getByText(TEXT.noEngine, { exact: false }).first().waitFor();
    await shoot(page, 'h-wizard-no-engine', { widths: WIDTHS });
  });

  await step('i. the set-up page of the new project', async () => {
    state.engines = [connected()];
    const page = await open({ path: `/projects/new?engine=${state.engines[0].id}` });
    await page.getByLabel(TEXT.projectName, { exact: true }).first().fill('Eszter webshop');
    await page.getByLabel(TEXT.workspace).fill('/Users/eszter/Dev/webshop');
    await page.getByRole('button', { name: TEXT.createProject }).click();
    await page.getByText(TEXT.setCommand, { exact: false }).first().waitFor();
    await page.getByText(TEXT.optionalSummary).first().click();
    log(`set-up page at ${new URL(page.url()).pathname}`);
    await shoot(page, 'i-project-setup', { widths: WIDTHS });
  });
};
