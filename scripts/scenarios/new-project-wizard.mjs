/**
 * Scenario for PM-439 (docs/SCREENSHOTS.md): the "new project" wizard and the card mover. It shoots, at 1512
 * and 390 px:
 *
 *   a. the five steps: name, kind, mover (with "one person" chosen), code
 *   b. the summary that works ("Működik"), as the real server's preview builds it
 *   c. the summary that does not work: the red issue list with its fix link and the disabled button
 *   d. a refused create: the reason, with the entered data kept
 *   e. the settings, "Ki viszi tovább a kártyákat?", and the refusal of a choice
 *   f. the "Hogyan dolgozunk" flow with the mover line
 *
 * The two refusals are the server's answers put in by the browser (page.route): the demo project has no
 * configuration that the server's own rules would refuse.
 *
 *   npm run shots -- scripts/scenarios/new-project-wizard.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: projects.create, settings.team.mover).
const TEXT = {
  name: 'Név',
  next: 'Tovább',
  back: 'Vissza',
  kindTitle: 'Mire lesz a projekt?',
  moverTitle: 'Ki viszi tovább a kártyákat?',
  codeTitle: 'Hol a kód?',
  summaryTitle: 'Így halad egy kártya',
  workspace: 'Munkaterület útvonala',
  human: 'Egy ember',
  projectManager: 'A Projektmenedzser',
  ok: 'Működik.',
  bad: 'Így még nem működne:',
  submit: 'Projekt létrehozása',
  rejected: 'A szerver nem hozta létre a projektet',
  mover: 'Módosítás',
  saved: 'A beállítások mentve.',
};
const WIDTHS = [1512, 390];
const MOVER_GROUP = 'section[aria-labelledby="settings-mover-title"]';
const ISSUE = { code: 'work_stage_without_worker', path: 'pipeline.stages[2]' };

const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

export default async ({ open, shoot, step }) => {
  const page = await open({ path: '/projects/new' });
  const next = () => page.getByRole('button', { name: TEXT.next }).click();
  const title = (text) => page.getByRole('heading', { name: text }).waitFor();

  await step('a. name, kind, mover, code', async () => {
    await page.getByLabel(TEXT.name, { exact: true }).fill('Acme Web');
    await shoot(page, 'a1-name', { widths: WIDTHS });
    await next();
    await title(TEXT.kindTitle);
    await page.getByRole('radio').first().waitFor();
    await shoot(page, 'a2-kind', { widths: WIDTHS });
    await next();
    await title(TEXT.moverTitle);
    await shoot(page, 'a3-mover-worker', { widths: WIDTHS });
    await page.getByText(TEXT.human, { exact: true }).click();
    await shoot(page, 'a4-mover-person', { widths: WIDTHS });
    await page.getByText(TEXT.projectManager, { exact: true }).click();
    await next();
    await title(TEXT.codeTitle);
    await page.getByLabel(TEXT.workspace).fill('/Users/demo/Dev/acme-web');
    await shoot(page, 'a5-code', { widths: WIDTHS });
  });

  await step('b. the summary that works', async () => {
    await next();
    await title(TEXT.summaryTitle);
    await page.getByText(TEXT.ok).waitFor();
    await shoot(page, 'b-summary-works', { widths: WIDTHS });
  });

  await step('c. the summary that does not work', async () => {
    // The preview with an issue put into it, the way the server answers for a pipeline with a stage nobody works in.
    await page.route('**/api/projects/preview', async (route) => {
      const response = await route.fetch();
      const preview = await response.json();
      await route.fulfill({ response, json: { ...preview, issues: [ISSUE] } });
    });
    await page.getByRole('button', { name: TEXT.back }).click();
    await title(TEXT.codeTitle);
    await next();
    await title(TEXT.summaryTitle);
    await page.getByText(TEXT.bad).waitFor();
    await shoot(page, 'c-summary-broken', { widths: WIDTHS });
    await page.unroute('**/api/projects/preview');
  });

  await step('d. a refused create', async () => {
    await page.route('**/api/projects', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill(
        json(422, { error: { code: 'invalid_config', message: 'invalid', details: { issues: [ISSUE] } } }),
      );
    });
    await page.getByRole('button', { name: TEXT.back }).click();
    await title(TEXT.codeTitle);
    await next();
    await page.getByText(TEXT.ok).waitFor();
    await page.getByRole('button', { name: TEXT.submit }).click();
    await page.getByText(TEXT.rejected, { exact: false }).waitFor();
    await shoot(page, 'd-rejected', { widths: WIDTHS });
  });

  await step('e. the settings, with a refused choice', async () => {
    const settings = await open({ path: '/p/AC/settings/team' });
    const group = settings.getByRole('region', { name: TEXT.moverTitle });
    await group.waitFor();
    // The app scrolls inside its main area: the highlight scrolls the group into view (and outlines it in the image).
    const shootGroup = (name) => shoot(settings, name, { widths: WIDTHS, highlight: MOVER_GROUP });
    await shootGroup('e1-settings-mover');
    await group.getByText(TEXT.human, { exact: true }).click();
    await group.getByRole('combobox').waitFor();
    await shootGroup('e2-settings-person');
    // The "saved" toast goes before the refusal is shot, so it does not cover it.
    await settings.getByText(TEXT.saved).waitFor({ state: 'hidden', timeout: 15000 });
    // The server's refusal of a person who cannot move cards.
    await settings.route('**/api/projects/AC/config', async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      return route.fulfill(
        json(400, {
          error: {
            code: 'config_invalid',
            message: 'invalid',
            details: {
              issues: [{ code: 'mover_cannot_move', path: 'team.cardMover', detail: 'project_manager' }],
            },
          },
        }),
      );
    });
    await group.getByText(TEXT.projectManager, { exact: true }).click();
    await group.getByRole('alert').waitFor();
    await shoot(settings, 'e3-settings-refused', {
      widths: WIDTHS,
      highlight: `${MOVER_GROUP} [role="alert"]`,
    });
  });

  await step('f. the flow with the mover line', async () => {
    const flow = await open({ path: '/p/AC/how-we-work' });
    await flow.getByRole('link', { name: TEXT.mover }).waitFor();
    await flow.waitForTimeout(400);
    await shoot(flow, 'f-flow-mover', { widths: WIDTHS, fullPage: false });
  });
};
