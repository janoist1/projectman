/** PM-287: marks, saving, filters, failures and read-only priority details. */
export default async ({ instance, open, shoot, step, log }) => {
  const root = '/api/projects/AC/tasks';
  const boardPath = '/p/AC';
  const levels = ['urgent', 'high', 'normal', 'low'];
  const cards = new Map();
  const select = (scope) => scope.locator('select:has(option[value="urgent"])');
  let page = await open({ path: boardPath });
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const drawer = () => page.getByRole('complementary', { name: ui.task.drawerLabel });
  await page.getByRole('heading', { name: ui.board.title, exact: true }).waitFor();

  await step('first use', async () => {
    if (await select(page).count()) throw new Error('The unused priority filter is visible');
    await shoot(page, 'priority-first-use', { widths: [1512, 390] });
  });
  for (const level of [...levels, 'unset', 'closed']) {
    const card = await instance.api(root, {
      method: 'POST',
      body: { title: `PM-287 ${level} example`, repo: 'webshop' },
    });
    cards.set(level, card);
    if (levels.includes(level) || level === 'closed')
      await instance.api(`${root}/${card.key}`, {
        method: 'PATCH',
        body: { priority: level === 'closed' ? 'high' : level },
      });
    if (level === 'closed') await instance.api(`${root}/${card.key}/cancel`, { method: 'POST', body: {} });
  }
  const cardPath = (level) => `/p/AC/tasks/${cards.get(level).key}`;

  await step('four marks and dark theme', async () => {
    page = await open({ path: boardPath });
    await select(page).waitFor();
    await shoot(page, 'priority-board', { widths: [1512, 800, 390, 375] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'priority-board-dark', { widths: [1512, 390] });
  });
  await step('drawer saving and timeline', async () => {
    page = await open({ path: cardPath('unset') });
    await select(drawer()).selectOption('high');
    const line = ui.timeline.priorityChange
      .replace('{previous}', ui.timeline.noPriority)
      .replace('{priority}', ui.priority.levels.high);
    await page.waitForFunction((text) => document.body.innerText.includes(text), line);
    await shoot(page, 'priority-drawer-saved', { widths: [1512, 390] });
    await select(drawer()).selectOption('');
    await page.waitForFunction(() =>
      [...document.querySelectorAll('select')].some(
        (element) =>
          element.querySelector('option[value="urgent"]') && element.value === '' && !element.disabled,
      ),
    );
  });
  await step('open native priority picker', async () => {
    for (const width of [1512, 390]) {
      page = await open({ path: cardPath('high'), width });
      const picker = select(drawer());
      await picker.waitFor();
      await picker.scrollIntoViewIfNeeded();
      // Prepare the layout before opening the native picker: resizing can dismiss it.
      const [file] = await shoot(page, 'priority-drawer-picker', { widths: [width] });
      await picker.click();
      await page.screenshot({ path: file, fullPage: false, animations: 'disabled', caret: 'hide' });
      await picker.press('Escape');
      log(`Native priority picker captured at ${width}px; inspect native popup visibility`);
    }
  });
  await step('large view', async () => {
    page = await open({ path: `${cardPath('normal')}?size=large` });
    await select(page.getByRole('dialog', { name: ui.task.drawerLabel })).waitFor();
    await shoot(page, 'priority-large', { widths: [1512, 800] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'priority-large-dark', { widths: [1512] });
  });
  await step('failed saving restores the value and focus', async () => {
    page = await open({ path: cardPath('normal') });
    const pattern = `**${root}/${cards.get('normal').key}`;
    await page.route(pattern, async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'screenshot_failure', message: 'Simulated failure' } }),
      });
    });
    await select(drawer()).selectOption('urgent');
    await page.getByRole('alert').waitFor();
    await page.waitForFunction(
      () =>
        document.activeElement?.tagName === 'SELECT' &&
        document.activeElement.value === 'normal' &&
        !document.activeElement.disabled,
    );
    await shoot(page, 'priority-save-failed', { widths: [1512, 390] });
    await page.unroute(pattern);
  });
  await step('desktop filters and empty result', async () => {
    page = await open({ path: boardPath });
    await select(page).selectOption('high');
    await shoot(page, 'priority-filter-high', { widths: [1512] });
    await select(page).selectOption('@none');
    await shoot(page, 'priority-filter-unset', { widths: [1512] });
    await select(page).selectOption('urgent');
    await instance.api(`${root}/${cards.get('urgent').key}`, { method: 'PATCH', body: { priority: null } });
    await page.getByText(ui.board.filteredEmpty, { exact: true }).waitFor();
    await shoot(page, 'priority-filter-empty', { widths: [1512] });
  });
  await step('phone sheet and removable chip', async () => {
    page = await open({ path: boardPath, width: 390 });
    await page.getByRole('button', { name: ui.board.filterButton, exact: true }).click();
    const sheet = page.getByRole('dialog', { name: ui.board.filterSheetTitle });
    await select(sheet).selectOption('high');
    await shoot(page, 'priority-phone-sheet', { widths: [390, 375] });
    await sheet.getByRole('button', { name: ui.board.filterShow.replace('{count}', '1') }).click();
    await shoot(page, 'priority-phone-chip', { widths: [390, 375] });
    const value = ui.board.filterPriorityValue.replace('{level}', ui.priority.levels.high);
    await page.getByRole('button', { name: ui.board.filterChipRemove.replace('{value}', value) }).click();
  });
  await step('closed card details', async () => {
    page = await open({ path: cardPath('closed') });
    await select(drawer()).waitFor();
    await shoot(page, 'priority-closed-details', { widths: [1512] });
  });
  await step('viewer and unset priority', async () => {
    const viewer = await instance.invite({
      project: 'AC',
      email: 'priority-viewer@example.test',
      name: 'Priority Viewer',
      access: 'viewer',
    });
    page = await open({ as: viewer, path: cardPath('high') });
    await drawer().getByText(ui.priority.levels.high, { exact: true }).waitFor();
    if (await select(drawer()).count()) throw new Error('The viewer can edit priority');
    await shoot(page, 'priority-viewer', { widths: [1512, 390] });
    page = await open({ as: viewer, path: cardPath('unset') });
    await drawer().getByText(cards.get('unset').title, { exact: true }).waitFor();
    if (await drawer().getByText(ui.priority.label, { exact: true }).count())
      throw new Error('The viewer sees an unset priority row');
    await shoot(page, 'priority-viewer-unset', { widths: [1512] });
  });
  log('PM-287 priority screenshots complete');
};
