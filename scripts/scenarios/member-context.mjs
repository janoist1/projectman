/** PM-998: owner preview, its read-only content and responsive error/empty states. */
export default async ({ instance, open, shoot, step }) => {
  async function shootPart(page, name) {
    for (const width of [1512, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 982 });
      await page
        .locator('section')
        .last()
        .evaluate((element) => element.scrollIntoView({ block: 'start' }));
      await shoot(page, name, { widths: [width] });
    }
  }
  const members = await instance.api('/api/projects/AC/members');
  const member = members.find((entry) => entry.kind === 'ai' && entry.role === 'developer');
  const operator = members.find((entry) => entry.kind === 'ai' && entry.role === 'ai_operator');
  const human = members.find((entry) => entry.kind === 'human');
  const path = `/p/AC/team/${member.handle}/context`;
  await step('Entry is absent for humans and admins', async () => {
    const humanProfile = await open({ path: `/p/AC/team/${human.handle}` });
    await humanProfile.locator('h1').filter({ hasText: human.displayName }).waitFor();
    if (await humanProfile.locator('a[href$="/context"]').count())
      throw new Error('A human profile must have no preview entry');
    await shoot(humanProfile, 'a-human-profile');
    const admin = await instance.invite({
      project: 'AC',
      email: 'context-admin@example.test',
      name: 'Preview Admin',
      access: 'admin',
    });
    const adminProfile = await open({ as: admin, path: `/p/AC/team/${member.handle}` });
    await adminProfile.locator('h1').filter({ hasText: member.displayName }).waitFor();
    if (await adminProfile.locator('a[href$="/context"]').count())
      throw new Error('An admin must have no preview entry');
    await shoot(adminProfile, 'a-admin-profile');
    await adminProfile.goto(new URL(path, adminProfile.url()).href);
    await adminProfile.getByText(/csak a projekt tulajdonosa/).waitFor();
    await shoot(adminProfile, 'l-admin-direct-link');
  });
  const page = await open({ path: `/p/AC/team/${member.handle}` });
  await step('Profile entry and first use', async () => {
    const entry = page.locator(`a[href="${path}"]`);
    await entry.waitFor();
    await shoot(page, 'a-profile-entry');
    await entry.click();
    await page.locator('time').waitFor();
    await shoot(page, 'k-first-use');
    await page.evaluate(() => localStorage.setItem('memberContext.introductionDismissed', 'yes'));
  });
  await step('General introduction and keyboard folds', async () => {
    await page.goto(new URL(path, page.url()).href);
    await page.locator('time').waitFor();
    const summary = page.locator('details summary').nth(1);
    await summary.focus();
    await page.keyboard.press('Enter');
    await shoot(page, 'b-general-section');
    await page.locator(`a[href="/p/AC/team/${member.handle}"]`).scrollIntoViewIfNeeded();
    await shoot(page, 'b-general');
  });
  await step('Task and keyboard picker', async () => {
    const general = page.locator('[role="group"] button').first();
    await general.focus();
    await page.keyboard.press('ArrowRight');
    const picker = page.locator('input[role="combobox"]');
    await shoot(page, 'c-task-unselected');
    await picker.fill('AC-1');
    await picker.press('ArrowDown');
    await picker.press('Escape');
    await picker.press('ArrowDown');
    await shoot(page, 'c-task-options');
    await picker.press('Enter');
    await page.waitForURL(/task=AC-1/);
    await page.locator('time').waitFor();
    await shoot(page, 'c-task-top');
    await page.locator('details summary').first().click();
    await page
      .locator('details')
      .first()
      .evaluate((element) => element.scrollIntoView({ block: 'start' }));
    await shoot(page, 'c-task');
  });
  await step('Operator guides and tool filtering', async () => {
    if (operator) {
      await page.goto(new URL(`/p/AC/team/${operator.handle}/context?part=guides`, page.url()).href);
      await page.locator('time').waitFor();
      const role = page.locator('details summary').filter({ hasText: 'role' });
      if (await role.count()) await role.first().click();
      await shoot(page, 'd-guides-operator');
    }
    await page.goto(new URL(`${path}?part=tools`, page.url()).href);
    await page.locator('time').waitFor();
    await page.locator('input').last().fill('task');
    await shootPart(page, 'e-tools-filter');
  });
  await step('Missing card and human', async () => {
    await page.goto(new URL(`${path}?task=AC-9999`, page.url()).href);
    await page.locator('input[aria-invalid="true"]').waitFor();
    await shoot(page, 'h-task-not-found');
    await page.goto(new URL(`/p/AC/team/${human.handle}/context`, page.url()).href);
    await page.locator('select option:checked').waitFor({ state: 'attached' });
    await page.getByText(/ember, ezért/).waitFor();
    await shoot(page, 'i-human');
    await page.goto(new URL('/p/AC/team/unknown/context', page.url()).href);
    await page.getByText(/Nincs ilyen tag/).waitFor();
    await shoot(page, 'i-missing-member');
  });
  await step('Empty guides and tools', async () => {
    const fixture = await instance.api(`/api/projects/AC/members/${member.handle}/context`);
    await page.route('**/api/projects/AC/members/*/context*', (route) =>
      route.fulfill({ json: { ...fixture, guides: [], tools: [] } }),
    );
    await page.goto(new URL(`${path}?part=guides`, page.url()).href);
    await page.locator('time').waitFor();
    await shootPart(page, 'j-empty-guides');
    await page.goto(new URL(`${path}?part=tools`, page.url()).href);
    await page.locator('time').waitFor();
    await shootPart(page, 'j-empty-tools');
    await page.unroute('**/api/projects/AC/members/*/context*');
  });
  await step('Loading, failure and forbidden response', async () => {
    let release;
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    await page.route('**/api/projects/AC/members/*/context*', async (route) => {
      await barrier;
      await route.continue();
    });
    await page.goto(new URL(path, page.url()).href);
    await page
      .getByRole('status')
      .filter({ hasText: /Készül az előnézet/ })
      .waitFor();
    await shoot(page, 'f-loading');
    release();
    await page.locator('time').waitFor();
    await page.unroute('**/api/projects/AC/members/*/context*');
    await page.route('**/api/projects/AC/members/*/context*', (route) =>
      route.fulfill({
        status: 503,
        json: { error: { code: 'internal_error', message: 'Preview unavailable' } },
      }),
    );
    await page.goto(new URL(path, page.url()).href);
    await page.getByRole('alert').waitFor();
    await shoot(page, 'g-error');
    await page.unroute('**/api/projects/AC/members/*/context*');
    await page.route('**/api/projects/AC/members/*/context*', (route) =>
      route.fulfill({
        status: 403,
        json: { error: { code: 'insufficient_access', message: 'Owner login required' } },
      }),
    );
    await page.goto(new URL(path, page.url()).href);
    await page.getByText(/csak a projekt tulajdonosa/).waitFor();
    await shoot(page, 'l-non-owner');
  });
};
