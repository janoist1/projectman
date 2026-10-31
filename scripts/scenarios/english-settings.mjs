/**
 * PM-1182: the settings sections, the notifications page and the owners list in English, and the project settings
 * in Hungarian (the team-language label and its hint).
 *
 * The owner's language is set through the API, so the logged-in pages read English. The disposable instance runs in
 * single-machine mode; the sections that need a cloud account show their own empty or single-machine states.
 *
 *   npm run shots -- scripts/scenarios/english-settings.mjs --widths 1512,390
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });

  const page = await open({ path: '/p/AC/settings' });
  const language = (value) => page.waitForFunction((lang) => document.documentElement.lang === lang, value);
  await language('en');

  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
    await language('en');
    // Let the page finish its first requests.
    await page.waitForLoadState('networkidle').catch(() => {});
  };

  await step('settings overview', async () => {
    await shoot(page, 'settings-overview-en', { widths: WIDTHS });
  });

  for (const section of [
    'pipeline',
    'limits',
    'engines',
    'owners',
    'integrator',
    'providers',
    'email',
    'account',
  ]) {
    await step(`section ${section}`, async () => {
      try {
        await visit(`/p/AC/settings/${section}`);
        await shoot(page, `settings-${section}-en`, { widths: WIDTHS });
      } catch (error) {
        log(`section ${section} not captured: ${error.message}`);
      }
    });
  }

  await step('project settings, edited, English', async () => {
    await visit('/p/AC/settings/project');
    await shoot(page, 'settings-project-en', { widths: WIDTHS });
    // The edit button's text is in the member-edit section of the locale, not translated by this card yet.
    const edit = page.getByRole('button', { name: /^(Edit|Szerkesztés)$/ }).first();
    await edit.click();
    await page.getByText('Team language').first().waitFor();
    await shoot(page, 'settings-project-edit-en', { widths: WIDTHS });
  });

  await step('notifications', async () => {
    await visit('/p/AC/notifications');
    await shoot(page, 'notifications-en', { widths: WIDTHS });
    // The lower part: the kinds of notification and the quiet hours.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await page.getByText('What should we let you know about?').first().scrollIntoViewIfNeeded();
      await page.getByText('Quiet hours').first().scrollIntoViewIfNeeded();
      await shoot(page, `notifications-lower-en-${width}`, { widths: [width], fullPage: false });
    }
  });

  await step('machine panel', async () => {
    for (const width of WIDTHS) {
      await visit('/p/AC');
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      try {
        await page.getByText('CPU').first().click({ timeout: 5000 });
        await page.getByText('Machine and sessions').first().waitFor({ timeout: 5000 });
      } catch (error) {
        log(`machine panel at ${width}: ${error.message}`);
      }
      await shoot(page, `machine-panel-en-${width}`, { widths: [width], fullPage: false });
    }
  });

  await step('schedule form of a member', async () => {
    try {
      const members = await instance.api('/api/projects/AC/members');
      const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
        await visit('/p/AC/team');
        // The edit action sits in the member's "⋯" menu (its labels are not translated by this card).
        await page.getByRole('button', { name: `További műveletek: ${pm.displayName}` }).click();
        await page.getByRole('button', { name: `Szerkesztés: ${pm.displayName}` }).click();
        await page.waitForSelector('dialog[open]');
        await page.locator('dialog[open] fieldset legend', { hasText: 'Schedule' }).scrollIntoViewIfNeeded();
        await shoot(page, `member-schedule-en-${width}`, { widths: [width], fullPage: false });
      }
    } catch (error) {
      log(`schedule form not captured: ${error.message}`);
    }
  });

  await step('project settings, Hungarian', async () => {
    await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'hu' } });
    await page.goto(new URL('/p/AC/settings/project', page.url()).href);
    await language('hu');
    await page.waitForLoadState('networkidle').catch(() => {});
    await page
      .getByRole('button', { name: /^Szerkesztés$/ })
      .first()
      .click();
    await page.getByText('A csapat nyelve').first().waitFor();
    await shoot(page, 'settings-project-edit-hu', { widths: WIDTHS });
  });
};
