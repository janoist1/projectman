/**
 * PM-1183: the main views once with an English and once with a Hungarian account language, at 1512 and 390 px.
 * The English round must show no Hungarian system text (team content stays as written); the Hungarian round must
 * look as it did before PM-1168, except the language switch (PM-1178) and the team-language label (PM-1182).
 *
 *   npm run shots -- scripts/scenarios/main-views-languages.mjs --widths 1512,390
 *
 * Views: board (with a theme), a card with its relations, acceptance items and attachments, the timeline with many
 * kinds of rows (one Hungarian note and message), "For you" with several kinds and its empty state, messages with a
 * new message, the team and a member, settings (overview and the edited project settings), "How we work" with a rule
 * panel, a session, the avatar menu with the language switch, the not-found page and the login page.
 * The state is prepared once; the owner's language is set through the API for each round. A dialog closes when the
 * window is resized, so a view with one opens the page again at each width. The login page comes last: it needs the
 * session cookie gone.
 */
const WIDTHS = [1512, 390];
const LANGUAGES = ['en', 'hu'];
const NEW_MESSAGE = { en: 'New message', hu: 'Új üzenet' };
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const QUESTION = 'Should the basket button turn green when the cart is not empty?';

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const members = await instance.api('/api/projects/AC/members');
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const owner = (await instance.api('/api/me')).handles.AC;
  const stages = config.pipeline.stages;
  const labels = config.pipeline.labels;

  // A theme, a relation, acceptance items (one card with one item, one with several) and an attachment.
  const theme = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { kind: 'theme', title: config.project.name, description: 'AC', labels: [] },
  });
  await instance.api('/api/projects/AC/tasks/AC-1', {
    method: 'PATCH',
    body: {
      themeKey: theme.key,
      relations: { add: [{ kind: 'related', key: 'AC-2' }] },
      acceptance: [
        { op: 'add', text: 'Works on mobile' },
        { op: 'add', text: 'Totals are right' },
        { op: 'add', text: 'Keyboard friendly' },
      ],
    },
  });
  await instance.api('/api/projects/AC/tasks/AC-2', {
    method: 'PATCH',
    body: { acceptance: [{ op: 'add', text: 'Shows the basket count' }] },
  });

  // A running session with a tool group, and a real question from the fake CLI.
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: QUESTION, options: ['Yes', 'No'] } },
  ]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);
  const asked = (await instance.api('/api/projects/AC/inbox?state=all')).items
    .filter((item) => item.kind === 'question' && item.title === QUESTION)
    .map(({ payload, ...item }) => {
      const { screening, ...rest } = payload ?? {};
      return { ...item, state: 'open', resolution: null, payload: rest };
    });
  const detail = await instance.api('/api/projects/AC/tasks/AC-1');

  const item = (id, kind, title, options, extra = {}) => ({
    id,
    projectKey: 'AC',
    kind,
    assignees: [owner],
    source: developer.handle,
    sessionId: null,
    taskKey: 'AC-1',
    title,
    body: null,
    payload: {},
    options,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(20),
    ...extra,
  });
  const extras = [
    item(
      'inb_main_permission',
      'permission',
      'Run a command',
      [
        { id: 'allow', label: 'allow', style: 'primary' },
        { id: 'allow_session', label: 'allow_session', style: 'secondary' },
        { id: 'deny', label: 'deny', style: 'danger' },
      ],
      { payload: { toolName: 'Bash', toolInput: { command: 'npm test' } } },
    ),
    item(
      'inb_main_gate',
      'decision',
      'Move to Review',
      [
        { id: 'approve', label: 'approve', style: 'primary' },
        { id: 'reject', label: 'reject', style: 'danger' },
      ],
      {
        payload: {
          gate: {
            requestId: 'req_main_1',
            taskKey: 'AC-1',
            fromStageId: stages[1].id,
            toStageId: stages[2].id,
            stageId: stages[2].id,
            label: labels[0].id,
            requestedBy: { kind: 'human', handle: owner },
          },
        },
      },
    ),
    item('inb_main_alert', 'alert', 'The connection to the provider dropped', [
      { id: 'seen', label: 'seen', style: 'primary' },
    ]),
  ];

  // Timeline rows of many kinds; the note and the question are team content and stay Hungarian.
  const at = (n) => new Date(Date.now() - (40 - n) * 60_000).toISOString();
  const human = { kind: 'human', handle: owner };
  const system = { kind: 'system', handle: null };
  const ai = { kind: 'ai', handle: developer.handle };
  const row = (n, type, data, actor = system) => ({
    id: `evt_main_${n}`,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: null,
    actor,
    type,
    data,
    createdAt: at(n),
  });
  const events = [
    row(1, 'task_labels_changed', { added: [labels[0].id], removed: [], reason: 'refinement' }, human),
    row(2, 'task_stage_changed', { from: stages[0].id, to: stages[1].id }, human),
    row(3, 'acceptance_item_changed', { change: 'added', text: 'Works on mobile', taskKey: 'AC-1' }, human),
    row(
      4,
      'question_asked',
      { question: 'Melyik színű legyen a gomb?', screening: true, inboxItemId: 'x' },
      ai,
    ),
    row(
      5,
      'task_handoff',
      { phase: 'note', from: developer.handle, to: owner, note: 'Átadom, a tesztek zöldek.' },
      ai,
    ),
    row(6, 'task_loop', { phase: 'escalated', reason: 'continued', deciders: [owner] }),
    row(7, 'task_fix_limit', { phase: 'passed_on', deciders: [owner] }),
    row(8, 'task_note', { text: 'Ez egy megjegyzés magyarul.' }, human),
    row(9, 'obligation_woken', { kind: 'merge', responsible: developer.handle, minutes: 30 }),
    row(10, 'session_ended', { stop: { kind: 'idle', idleMinutes: 1 }, exitCode: 0 }),
  ];

  /** Opens `path` in the current language; `mock` may add routes before the page loads. */
  const visit = async (language, path, { width = 1512, mock } = {}) => {
    const page = await open({ path: '/p/AC', width });
    if (mock) await mock(page);
    await page.goto(new URL(path, page.url()).href);
    await page.waitForFunction((lang) => document.documentElement.lang === lang, language);
    await page.waitForLoadState('networkidle').catch(() => {});
    return page;
  };
  const mockInbox = (items) => (page) =>
    page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.items && route.request().method() === 'GET' && !route.request().url().includes('state=all'))
        return json(route, { ...body, items: items ?? [...asked, ...extras, ...body.items] });
      return route.fulfill({ response });
    });
  const mockTimeline = (page) =>
    page.route('**/api/projects/AC/tasks/AC-1', (route) =>
      route.fulfill({ json: { ...detail, timeline: [...detail.timeline, ...events] } }),
    );
  /** Runs `show` at each width on a freshly opened page, so a dialog of the width before is gone. */
  const atWidths = async (language, name, path, show = async () => {}, options = {}) => {
    for (const width of WIDTHS) {
      const page = await visit(language, path, { ...options, width });
      await show(page);
      await shoot(page, `${name}-${language}-${width}`, { widths: [width] });
      await page.close();
    }
  };

  for (const language of LANGUAGES) {
    await instance.api('/api/auth/language', { method: 'PUT', body: { language } });
    const view = (title, run) => step(`${language}: ${title}`, run);

    await view('board', () => atWidths(language, 'board', '/p/AC'));
    await view('board, empty column', () =>
      atWidths(language, 'board-column', '/p/AC', async (page) => {
        await page.getByRole('region').last().scrollIntoViewIfNeeded();
      }),
    );
    await view('card', () => atWidths(language, 'card', '/p/AC/tasks/AC-1'));
    await view('card, one acceptance item', () => atWidths(language, 'card-one', '/p/AC/tasks/AC-2'));
    await view('card, attachments', () =>
      atWidths(language, 'card-attachments', '/p/AC/tasks/AC-1/attachments', async (page) => {
        await page
          .getByLabel(/^(Choose files to attach|Csatolandó fájlok kiválasztása)/)
          .setInputFiles({ name: 'AC.txt', mimeType: 'text/plain', buffer: Buffer.from('AC') });
        await page
          .getByRole('link', { name: /AC\.txt/ })
          .first()
          .waitFor();
      }),
    );
    await view('timeline', async () => {
      for (const width of WIDTHS) {
        const page = await visit(language, '/p/AC/tasks/AC-1/steps', { width, mock: mockTimeline });
        await page.evaluate(() => window.localStorage.setItem('pm:cardStory.view', 'all'));
        await page.reload();
        await shoot(page, `timeline-${language}-${width}`, { widths: [width], fullPage: true });
        await page.locator('[id="timeline-evt_main_10"]').scrollIntoViewIfNeeded();
        await shoot(page, `timeline-end-${language}-${width}`, { widths: [width] });
        await page.close();
      }
    });
    await view('for you', () =>
      atWidths(language, 'inbox', '/p/AC/inbox', (page) => page.waitForTimeout(800), { mock: mockInbox() }),
    );
    await view('for you, empty', () =>
      atWidths(language, 'inbox-empty', '/p/AC/inbox', (page) => page.waitForTimeout(800), {
        mock: mockInbox([]),
      }),
    );
    await view('messages', () => atWidths(language, 'messages', '/p/AC/messages'));
    await view('new message', () =>
      atWidths(language, 'message-new', '/p/AC/messages', async (page) => {
        await page.getByRole('button', { name: NEW_MESSAGE[language] }).click();
        await page.getByRole('dialog').waitFor();
      }),
    );
    await view('team', () => atWidths(language, 'team', '/p/AC/team'));
    await view('member', () => atWidths(language, 'member', `/p/AC/team/${developer.handle}`));
    await view('settings overview', () => atWidths(language, 'settings', '/p/AC/settings'));
    await view('project settings, edited', () =>
      atWidths(language, 'settings-project-edit', '/p/AC/settings/project', async (page) => {
        await page
          .getByRole('button', { name: /^(Edit|Szerkesztés)$/ })
          .first()
          .click();
        await page
          .getByText(language === 'en' ? 'Team language' : 'A csapat nyelve')
          .first()
          .waitFor();
      }),
    );
    await view('how we work, rule panel', () =>
      atWidths(language, 'how-we-work', '/p/AC/how-we-work', async (page) => {
        await page
          .getByRole('button', { name: /Code review/ })
          .first()
          .click();
        await page.waitForTimeout(500);
      }),
    );
    await view('session', () => atWidths(language, 'session', `/p/AC/sessions/${sessionId}`));
    await view('avatar menu', () =>
      atWidths(language, 'avatar-menu', '/p/AC', async (page) => {
        await page
          .getByRole('button', { name: /^(Account|Fiók)/ })
          .first()
          .click();
        await page.getByRole('radio').first().waitFor();
      }),
    );
    await view('not found', () => atWidths(language, 'not-found', '/p/AC/this-page-does-not-exist'));
  }

  await step('login, both languages', async () => {
    const page = await open({ path: '/p/AC' });
    await page.context().clearCookies();
    await page.evaluate(() => window.localStorage.removeItem('pm:language'));
    // The browser is Hungarian and holds no stored language, so the page before login opens in English.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await page.goto(new URL('/login', page.url()).href);
      await page.waitForFunction(() => document.documentElement.lang === 'en');
      await page.waitForSelector('form');
      await shoot(page, `login-en-${width}`, { widths: [width] });
      await page.getByRole('radio', { name: 'Magyar' }).click();
      await page.waitForFunction(() => document.documentElement.lang === 'hu');
      await shoot(page, `login-hu-${width}`, { widths: [width] });
      await page.evaluate(() => window.localStorage.removeItem('pm:language'));
    }
  });
  log(`owner ${owner}, developer ${developer.handle}`);
};
