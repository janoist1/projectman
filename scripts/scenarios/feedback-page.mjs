/**
 * Scenario for PM-511 (docs/SCREENSHOTS.md): the Jelölések page, its settings section and the card row.
 *
 * The server has no way yet to receive a mark (the widget comes with a later card), so the marks are
 * answered in the browser: the routes under /api/projects/AC/feedback that return marks are filled from
 * the lists below (the owner's and a client's view of the same marks). Everything else, the settings
 * section included, talks to the real disposable server; the surface is put into its configuration.
 *
 *   a. not set up yet (owner)             b. the list with a mark open (owner), light and dark
 *   c. a mark waiting for the owner       d. "Új kártya" dialog         e. "Kártyához kötöm" dialog
 *   f. the client's view: a mark that went into an internal card ("Feladatba került", no key)
 *   g. Beállítások → Visszajelző eszköz   h. the card drawer's "Jelölések" row
 *   e2. "Lezárom" dialog  i. the launch menu, two surfaces  j. empty and failed list
 *   k. settings with a failing surface and the markers (browser on, blocked, viewer)
 *   l. a forwarded mark waiting in the inbox  m. the phone's account menu with the badge
 *
 *   npm run shots -- scripts/scenarios/feedback-page.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const KATA = { handle: 'kata', name: 'Kata Nagy', kind: 'human', color: 0 };
const BENCE = { handle: 'bence', name: 'Bence Kiss', kind: 'human', color: 3 };
const PM = { handle: 'pm', name: 'Projektmenedzser', kind: 'ai', color: null };
const SURFACE = { id: 'a1b2c3d4', name: 'Webshop', origin: 'https://acme.test' };

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const noAnchor = {
  kind: 'page',
  selector: null,
  textSnippet: null,
  elementOffset: null,
  pagePoint: null,
  rect: null,
};

function mark(id, author, body, extra = {}) {
  const minutes = extra.minutes ?? 30;
  return {
    id,
    projectKey: 'AC',
    author,
    surface: SURFACE,
    pageUrl: `https://acme.test${extra.path ?? '/'}`,
    pagePath: extra.path ?? '/',
    pageTitle: extra.pageTitle ?? 'Acme webshop',
    kind: extra.kind ?? 'point',
    body,
    anchor: noAnchor,
    status: extra.status ?? 'new',
    outcome: extra.outcome ?? null,
    card: extra.card ?? null,
    working: extra.working ?? false,
    commentCount: extra.thread?.filter((entry) => entry.type === 'comment').length ?? 0,
    unread: extra.unread ?? false,
    hasScreenshot: false,
    createdAt: ago(minutes),
    updatedAt: ago(minutes),
    lastActivityAt: ago(minutes),
    closedAt: null,
    thread: extra.thread ?? [],
  };
}

export default async ({ instance, open, shoot, step, log }) => {
  const tasks = await instance.api('/api/projects/AC/tasks');
  const [first, second] = tasks;
  if (!first || !second) throw new Error('The demo project needs two cards.');
  const internalCard = {
    visible: true,
    key: first.key,
    title: first.title,
    stageName: 'Fejlesztés',
    visibility: 'internal',
  };
  const sharedCard = {
    visible: true,
    key: second.key,
    title: second.title,
    stageName: 'Átnézés',
    visibility: 'shared',
  };

  const entry = (id, type, actor, body, minutes, card = null) => ({
    id,
    type,
    actor,
    body,
    card,
    createdAt: ago(minutes),
  });
  const environment = {
    viewport: { width: 390, height: 780 },
    scroll: { x: 0, y: 140 },
    devicePixelRatio: 3,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
    browser: 'Safari 18',
    os: 'iOS 18',
    language: 'hu-HU',
  };

  const owner = [
    mark(
      'fbm_aaaaaaaaaa01',
      KATA,
      'A kupon mező kitakarja a „Megrendelem” gombot, ha a billentyűzet fel van jönve.',
      {
        path: '/penztar',
        pageTitle: 'Pénztár – Acme webshop',
        minutes: 22,
        unread: true,
      },
    ),
    mark('fbm_aaaaaaaaaa02', BENCE, 'Az üres kosár szövegében elírás van: „kosarad ures”.', {
      path: '/kosar',
      kind: 'element',
      minutes: 95,
      working: true,
    }),
    mark(
      'fbm_aaaaaaaaaa03',
      KATA,
      'Az összehasonlító táblázat mobilon szétesik. Lehetne belőle kártyás nézet?',
      {
        path: '/osszehasonlitas',
        kind: 'area',
        minutes: 60 * 26,
        status: 'waiting_owner',
        thread: [
          entry(
            'fbe_1',
            'comment',
            PM,
            'Köszönöm! Ez új nézet lenne, nem hiba – a tulajdonos dönti el, belefér-e.',
            60 * 25,
          ),
          entry(
            'fbe_2',
            'forwarded',
            PM,
            'Új felületi elem, ami az ütemezést érinti; árat és határidőt nem ígérhetek rá.',
            60 * 25,
          ),
        ],
      },
    ),
    mark('fbm_aaaaaaaaaa04', BENCE, 'A termékoldalon a méretválasztó nem mutatja, melyik méret fogyott el.', {
      path: '/termek/futocipo',
      minutes: 60 * 50,
      status: 'handled',
      outcome: 'card_created',
      card: internalCard,
      thread: [
        entry('fbe_3', 'card_created', PM, null, 60 * 48, internalCard),
        entry('fbe_4', 'comment', PM, 'Felvettem feladatként, a csapat hamarosan foglalkozik vele.', 60 * 48),
      ],
    }),
    mark('fbm_aaaaaaaaaa05', KATA, 'A főoldali banner képe elmosódott a nagy kijelzőn.', {
      minutes: 60 * 24 * 3,
      status: 'handled',
      outcome: 'card_created',
      card: sharedCard,
      thread: [entry('fbe_5', 'card_created', PM, null, 60 * 24 * 3 - 30, sharedCard)],
    }),
  ];
  // What the client Kata sees of the same marks: her own and Bence's, the internal card without key and title.
  const hide = (item) => ({
    ...item,
    card: item.card?.visible && item.card.visibility === 'internal' ? { visible: false } : item.card,
  });
  const clientMarks = owner.map(hide);

  /** What the list answers with: the surfaces on show and whether the read works at all. */
  let surfaces = [SURFACE];
  let listMode = 'normal';
  /** A hand-built settings view (members with browsers, a blocked one, a viewer); null: the real server answers. */
  let settingsStub = null;
  /** Inbox items to add to the inbox read (the forwarded mark); null: the real server answers. */
  let inboxStub = null;

  const view = (marks, processor) => ({
    marks: marks.map(({ thread, ...item }) => ({ ...item, commentCount: thread.length })),
    surfaces,
    markers: [KATA, BENCE].map(({ handle, name, color }) => ({ handle, name, color })),
    canProcess: processor,
    canMark: true,
  });
  const detail = (item, processor) => ({
    ...item,
    thread: item.thread.map((entry) =>
      processor || entry.type !== 'forwarded' ? entry : { ...entry, body: null },
    ),
    environment: processor ? environment : null,
    screenshot: null,
    canProcess: processor,
    canComment: item.status !== 'closed',
  });

  /** Answers the feedback reads from the lists above, for the account on show. */
  let asClient = false;
  const install = async (page) => {
    await page.context().route(/\/api\/projects\/AC\/feedback(\/[^?]*)?(\?.*)?$/, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const tail = url.pathname.replace('/api/projects/AC/feedback', '');
      const marks = asClient ? clientMarks : owner;
      const json = (body, status = 200) =>
        route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (request.method() === 'POST') return route.fulfill({ status: 204 });
      if (tail === '/settings') return settingsStub ? json(settingsStub) : route.fallback();
      if (tail === '' && url.searchParams.has('task')) {
        const task = url.searchParams.get('task');
        const own = marks.filter((item) => item.card?.visible && item.card.key === task);
        return json({ ...view(own, !asClient) });
      }
      if (tail === '' && listMode === 'error') return json({ error: 'internal_error' }, 500);
      if (tail === '' && listMode === 'empty') return json(view([], !asClient));
      if (tail === '') return json(view(marks, !asClient));
      if (tail === '/summary')
        return json({
          configured: true,
          canMark: true,
          canProcess: !asClient,
          todo: 2,
          unreadReplies: asClient ? 1 : 0,
        });
      const id = tail.slice(1);
      const found = marks.find((item) => item.id === id);
      return found ? json(detail(found, !asClient)) : json({ error: 'not_found' }, 404);
    });
    await page.context().route(/\/api\/projects\/AC\/inbox$/, async (route) => {
      if (!inboxStub || route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      return route.fulfill({ response, json: { ...body, items: [...inboxStub, ...body.items] } });
    });
  };

  await step('a. not set up yet', async () => {
    const page = await open({ path: '/p/AC/feedback' });
    await page.getByRole('heading', { name: 'Még nincs bekapcsolva a visszajelző eszköz' }).waitFor();
    await shoot(page, 'a-not-configured', { widths: WIDTHS });
  });

  const { config, version } = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: { baseVersion: version, feedback: { surfaces: [SURFACE] } },
  });
  log(`surface set; team ${config.team.members.length} members`);

  for (const theme of ['light', 'dark']) {
    await step(`b. the list and a mark (${theme})`, async () => {
      const page = await open({ path: '/p/AC/feedback' });
      await install(page);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.reload();
      await page.getByText('A kupon mező kitakarja').first().waitFor();
      await shoot(page, `b-list-${theme}`, { widths: WIDTHS });
      await page.getByText('A kupon mező kitakarja').first().click();
      await page.getByRole('region', { name: 'A jelölés részletei' }).waitFor();
      await shoot(page, `b-open-${theme}`, { widths: WIDTHS });
    });
  }

  await step('c. a mark waiting for the owner', async () => {
    const page = await open({ path: '/p/AC/feedback/fbm_aaaaaaaaaa03?f=all' });
    await page.getByText('Te döntesz.').first().waitFor();
    await shoot(page, 'c-waiting-owner', { widths: WIDTHS });
  });

  await step('d, e. the dialogs', async () => {
    const page = await open({ path: '/p/AC/feedback/fbm_aaaaaaaaaa01' });
    await page.getByRole('button', { name: 'Új kártya' }).click();
    await page.getByRole('dialog', { name: 'Új kártya a jelölésből' }).waitFor();
    await shoot(page, 'd-new-card', { widths: WIDTHS });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Kártyához kötöm' }).click();
    await page.getByRole('dialog', { name: 'Kötés meglévő kártyához' }).waitFor();
    await shoot(page, 'e-link-card', { widths: WIDTHS });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Lezárom' }).click();
    await page.getByRole('dialog', { name: 'Jelölés lezárása' }).waitFor();
    await shoot(page, 'e2-close', { widths: WIDTHS });
  });

  await step('f. the client sees the internal card as "Feladatba került"', async () => {
    const client = await instance.invite({
      project: 'AC',
      email: 'kata@acme.test',
      name: 'Kata Nagy',
      access: 'client',
    });
    asClient = true;
    const page = await open({ as: client, path: '/p/AC/feedback/fbm_aaaaaaaaaa04?f=all' });
    await install(page);
    await page.reload();
    await page.getByText('Feladatba került.').first().waitFor();
    await shoot(page, 'f-client', { widths: WIDTHS });
    asClient = false;
  });

  await step('g. the settings section', async () => {
    const page = await open({ path: '/p/AC/settings/feedback' });
    await page.getByRole('heading', { name: 'Felületek' }).waitFor();
    await shoot(page, 'g-settings', { widths: WIDTHS, fullPage: true });
    await page.getByRole('button', { name: 'Webshop felület törlése' }).click();
    await page.getByRole('dialog', { name: 'Felület törlése' }).waitFor();
    await shoot(page, 'g-settings-remove', { widths: WIDTHS });
  });

  await step('h. the card row', async () => {
    const page = await open({ path: `/p/AC/tasks/${first.key}` });
    await install(page);
    await page.reload();
    const row = 'section[aria-label="Jelölések"] >> visible=true';
    await page.locator(row).waitFor();
    await shoot(page, 'h-card-row', { widths: WIDTHS, highlight: row });
  });

  await step('i. the launch menu with two surfaces', async () => {
    surfaces = [SURFACE, { id: 'e5f6a7b8', name: 'Admin', origin: 'https://admin.acme.test' }];
    const page = await open({ path: '/p/AC/feedback' });
    await install(page);
    await page.reload();
    await page.getByRole('button', { name: /Jelölés az oldalon/ }).click();
    await page.getByText('Melyik felületet nyissuk meg?').waitFor();
    await shoot(page, 'i-launch-menu', { widths: WIDTHS });
    surfaces = [SURFACE];
  });

  await step('j. empty and failed list', async () => {
    listMode = 'empty';
    const empty = await open({ path: '/p/AC/feedback' });
    await install(empty);
    await empty.reload();
    await empty.getByRole('heading', { name: 'Még nincs jelölés' }).waitFor();
    await shoot(empty, 'j-empty', { widths: WIDTHS });
    listMode = 'error';
    const failed = await open({ path: '/p/AC/feedback' });
    await install(failed);
    await failed.reload();
    await failed.getByText('Nem sikerült betölteni a jelöléseket.').waitFor();
    await shoot(failed, 'j-error', { widths: WIDTHS });
    listMode = 'normal';
  });

  await step('k. settings: a failing surface and who may mark', async () => {
    settingsStub = {
      publicBaseUrl: 'https://projectman.acme.test',
      surfaces: [{ ...SURFACE, lastMarkAt: ago(60 * 5) }],
      markers: [
        { ...KATA, access: 'developer', blocked: false, activeSessions: 2, lastMarkAt: ago(22) },
        { ...BENCE, access: 'developer', blocked: true, activeSessions: 0, lastMarkAt: null },
        {
          handle: 'vera',
          name: 'Vera Tóth',
          color: 5,
          access: 'viewer',
          blocked: false,
          activeSessions: 0,
          lastMarkAt: null,
        },
      ],
    };
    const page = await open({ path: '/p/AC/settings/feedback' });
    await install(page);
    await page.reload();
    await page.getByRole('heading', { name: 'Felületek' }).waitFor();
    await page.getByLabel('Cím', { exact: true }).fill('https://acme.test/admin');
    await page.getByLabel('Név', { exact: true }).fill('Admin');
    await shoot(page, 'k-settings-error', { widths: WIDTHS, fullPage: true });
    settingsStub = null;
  });

  await step('l. the owner has a forwarded mark waiting in the inbox', async () => {
    inboxStub = [
      {
        id: 'inb_fb',
        projectKey: 'AC',
        kind: 'alert',
        assignees: ['owner'],
        source: 'pm',
        sessionId: null,
        taskKey: null,
        title: 'A server alert',
        body: null,
        payload: {
          alert: 'feedback_forwarded',
          markId: 'fbm_aaaaaaaaaa03',
          author: 'kata',
          excerpt: 'Az összehasonlító táblázat mobilon szétesik. Lehetne belőle kártyás nézet?',
          reason: 'Új felületi elem, ami az ütemezést érinti; árat és határidőt nem ígérhetek rá.',
        },
        options: [{ id: 'seen', label: 'seen', style: 'primary' }],
        state: 'open',
        resolution: null,
        createdAt: ago(60 * 25),
      },
    ];
    const page = await open({ path: '/p/AC/inbox' });
    await install(page);
    await page.reload();
    await page.getByRole('heading', { name: 'Jelölés, ami a döntésedre vár' }).waitFor();
    await shoot(page, 'l-inbox-forwarded', { widths: WIDTHS });
    inboxStub = null;
  });

  await step('m. the phone: the account menu with the Jelölések item and badge', async () => {
    const page = await open({ path: '/p/AC', width: 390 });
    await install(page);
    await page.reload();
    await page.getByRole('button', { name: /^Fiók:/ }).click();
    await page.getByRole('link', { name: /Jelölések/ }).waitFor();
    await shoot(page, 'm-phone-account-menu', { widths: [390] });
  });
};
