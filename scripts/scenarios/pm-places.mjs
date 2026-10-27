/**
 * Screenshots for PM-1071 (docs/SCREENSHOTS.md): the places the project manager offers under its message
 * ("Ugrás ide"), and the strip above the composer that stays for a card only.
 *
 * The server and the fake CLIs are real, but a real manager turn needs a running session, so the manager's
 * messages (with their `places`) are added to the thread in the browser, as `project-manager-corner.mjs`
 * does. Everything else is the real UI on the real demo project.
 *
 *   npm run shots -- scripts/scenarios/pm-places.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const LONG_TITLE =
  'Migrate the whole order history to the new storage and rebuild every old report for the billing system';

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  if (!pm) throw new Error('the demo project has no project manager');
  const owner = (await instance.api('/api/me')).handles.AC;
  const tasks = await instance.api('/api/projects/AC/tasks');
  const [first, second] = tasks;
  log(`pm: ${pm.handle}, owner: ${owner}, cards: ${first.key}, ${second.key}`);

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const message = (id, from, to, body, createdAt, extra = {}) => ({
    id,
    projectKey: 'AC',
    from,
    to: [to],
    taskKey: null,
    body,
    createdAt,
    deliveredAt: createdAt,
    ...extra,
  });
  /** A question of the reader and the manager's answer, which offers the places. */
  const conversation = (to, question, answer, places) => [
    message('msg_pl_1', to, pm.handle, question, minutesAgo(3)),
    message('msg_pl_2', pm.handle, to, answer, minutesAgo(2), { places }),
  ];

  // What the browser is told on top of the server's answers.
  const state = { messages: [] };
  const attach = async (page) => {
    page.on('response', (response) => {
      if (response.status() >= 400) log(`${response.status()} ${response.url()}`);
    });
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages' && url.search.includes(`threadWith=${pm.handle}`),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, { ...body, messages: [...body.messages, ...state.messages] }, response.status());
      },
    );
  };
  const openWith = async (messages, options = {}) => {
    state.messages = messages;
    const page = await open({ path: '/p/AC', width: 1512, ...options });
    await attach(page);
    await page.goto(new URL(options.path ?? '/p/AC', page.url()).href);
    // An open card covers the page's button: it has its own in the card's head.
    const button = options.path?.includes('/tasks/')
      ? '[data-operator-button="drawer"]'
      : '[data-operator-button]';
    await page.waitForSelector(button);
    await page.click(button);
    await page.waitForSelector('#operator-panel textarea');
    await page.waitForTimeout(400);
    return page;
  };
  const waitForPlaces = async (page) => {
    await page.waitForSelector('[data-places]');
    await page.waitForTimeout(300);
  };

  await step('a. a card is open: the strip above the composer', async () => {
    const page = await openWith(
      conversation(owner, 'Mi ez a kártya?', 'Ez a kosár kártya, még nincs rajta munka.'),
      { path: `/p/AC/tasks/${first.key}` },
    );
    await shoot(page, 'a-card-strip', { widths: WIDTHS });
  });

  const offer = (places, extra = {}) =>
    openWith(conversation(owner, 'Hol találom ezt?', 'Ide érdemes ránézned:', places), extra);

  await step('b. an offer on a page that is not a card: no strip', async () => {
    const places = [{ page: 'card', taskKey: second.key }];
    const page = await offer(places);
    await waitForPlaces(page);
    await shoot(page, 'b-offer', { widths: WIDTHS, highlight: '[data-places]' });
  });

  await step('b2. after the click: the panel stays on a desktop, the sheet closes on a phone', async () => {
    for (const width of WIDTHS) {
      const page = await offer([{ page: 'card', taskKey: second.key }], { width });
      await waitForPlaces(page);
      await page.getByRole('link', { name: /Ugrás ide/ }).click();
      await page.waitForTimeout(600);
      await shoot(page, 'b2-after-click', { widths: [width] });
    }
  });

  await step('c. the reader is already there', async () => {
    const page = await openWith(
      conversation(owner, 'Hol van ez?', 'Itt:', [{ page: 'card', taskKey: first.key }]),
      { path: `/p/AC/tasks/${first.key}` },
    );
    await waitForPlaces(page);
    await shoot(page, 'c-here', { widths: WIDTHS, highlight: '[data-places]' });
  });

  await step('d. three places, one with a long card title', async () => {
    const long = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: LONG_TITLE, repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
    });
    const page = await offer([
      { page: 'card', taskKey: long.key },
      { page: 'settings', section: 'labels' },
      { page: 'team' },
    ]);
    await waitForPlaces(page);
    await shoot(page, 'd-three-places', { widths: WIDTHS, highlight: '[data-places]' });
  });

  await step('e. a client: a part of the settings they do not see', async () => {
    // A client writes only to the project's contacts: the project manager is one of them.
    const { config, version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: {
        baseVersion: version,
        contacts: [...new Set([...(config.team.contacts ?? []), pm.handle])],
      },
    });
    const client = await instance.invite({
      project: 'AC',
      email: 'cleo@acme.test',
      name: 'Cleo Client',
      access: 'client',
    });
    const clientHandle = (await instance.api('/api/projects/AC/members')).find(
      (member) => member.displayName === client.name,
    )?.handle;
    if (!clientHandle) throw new Error('the client has no handle in the project');
    const page = await openWith(
      conversation(clientHandle, 'Hol állíthatom át az e-mailt?', 'Itt:', [
        { page: 'settings', section: 'email' },
      ]),
      { as: client },
    );
    await page.waitForSelector('#operator-panel [role="log"]');
    await page.waitForTimeout(600);
    await shoot(page, 'e-unavailable', { widths: WIDTHS });
  });
};
