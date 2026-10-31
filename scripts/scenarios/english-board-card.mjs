/** PM-1179: English board/card translations; configured names and card content stay Hungarian. */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });
  const { config } = await instance.api('/api/projects/AC/config');
  const firstStage = config.pipeline.stages[0].id;
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
        { op: 'add', text: 'AC-1' },
        { op: 'add', text: 'AC-2' },
      ],
    },
  });
  const page = await open({ path: '/p/AC' });
  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
  };
  await step('board, themes and filters', async () => {
    await page.getByRole('heading', { name: 'Board', exact: true }).waitFor();
    await shoot(page, 'board-en', { widths: WIDTHS });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await shoot(page, 'filters-en', { widths: [390] });
    await page.keyboard.press('Escape');
  });
  await step('card, relations, acceptance and attachments', async () => {
    await visit('/p/AC/tasks/AC-1');
    await page.getByRole('heading', { name: 'Acceptance items', exact: true }).waitFor();
    await shoot(page, 'card-en', { widths: WIDTHS });
    await page.getByRole('heading', { name: 'Acceptance items', exact: true }).scrollIntoViewIfNeeded();
    await shoot(page, 'acceptance-en', {
      widths: WIDTHS,
      highlight: '[aria-labelledby="acceptance-title-AC-1"]',
      fullPage: false,
    });
    await page.getByRole('button', { name: 'Add relation', exact: true }).click();
    await page.getByRole('dialog', { name: 'Add relation' }).waitFor();
    await shoot(page, 'relation-dialog-en', { widths: WIDTHS });
    await page.keyboard.press('Escape');
    await visit('/p/AC/tasks/AC-1/attachments');
    await page.getByText('No attachments yet.', { exact: true }).waitFor();
    await shoot(page, 'attachments-empty-en', { widths: WIDTHS });
    await page
      .getByLabel('Choose files to attach', { exact: true })
      .setInputFiles({ name: 'AC.txt', mimeType: 'text/plain', buffer: Buffer.from('AC') });
    await page.getByRole('link', { name: 'Download AC.txt' }).waitFor();
    await shoot(page, 'attachments-en', { widths: WIDTHS });
    const developer = (await instance.api('/api/projects/AC/members')).find(
      (member) => member.kind === 'ai' && member.role === 'developer',
    );
    const session = await instance.startSession('AC', 'AC-1', developer.handle);
    await instance.waitIdle('AC', session);
    await visit('/p/AC/tasks/AC-1');
    await page.getByRole('heading', { name: 'Token usage', exact: true }).scrollIntoViewIfNeeded();
    await shoot(page, 'measurement-en', { widths: WIDTHS, highlight: '#task-usage' });
  });
  await step('merge conflict', async () => {
    const merge = {
      id: 'merge-demo',
      repo: 'webshop',
      base: 'main',
      toStageId: firstStage,
      merger: 'owner',
      requestedAt: new Date().toISOString(),
      state: 'failed',
      landed: 'nowhere',
      commit: 'abc1234',
      failure: {
        reason: 'conflict',
        at: new Date().toISOString(),
        base: 'def5678',
        files: ['src/cart.ts', 'src/orders.ts'],
      },
    };
    await page.route('**/api/projects/AC/board', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.tasks = body.tasks.map((card) => (card.key === 'AC-1' ? { ...card, merge } : card));
      await route.fulfill({ response, json: body });
    });
    await page.route('**/api/projects/AC/tasks/AC-1', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.task.merge = merge;
      await route.fulfill({ response, json: body });
    });
    await visit('/p/AC/tasks/AC-1');
    await page.getByTestId('merge-box').waitFor();
    await page.getByTestId('merge-box').scrollIntoViewIfNeeded();
    await shoot(page, 'merge-conflict-en', { widths: WIDTHS });
    await page.unroute('**/api/projects/AC/board');
    await page.unroute('**/api/projects/AC/tasks/AC-1');
  });
  await step('new card and projects', async () => {
    await visit('/p/AC');
    await page.getByRole('button', { name: 'New card', exact: true }).first().click();
    await page.getByRole('dialog').waitFor();
    await shoot(page, 'new-card-en', { widths: WIDTHS });
    await visit('/p/AC');
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await page.getByRole('button', { name: `Switch project: ${config.project.name}`, exact: true }).click();
      await shoot(page, 'projects-en', { widths: [width] });
      await page.keyboard.press('Escape');
    }
    await page.route('**/api/providers', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.providers = body.providers.map((provider) => ({
        ...provider,
        loggedIn: false,
        problem: 'not_logged_in',
      }));
      await route.fulfill({ response, json: body });
    });
    await visit('/projects/new');
    await page.getByRole('heading', { name: 'New project', exact: true }).waitFor();
    await page.getByText('No provider is ready.', { exact: true }).waitFor();
    await shoot(page, 'create-project-top-en', { widths: WIDTHS });
    await shoot(page, 'create-project-en', { widths: WIDTHS, highlight: '[role="note"]', fullPage: false });
    await page.unroute('**/api/providers');
  });
  await step('map conflict and error', async () => {
    const stamp = new Date().toISOString();
    const structure = {
      repos: [
        {
          repo: 'webshop',
          status: 'ok',
          problem: null,
          reason: null,
          commit: 'fixture',
          readAt: stamp,
          truncated: false,
          map: {
            version: 1,
            ignore: [],
            areas: [{ id: 'app', name: config.project.name, summary: '' }],
            modules: [
              {
                id: 'web',
                area: 'app',
                name: config.project.name,
                summary: '',
                kind: 'module',
                paths: ['src/'],
              },
            ],
            links: [],
          },
          sizes: [{ id: 'web', files: 10 }],
          unmapped: { count: 0, examples: [] },
          cards: ['AC-1', 'AC-2'].map((taskKey) => ({
            taskKey,
            source: 'branch',
            commit: 'fixture',
            files: 2,
            modules: [{ id: 'web', files: 2 }],
            unmapped: [],
            truncated: false,
          })),
        },
      ],
    };
    await page.route('**/api/projects/AC/structure', (route) => route.fulfill({ json: structure }));
    await visit('/p/AC/map');
    await page.locator('[data-module="web"]').waitFor();
    await shoot(page, 'map-conflict-en', { widths: WIDTHS });
    await page.unroute('**/api/projects/AC/structure');
    await page.route('**/api/projects/AC/structure', (route) =>
      route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Fixture error' } } }),
    );
    await visit('/p/AC/map');
    await page.getByText('Couldn’t load the structure', { exact: true }).waitFor();
    await shoot(page, 'map-error-en', { widths: WIDTHS });
  });
  await step('Hungarian board unchanged', async () => {
    await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'hu' } });
    await page.goto(new URL('/p/AC', page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'hu');
    await shoot(page, 'board-hu', { widths: [1512] });
  });
};
