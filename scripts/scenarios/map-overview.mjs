import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PM-406: the Map overview (menu, group tiles, filters, first use, empty states) in both themes. */

// A turn whose prompt contains LONGTOOL waits for this file, which never appears: the card keeps "working".
export const fakeEnv = { FAKE_CLAUDE_WORK_RELEASE_FILE: join(tmpdir(), 'pm-406-never-released') };

const DAY = 86_400_000;

export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  const create = (body) => instance.api(root, { method: 'POST', body });
  const failing = (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'screenshot_failure', message: 'Simulated failure' } }),
    });
  const board = '**/api/projects/AC/board';

  let page = await open({ path: '/p/AC/map' });
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);

  // The demo seed has four cards and no theme: the first-use state.
  await step('first use', async () => {
    await page.getByText(ui.map.firstUse.body, { exact: false }).first().waitFor();
    await shoot(page, 'map-first-use', { widths: [1512, 390] });
  });

  await step('empty project', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByText(ui.map.firstUse.body, { exact: false }).first().waitFor();
    await page.route(board, async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), tasks: [] } });
    });
    await page.reload();
    await page.getByText(ui.map.empty.title, { exact: true }).waitFor();
    await shoot(page, 'map-empty-project', { widths: [1512, 390] });
  });

  await step('loading', async () => {
    page = await open({ path: '/p/AC' });
    await page.route(board, () => {}); // never answered: the skeleton stays
    await page.goto(new URL('/p/AC/map', page.url()).href);
    await page.locator('ul[aria-busy="true"]').waitFor();
    const folder = join(process.env.PROJECTMAN_SESSION_DIR ?? tmpdir(), 'shots', 'map-overview');
    mkdirSync(folder, { recursive: true });
    await page.screenshot({ path: join(folder, 'map-loading-1512.png'), animations: 'disabled' });
  });

  // Themes with cards in every state: a question (needs you), a running session (working), an idle
  // session (waiting; blocked a day later), a closed theme's cards (done).
  // One session per AI member at a time: each card in a state takes another member.
  const developers = (await instance.api('/api/projects/AC/members')).filter(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  log(`developers: ${developers.map((member) => member.handle).join(', ')}`);
  if (developers.length < 2) throw new Error('The demo has fewer than two developers.');
  const moveTo = async (task, stageId) => {
    try {
      await instance.api(`${root}/${task.key}`, { method: 'PATCH', body: { stageId } });
    } catch (error) {
      log(`Could not move ${task.key} to ${stageId}: ${error.message}`);
    }
  };
  const themes = [];
  for (const title of ['Webshop checkout', 'Search relaunch', 'Mobile app', 'Newsletter']) {
    themes.push(await create({ kind: 'theme', title }));
  }
  const card = (theme, title) =>
    create({ title: `${theme.title}: ${title}`, repo: 'webshop', themeKey: theme.key });
  const idle = async (task, developer) => {
    const id = await instance.startSession('AC', task.key, developer.handle);
    await instance.waitIdle('AC', id);
    return id;
  };

  const question = await card(themes[0], 'payment form');
  await card(themes[0], 'order summary');
  const questionSession = await idle(question, developers[0]);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: 'Which payment provider should we use?' } },
  ]);
  await instance.say('AC', questionSession, 'CALLS please');
  await instance.waitIdle('AC', questionSession);

  const running = await card(themes[1], 'ranking');
  await card(themes[1], 'filters');
  await card(themes[1], 'suggestions');
  await instance.say('AC', await idle(running, developers[1]), 'LONGTOOL please');

  const stuck = await card(themes[2], 'push messages');
  await card(themes[2], 'offline mode');
  await card(themes[2], 'login');
  await card(themes[2], 'settings');
  // Both developers are busy: this card waits in the work stage, and a day later it counts as blocked.
  await moveTo(stuck, 'dev');

  for (const title of ['sign-up form', 'weekly digest']) {
    const finished = await card(themes[3], title);
    await moveTo(finished, 'done');
  }
  await create({ title: 'Loose card without a theme', repo: 'webshop' });

  await step('overview', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await shoot(page, 'map-overview', { widths: [1512, 800, 390, 360] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'map-overview-dark', { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('blocked a day later', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Mobile app/ }).waitFor();
    await page.clock.setFixedTime(Date.now() + 3 * DAY);
    await page.reload();
    await page.getByRole('link', { name: /Mobile app/ }).waitFor();
    await shoot(page, 'map-blocked', { widths: [1512, 390] });
    await page.goto(new URL('/p/AC/map?show=blocked', page.url()).href);
    await page.getByRole('link', { name: /Mobile app/ }).waitFor();
    await shoot(page, 'map-filter-blocked', { widths: [1512] });
  });

  await step('filters', async () => {
    page = await open({ path: '/p/AC/map?show=needsYou' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await shoot(page, 'map-filter-needs-you', { widths: [1512, 390] });
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await page.getByLabel(ui.map.member).selectOption({ index: 1 });
    await shoot(page, 'map-filter-member', { widths: [1512, 390] });
    // A filter that leaves nothing: the empty state with its single clear button.
    await page.goto(new URL('/p/AC/map?show=needsYou&member=@none', page.url()).href);
    await page.getByRole('button', { name: ui.map.clearFilters }).waitFor();
    await shoot(page, 'map-filter-empty', { widths: [1512] });
  });

  await step('keyboard focus', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    await page.getByRole('link', { name: /Webshop checkout/ }).focus();
    await shoot(page, 'map-tile-focus', { widths: [1512] });
  });

  await step('error', async () => {
    page = await open({ path: '/p/AC/map' });
    await page.getByRole('link', { name: /Webshop checkout/ }).waitFor();
    // The routes belong to the page: block the board request, then load the page again.
    await page.route(board, failing);
    await page.reload();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'map-error', { widths: [1512] });
  });
  log('PM-406 map screenshots complete');
};
