/**
 * PM-1387 (L-06): the process labels on the cards. A card in progress shows every label; a done card folds its process
 * labels into a "+n" chip and keeps its area labels, and its drawer opens them with a button, in full and wrapped.
 * The pipeline gets a real `has_label … when` pair (plan ok when plan needed) and two long label names; the labels are
 * put on a card through the API. The demo has no done card, so the board and the card answers move one card to the
 * done stage in the browser (as `english-board-card.mjs` does). It shoots, in both styles and both colour schemes,
 * at 1512 and 390 px:
 *
 *   a. the board with the done card (area label + "+n") beside a card in progress that shows its labels
 *   b. the drawer of the done card, folded
 *   c. the same drawer with the process labels opened
 *   d. the same drawer with the label editor open (every applied label)
 *
 *   npm run shots -- scripts/scenarios/process-labels-fold.mjs [--widths 1512,390]
 */
const STYLES = ['classic', 'win311'];
const SCHEMES = ['light', 'dark'];
const WIDTHS = [1512, 390];

// A label name is at most 60 characters.
const LONG_NAME = 'Kiemelt ügyfélteszt jóváhagyása kiadás előtt, egyeztetve';
const LONG_WORD = 'Hosszúegyszavascímkenévszóközésortöréspontnélkül';

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const stages = config.pipeline.stages;
  const done = stages.find((stage) => stage.kind === 'done');
  const work = stages.find((stage) => stage.kind === 'work');
  if (!done || !work) throw new Error('The demo pipeline needs a work and a done stage.');

  // One real pair, and two long process labels (blocking labels count as process labels).
  const labels = [
    ...config.pipeline.labels,
    { id: 'needs-plan', name: 'Műszaki terv kell', color: 'yellow', setBy: 'anyone' },
    { id: 'plan-ok', name: 'Műszaki terv kész', color: 'green', setBy: 'anyone' },
    { id: 'long-name', name: LONG_NAME, color: 'blue', setBy: 'anyone', blocks: true },
    { id: 'long-word', name: LONG_WORD, color: 'purple', setBy: 'anyone', blocks: true },
  ];
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        labels,
        stages: stages.map((stage) =>
          stage.id === work.id
            ? {
                ...stage,
                gate: {
                  conditions: [
                    ...(stage.gate?.conditions ?? []),
                    { type: 'has_label', label: 'plan-ok', when: 'needs-plan' },
                  ],
                },
              }
            : stage,
        ),
      },
    },
  });

  const { tasks } = await instance.api('/api/projects/AC/board');
  const [closed, active] = tasks.filter((task) => task.status === 'active').slice(0, 2);
  if (!closed || !active) throw new Error('The demo board needs two cards.');
  const add = (key, ids) =>
    instance.api(`/api/projects/AC/tasks/${key}/labels`, { method: 'POST', body: { add: ids } });
  // The owner may set these; a valid state per group, and both labels of the pair on the done card.
  await add(closed.key, ['checkout', 'needs-plan', 'plan-ok', 'client-accepted', 'long-name', 'long-word']);
  await add(active.key, ['checkout', 'needs-plan']);
  log(`done card ${closed.key}, active card ${active.key}`);

  const toDone = (task) => (task.key === closed.key ? { ...task, stageId: done.id, status: 'done' } : task);
  const prepare = async (page) => {
    await page.route('**/api/projects/AC/board', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.tasks = body.tasks.map(toDone);
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/projects/AC/tasks/${closed.key}`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.task = toDone(body.task);
      await route.fulfill({ response, json: body });
    });
  };
  const visit = async (scheme, path, ready) => {
    const page = await open({ path: '/p/AC' });
    await page.emulateMedia({ colorScheme: scheme });
    await prepare(page);
    await page.goto(`${instance.webUrl}${path}`);
    await page.locator(ready).first().waitFor();
    return page;
  };

  for (const style of STYLES) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of SCHEMES) {
      const name = `${style}-${scheme}`;
      await step(`${name}: the board`, async () => {
        const page = await visit(scheme, '/p/AC', '[data-label="checkout"]');
        await shoot(page, `${name}-board`, { widths: WIDTHS });
      });
      await step(`${name}: the drawer`, async () => {
        const page = await visit(scheme, `/p/AC/tasks/${closed.key}`, 'button[aria-expanded]');
        await shoot(page, `${name}-drawer-folded`, { widths: WIDTHS });
        await page.getByRole('button', { name: /folyamatcímke/ }).click();
        await page.waitForTimeout(200);
        await shoot(page, `${name}-drawer-open`, { widths: WIDTHS });
        await page.getByRole('button', { name: 'Címke hozzáadása' }).click();
        await page.waitForTimeout(200);
        await shoot(page, `${name}-drawer-editor`, { widths: WIDTHS });
      });
    }
  }
};
