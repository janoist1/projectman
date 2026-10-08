import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** PM-407: the zoomed group of the Map (lanes, columns, arrows, drawer over the map, phone list) in both themes. */

export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  const create = (body) => instance.api(root, { method: 'POST', body });
  const patch = (key, body) => instance.api(`${root}/${key}`, { method: 'PATCH', body });
  const failing = (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'screenshot_failure', message: 'Simulated failure' } }),
    });
  const board = '**/api/projects/AC/board';
  const moveTo = async (task, stageId) => {
    try {
      await patch(task.key, { stageId });
    } catch (error) {
      log(`Could not move ${task.key} to ${stageId}: ${error.message}`);
    }
  };

  const theme = await create({ kind: 'theme', title: 'Webshop checkout' });
  const emptyTheme = await create({ kind: 'theme', title: 'Newsletter' });
  const card = (title) => create({ title, repo: 'webshop', themeKey: theme.key });

  const collector = await card('Payment package');
  // A subtask takes the theme of its parent.
  const part = (title) => create({ title, repo: 'webshop', parentKey: collector.key });
  const form = await part('Payment form');
  const provider = await part('Payment provider contract');
  const summary = await card('Order summary');
  const receipt = await card('Receipt e-mail');
  const old = await card('Shipping labels');
  const shipped = await card('Order history');
  await moveTo(shipped, 'done');
  await moveTo(provider, 'dev');
  await moveTo(old, 'ready');
  // The form waits for the provider contract, the receipt for the summary and the form.
  await patch(form.key, { relations: { add: [{ kind: 'prerequisite', key: provider.key }] } });
  await patch(receipt.key, {
    relations: {
      add: [
        { kind: 'prerequisite', key: summary.key },
        { kind: 'prerequisite', key: form.key },
      ],
    },
  });
  log(
    `group ${theme.key}: ${[collector, form, provider, summary, receipt, old].map((c) => c.key).join(', ')}`,
  );

  const zoom = `/p/AC/map/${theme.key}`;
  let page = await open({ path: zoom });
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const ready = () => page.getByRole('heading', { level: 1, name: /Webshop checkout/ }).waitFor();

  await step('zoom', async () => {
    await ready();
    await shoot(page, 'map-group', { widths: [1512, 1024, 768, 390] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'map-group-dark', { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('arrows lit by focus', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.locator(`[data-card-key="${receipt.key}"] a`).first().focus();
    await shoot(page, 'map-group-arrows-focus', { widths: [1512] });
  });

  await step('drawer over the map', async () => {
    page = await open({ path: `${zoom}/tasks/${form.key}` });
    await page.getByRole('complementary').first().waitFor();
    await shoot(page, 'map-group-drawer', { widths: [1512, 390] });
  });

  await step('filters', async () => {
    page = await open({ path: `${zoom}?show=needsYou` });
    await ready();
    await shoot(page, 'map-group-filter-empty', { widths: [1512, 390] });
    page = await open({ path: `/p/AC/map/${emptyTheme.key}` });
    await page.getByRole('heading', { level: 1, name: /Newsletter/ }).waitFor();
    await shoot(page, 'map-group-no-cards', { widths: [1512, 390] });
  });

  await step('not found', async () => {
    page = await open({ path: '/p/AC/map/AC-9999' });
    await page.getByText(ui.map.group.notFound.title, { exact: true }).waitFor();
    await shoot(page, 'map-group-not-found', { widths: [1512, 390] });
  });

  await step('loading', async () => {
    page = await open({ path: '/p/AC' });
    await page.route(board, () => {}); // never answered: the skeleton stays
    await page.goto(new URL(zoom, page.url()).href);
    await page.locator('[aria-busy="true"]').first().waitFor();
    const folder = join(process.env.PROJECTMAN_SESSION_DIR ?? tmpdir(), 'shots', 'map-group');
    mkdirSync(folder, { recursive: true });
    for (const [width, height] of [
      [1512, 982],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await page.screenshot({ path: join(folder, `map-group-loading-${width}.png`), animations: 'disabled' });
    }
  });

  await step('error', async () => {
    page = await open({ path: zoom });
    await ready();
    await page.route(board, failing);
    await page.reload();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'map-group-error', { widths: [1512, 390] });
  });
  log('PM-407 map group screenshots complete');
};
