/**
 * Scenario for PM-1093 (docs/SCREENSHOTS.md): the engine chip in the top bar of a project owner, a member who is not
 * an owner, and the host owner. The disposable instance runs in single-machine mode and its user is the host owner,
 * so the browser's answers for the signed-in account (`/api/me`), the cloud mode and the engine status (with
 * `projectEngines`) are faked (`context.route`, as `settings-machines.mjs` does); everything else is the real UI.
 *
 *   a. owner account, the project's own machine online     b. the same, the machine not reachable
 *   c. owner account, no machine bound to the project       d. the same as a member who is not an owner
 *   e. host owner, no binding: the global default, with its "alapértelmezett" chip
 *
 *   npm run shots -- scripts/scenarios/header-engine-chip.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const NOW = () => new Date().toISOString();
const MINUTES_AGO = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

function status(patch) {
  return {
    isDefault: false,
    online: true,
    lastSeenAt: NOW(),
    ...patch,
  };
}

export default async ({ open, shoot, step }) => {
  const state = {
    // 'owner': an owner account and project owner; 'member': a developer of the project; 'host': the host owner.
    viewer: 'owner',
    engines: [],
    projectEngine: null,
  };
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  const context = (await open({ path: '/' })).context();
  await context.route(/\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    const method = request.method();
    if (method === 'GET' && pathname === '/api/me') {
      const real = await (await route.fetch()).json();
      if (state.viewer === 'host') return json(route, real);
      const access = state.viewer === 'owner' ? 'owner' : 'developer';
      return json(route, {
        ...real,
        hostOwner: false,
        ownerAccount: state.viewer === 'owner',
        projects: real.projects.map((project) => ({ ...project, access })),
      });
    }
    if (method === 'GET' && pathname === '/api/engines/status')
      return json(route, {
        mode: 'cloud',
        engines: state.engines,
        projectEngines: { AC: state.projectEngine },
      });
    if (method === 'GET' && pathname === '/api/engines') return json(route, []);
    return route.fallback();
  });

  const friendMac = status({ id: 'eng_aaaaaaaaaaaa', name: 'Eszter MacBookja' });
  const hostMac = status({ id: 'eng_bbbbbbbbbbbb', name: 'Gazda Mac', isDefault: true });

  /** Opens the project at the width, opens the chip's panel when the width shows a chip, and shoots. */
  const shootChip = async (name) => {
    for (const width of WIDTHS) {
      const page = await open({ path: '/p/AC', width });
      // The header re-renders while the first answers arrive: open the panel once the page is quiet.
      await page.waitForLoadState('networkidle');
      const chip = page.getByRole('button', { name: /^(Motor:|Nincs motor)/ });
      if ((await chip.count()) > 0) {
        await chip.first().click();
        await page.getByRole('heading', { name: /^Motor/ }).waitFor();
      }
      await shoot(page, name, { widths: [width], fullPage: false });
    }
  };

  await step('a. the project machine is online', async () => {
    state.engines = [friendMac, hostMac];
    state.projectEngine = friendMac.id;
    await shootChip('a-own-online');
  });

  await step('b. the project machine is not reachable', async () => {
    state.engines = [{ ...friendMac, online: false, lastSeenAt: MINUTES_AGO(42) }, hostMac];
    await shootChip('b-own-offline');
  });

  await step('c. no machine is bound to the project', async () => {
    state.engines = [{ ...hostMac, isDefault: false }, friendMac];
    state.projectEngine = null;
    await shootChip('c-owner-unbound');
  });

  await step('d. the same as a member who is not an owner', async () => {
    state.viewer = 'member';
    await shootChip('d-member-unbound');
  });

  await step('e. the host owner, no binding: the global default', async () => {
    state.viewer = 'host';
    state.engines = [hostMac, friendMac];
    state.projectEngine = hostMac.id;
    await shootChip('e-host-default');
  });
};
