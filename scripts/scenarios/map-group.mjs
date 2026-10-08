import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * PM-407: the zoomed group of the Map (lanes, columns, arrows, the drawer over the map, the phone list) in both
 * themes, with a card in each of the five states, a done card and a card that waits for cards of another group.
 */

// A turn whose prompt contains LONGTOOL waits for this file, which never appears: the card keeps "working".
export const fakeEnv = { FAKE_CLAUDE_WORK_RELEASE_FILE: join(tmpdir(), 'pm-407-never-released') };

const DAY = 86_400_000;

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
  // Setup problems, repeated at the end so they survive the tail of the run's output.
  const notes = [];
  const moveTo = async (task, stageId) => {
    try {
      await patch(task.key, { stageId });
    } catch (error) {
      notes.push(`move ${task.key} to ${stageId}: ${error.message.slice(0, 300)}`);
    }
  };
  // The review gates belong to other members: the demo drops them, and the owner gives the release approval
  // (a release stage always keeps a human-only gate), so a card can reach "Kész".
  const finish = async (task) => {
    try {
      const { config, version } = await instance.api('/api/projects/AC/config');
      const stages = config.pipeline.stages.map((stage) => {
        if (stage.kind === 'release') return stage;
        const { gate, ...rest } = stage;
        return rest;
      });
      await instance.api('/api/projects/AC/config', {
        method: 'PATCH',
        body: { baseVersion: version, pipeline: { ...config.pipeline, stages } },
      });
      await instance.api(`${root}/${task.key}/labels`, {
        method: 'POST',
        body: { add: ['release-approved'] },
      });
    } catch (error) {
      notes.push(`drop gates: ${error.message.slice(0, 300)}`);
    }
    await moveTo(task, 'done');
  };

  // One session per AI member at a time: each card in a session state takes another developer.
  const developers = (await instance.api('/api/projects/AC/members')).filter(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  if (developers.length < 2) throw new Error('The demo has fewer than two developers.');
  const idle = async (task, developer) => {
    const id = await instance.startSession('AC', task.key, developer.handle);
    await instance.waitIdle('AC', id);
    return id;
  };

  const theme = await create({ kind: 'theme', title: 'Webshop checkout' });
  const payments = await create({ kind: 'theme', title: 'Payments' });
  const emptyTheme = await create({ kind: 'theme', title: 'Newsletter' });
  const card = (title, themeOf = theme) => create({ title, repo: 'webshop', themeKey: themeOf.key });

  const collector = await card('Payment package');
  // A subtask takes the theme of its parent.
  const part = (title) => create({ title, repo: 'webshop', parentKey: collector.key });
  const form = await part('Payment form');
  const provider = await part('Payment provider contract');
  const summary = await card('Order summary');
  const receipt = await card('Receipt e-mail');
  const labels = await card('Shipping labels');
  const history = await card('Order history');
  const gateway = await card('Payment gateway', payments);
  const refunds = await card('Refund rules', payments);
  log(`group ${theme.key}; other group ${payments.key}`);

  // The form asks a question (needs you), the contract works (a long turn).
  const formSession = await idle(form, developers[0]);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: 'Which payment provider should we use?' } },
  ]);
  await instance.say('AC', formSession, 'CALLS please');
  await instance.waitIdle('AC', formSession);
  await instance.say('AC', await idle(provider, developers[1]), 'LONGTOOL please');

  // Both developers are busy: the summary waits in the work stage, and three days later it counts as blocked.
  await moveTo(summary, 'dev');
  await finish(history);
  // The receipt waits for two cards of this group (arrows) and two of another one ("Vár erre … (másik csoport)").
  await patch(receipt.key, {
    relations: {
      add: [
        { kind: 'prerequisite', key: summary.key },
        { kind: 'prerequisite', key: form.key },
        { kind: 'prerequisite', key: gateway.key },
        { kind: 'prerequisite', key: refunds.key },
      ],
    },
  });
  await patch(form.key, { relations: { add: [{ kind: 'prerequisite', key: provider.key }] } });
  await moveTo(labels, 'ready');

  const zoom = `/p/AC/map/${theme.key}`;
  const heading = (page) => page.getByRole('heading', { level: 1, name: /Webshop checkout/ }).waitFor();
  const folder = join(process.env.PROJECTMAN_SESSION_DIR ?? tmpdir(), 'shots', 'map-group');
  mkdirSync(folder, { recursive: true });
  // The page scrolls inside MAIN, so a phone shot of a row further down scrolls to it first.
  const phoneShot = async (page, name, rowOf) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // The page swaps to the phone list at this width: let it settle before scrolling to a card of it.
    await page.waitForTimeout(600);
    await page.locator(`[data-card-key="${rowOf}"]`).first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(folder, `${name}-390.png`), animations: 'disabled' });
  };

  let page = await open({ path: zoom });
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);

  await step('zoom', async () => {
    await heading(page);
    await shoot(page, 'map-group', { widths: [1512, 1024, 768] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'map-group-dark', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('phone list', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await phoneShot(page, 'map-group-top', form.key);
    await phoneShot(page, 'map-group-waits', receipt.key);
    await page.emulateMedia({ colorScheme: 'dark' });
    await phoneShot(page, 'map-group-waits-dark', receipt.key);
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('arrows lit by focus and by the pointer', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.locator(`[data-card-key="${receipt.key}"] a`).first().focus();
    await shoot(page, 'map-group-arrows-focus', { widths: [1512] });
    await page.locator(`[data-card-key="${form.key}"]`).hover();
    await shoot(page, 'map-group-arrows-hover', { widths: [1512] });
  });

  await step('blocked three days later', async () => {
    page = await open({ path: zoom });
    await heading(page);
    await page.clock.setFixedTime(Date.now() + 3 * DAY);
    await page.reload();
    await heading(page);
    await shoot(page, 'map-group-blocked', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'map-group-blocked-dark', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('drawer over the map', async () => {
    page = await open({ path: `${zoom}/tasks/${form.key}` });
    await page.getByRole('complementary').first().waitFor();
    await shoot(page, 'map-group-drawer', { widths: [1512, 390] });
  });

  await step('filters', async () => {
    page = await open({ path: '/p/AC/map?show=needsYou' });
    await page
      .getByRole('link', { name: /Webshop checkout/ })
      .first()
      .click();
    await heading(page);
    await shoot(page, 'map-group-filter-needs-you', { widths: [1512, 390] });
    page = await open({ path: `${zoom}?show=blocked&member=@none` });
    await heading(page);
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
    await heading(page);
    await page.route(board, failing);
    await page.reload();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'map-group-error', { widths: [1512, 390] });
  });
  log(`PM-407 map group screenshots complete; ${notes.join(' | ') || 'no demo setup problems'}`);
};
