/**
 * PM-438: the project's focus (PM-427 4/4): the strip, the panel, the marks, the "Csak a fókusz" filter on the board,
 * the card's row, and the timeline of a card the system pulled ahead of its turn.
 *
 * `npm run shots -- scripts/scenarios/focus.mjs --widths 1512,390`
 *
 * The step that pulls a card is the server's (PM-436); until it is on the default branch the scenario shows the
 * timeline text by adding the `pulled` data to the card's own timeline answer in the browser (see `pull`).
 */
export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  const focusRoot = '/api/projects/AC/focus';
  const widths = [1512, 390];
  const create = (body) => instance.api(root, { method: 'POST', body });
  const card = (title, extra = {}) => create({ title, repo: 'webshop', ...extra });
  const addToFocus = (key) => instance.api(`${focusRoot}/items`, { method: 'POST', body: { key } });
  const failing = (status, code, message) => (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code, message } }),
    });
  const prefix = (template) => template.split('{')[0];

  let page = await open({ path: '/p/AC' });
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const board = async (path = '/p/AC', as) => {
    page = await open({ path, ...(as ? { as } : {}) });
    await page.getByRole('heading', { name: ui.board.title, exact: true }).waitFor();
    return page;
  };
  const openPanel = async (name) => {
    await page.getByRole('button', { name }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    return dialog;
  };
  const openButton = () => new RegExp(prefix(ui.focus.open));

  const checkout = await create({ kind: 'theme', title: 'Webshop checkout' });
  const payments = await create({ kind: 'theme', title: 'Payments' });
  const form = await card('Payment form', { themeKey: checkout.key });
  await card('Order summary', { themeKey: checkout.key });
  await card('Gateway contract', { themeKey: payments.key });
  const refunds = await card('Refund rules');
  const newsletter = await card('Newsletter signup in the footer');
  const outside = await card('Cart page speed-up');

  await step('no focus: the strip and the empty panel', async () => {
    await board();
    await page.getByText(ui.focus.empty).waitFor();
    await shoot(page, 'focus-strip-empty', { widths });
    await openPanel(ui.focus.setUp);
    await shoot(page, 'focus-panel-empty', { widths });
  });

  await addToFocus(checkout.key);
  await addToFocus(refunds.key);
  await addToFocus(newsletter.key);
  log(`focus: ${checkout.key} (theme), ${refunds.key}, ${newsletter.key}`);

  await step('the strip with a focus, and the panel with its list', async () => {
    await board();
    await page.getByRole('button', { name: openButton() }).waitFor();
    await shoot(page, 'focus-strip', { widths, highlight: `section[aria-label="${ui.focus.title}"]` });
    const dialog = await openPanel(openButton());
    await dialog.getByRole('list', { name: ui.focus.listLabel }).waitFor();
    await shoot(page, 'focus-panel', { widths });
    // The changes the three adds left, in the fold under the list.
    await dialog.getByText(ui.focus.changes, { exact: true }).click();
    await dialog.getByText(prefix(ui.timeline.events.focus_added).trim(), { exact: false }).first().waitFor();
    await shoot(page, 'focus-panel-changes', { widths });
  });

  await step('the panel search', async () => {
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: ui.focus.addLabel }).fill('pay');
    await dialog.getByRole('listbox').waitFor();
    await shoot(page, 'focus-panel-search', { widths });
    await dialog.getByRole('combobox', { name: ui.focus.addLabel }).fill('');
    await page.keyboard.press('Escape');
  });

  await step('the panel when a save is refused', async () => {
    // A refusal with a code of its own, as the server gives one (a full list); only its text follows ours.
    await page.route(
      '**/api/projects/AC/focus/items/**',
      failing(409, 'focus_full', 'The focus holds at most 20 items.'),
    );
    const dialog = page.getByRole('dialog');
    await dialog
      .getByRole('button', { name: new RegExp(`^${prefix(ui.focus.remove)}`) })
      .first()
      .click();
    await dialog.getByText(ui.focus.saveFailed, { exact: false }).waitFor();
    await shoot(page, 'focus-panel-save-error', { widths });
    await page.unroute('**/api/projects/AC/focus/items/**');
  });

  await step('the strip when the focus could not be read', async () => {
    await page.route('**/api/projects/AC/focus', failing(500, 'screenshot_failure', 'Simulated failure'));
    await page.goto(page.url().split('?')[0]);
    await page.getByText(ui.focus.loadFailed).waitFor();
    await shoot(page, 'focus-strip-error', { widths });
    await page.unroute('**/api/projects/AC/focus');
  });

  await step('the filter on the board', async () => {
    await board('/p/AC?focus=1');
    await page.getByRole('button', { name: ui.focus.only }).first().waitFor();
    await shoot(page, 'focus-board-filter', { widths });
  });

  await step('the row of a card in the focus through its theme, and one outside', async () => {
    // The strip says "Fókusz" too: the row's label is the one inside the card's drawer.
    const rowLabel = `[class*="propLabel"]:text-is("${ui.focus.row.label}")`;
    page = await open({ path: `/p/AC/tasks/${form.key}` });
    await page.locator(rowLabel).waitFor();
    await shoot(page, 'focus-drawer-row', { widths, highlight: rowLabel });
    // A card that is an item itself: its place and the "Levétel" button.
    page = await open({ path: `/p/AC/tasks/${refunds.key}` });
    await page.getByRole('button', { name: ui.focus.row.remove }).waitFor();
    await shoot(page, 'focus-drawer-row-remove', { widths, highlight: rowLabel });
    page = await open({ path: `/p/AC/tasks/${outside.key}` });
    await page.getByRole('button', { name: ui.focus.row.add }).waitFor();
    await shoot(page, 'focus-drawer-row-add', { widths, highlight: rowLabel });
  });

  await step('a member who may not change the focus', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    await board('/p/AC', colleague);
    await page.getByRole('button', { name: openButton() }).waitFor();
    await shoot(page, 'focus-strip-readonly', { widths });
    // The title button opens the panel at every width; "Részletek" is only beside the chips.
    await openPanel(openButton());
    await page.getByText(ui.focus.viewerNote).waitFor();
    await shoot(page, 'focus-panel-readonly', { widths });
  });

  await step('the timeline of a card the system pulled ahead of its turn', async () => {
    const urgent = await card('Fix the payment alert');
    const focused = await card('Newsletter confirmation e-mail');
    for (const task of [urgent, focused])
      await instance.api(`${root}/${task.key}`, { method: 'PATCH', body: { stageId: 'dev' } });
    // Add what the server will record when it pulls a card (PM-436): this only changes the answer the page reads.
    const pull = (pulled) => async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const mark = (value) => {
        if (Array.isArray(value)) value.forEach(mark);
        else if (value && typeof value === 'object') {
          if (value.type === 'task_stage_changed' && value.data) value.data.pulled = pulled;
          Object.values(value).forEach(mark);
        }
      };
      mark(body);
      await route.fulfill({ response, json: body });
    };
    const shootPulled = async (task, pulled, name) => {
      const pattern = `**/api/projects/AC/tasks/${task.key}`;
      page = await open({ path: '/p/AC' });
      await page.route(pattern, pull(pulled));
      await page.goto(`${new URL(page.url()).origin}/p/AC/tasks/${task.key}`);
      const text = prefix(ui.timeline.events.task_stage_changed_pulled_urgent).split(':')[0];
      await page.getByText(text, { exact: false }).first().waitFor();
      await shoot(page, name, { widths, highlight: `text=${text} >> visible=true` });
      await page.unroute(pattern);
    };
    await shootPulled(urgent, { reason: 'urgent' }, 'focus-timeline-pulled-urgent');
    await shootPulled(
      focused,
      { reason: 'focus', position: 3, key: newsletter.key, title: newsletter.title },
      'focus-timeline-pulled-focus',
    );
  });
};
