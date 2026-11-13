/** PM-1345: a collector with 15 sub-cards (10 done, 2 cancelled, 3 open), at 1512 and 390 px. */
export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  const { config } = await instance.api('/api/projects/AC/config');
  const done = config.pipeline.stages.find((stage) => stage.kind === 'done');
  const ready = config.pipeline.stages.find((stage) => stage.kind === 'queue');
  const review = config.pipeline.stages.find((stage) => stage.kind === 'step');
  for (const task of await instance.api(root))
    if (task.stageId === ready.id && task.status !== 'cancelled' && task.status !== 'done')
      await instance.api(`${root}/${task.key}/cancel`, { method: 'POST', body: {} });
  const parent = await instance.api(root, {
    method: 'POST',
    body: { title: 'PM-1345 collecting card', repo: 'webshop' },
  });
  // Keep open children throughout setup, so auto-close never closes the parent prematurely.
  for (let index = 0; index < 15; index++) {
    const child = await instance.api(root, {
      method: 'POST',
      body: {
        title: `Sub-card ${index + 1}`,
        parentKey: parent.key,
        repo: null,
        stageId: index >= 3 && index < 13 ? done.id : review.id,
        ...(index >= 3 && index < 13 ? { importedAt: new Date().toISOString() } : {}),
      },
    });
    if (index >= 13) {
      await instance.api(`${root}/${child.key}/cancel`, { method: 'POST', body: {} });
    }
  }
  if (parent.stageId !== ready.id)
    await instance.api(`${root}/${parent.key}`, { method: 'PATCH', body: { stageId: ready.id } });

  const page = await open({ path: '/p/AC' });
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu/index.ts')).hu);
  const status = ui.taskStatus.collecting.replace('{count}', '3');
  await step('collector on the board', async () => {
    await page.getByText(status, { exact: true }).first().waitFor();
    await shoot(page, 'collecting-board', { widths: [1512, 390] });
  });
  await step('collector drawer', async () => {
    await page.goto(new URL(`/p/AC/tasks/${parent.key}`, page.url()).href);
    const drawer = page.getByRole('complementary', { name: ui.task.drawerLabel });
    await drawer.getByText(status, { exact: true }).waitFor();
    if (await drawer.getByRole('button', { name: ui.task.start, exact: true }).count())
      throw new Error('A collecting card offers Start');
    if (await drawer.getByLabel(ui.task.assigneeLabel).count())
      throw new Error('A collecting card offers an assignee picker');
    await shoot(page, 'collecting-drawer', { widths: [1512, 390] });
  });
  await step('real server refuses a start', async () => {
    const refusal = await page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      return { status: response.status, body: await response.json() };
    }, `${root}/${parent.key}/start`);
    if (refusal.status !== 409 || refusal.body.error?.code !== 'collecting_task_not_startable')
      throw new Error(`Unexpected start response: ${JSON.stringify(refusal)}`);
    log(`Real server start refusal: ${JSON.stringify(refusal)}`);
  });
  await step('a stale drawer displays the real server refusal', async () => {
    const stale = await instance.api(root, {
      method: 'POST',
      body: { title: 'PM-1345 stale view', repo: 'webshop' },
    });
    // Keep a real connection, but stop consuming pushes after loading the leaf. No HTTP response is mocked.
    await page.addInitScript(() => {
      const NativeSocket = window.WebSocket;
      window.collectingScenarioSockets = [];
      window.WebSocket = class extends NativeSocket {
        constructor(...args) {
          super(...args);
          window.collectingScenarioSockets.push(this);
        }
      };
    });
    await page.goto(new URL(`/p/AC/tasks/${stale.key}`, page.url()).href);
    const start = page.getByRole('button', { name: ui.task.start, exact: true });
    await start.waitFor();
    await page.waitForFunction(() =>
      window.collectingScenarioSockets.some((socket) => socket.readyState === WebSocket.OPEN),
    );
    await page.evaluate(() => {
      for (const socket of window.collectingScenarioSockets) socket.onmessage = null;
    });
    await instance.api(root, {
      method: 'POST',
      body: { title: 'New open sub-card', parentKey: stale.key, stageId: review.id },
    });
    await start.click();
    await page
      .getByRole('alert')
      .filter({ hasText: ui.errors.codes.collecting_task_not_startable })
      .waitFor();
    await shoot(page, 'collecting-start-refused', { widths: [1512, 390] });
  });
};
