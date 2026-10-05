/**
 * Scenario for PM-349 (docs/SCREENSHOTS.md): the recommended developer, the Senior. It makes one AI developer the
 * Senior, keeps them busy on a card, recommends the Senior for another card and shoots the six scenes of the
 * PM-338 UI/UX plan:
 *
 *   a. the board: the Senior mark on the card
 *   b. "Ki vigye?" of a Senior card, the confirm dialog for a developer who is no Senior (and on a phone)
 *   c. the "Ajánlott" row of the drawer with its editor
 *   d. a card started while the Senior is busy: it waits for the Senior (drawer and board)
 *   e. the team: the Senior chip, the member form and the Keretek field
 *   f. the inbox question once the card waited past the limit (5 minutes, the smallest the settings allow; the
 *      server asks from a one-minute sweep, so this scene comes last; the run takes about 7 minutes: `--timeout 600`)
 *
 *   npm run shots -- scripts/scenarios/senior-developer.mjs --timeout 600 [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: task, seniorWarning, inbox).
const TEXT = {
  who: 'Ki vigye?',
  start: 'Indítás',
  editLevel: 'Ajánlás módosítása',
  levelSenior: 'Senior-feladat',
  confirm: 'Igen, ő kapja',
  cancel: 'Mégse',
  waits: 'A Seniorra vár',
  seniorChip: 'Senior',
  question: 'Seniorra vár egy kártya',
  seniorWait: 'Senior-várakozás (perc)',
};
const REASON = 'Touches pricing, tax and the order history';
const WIDTHS = [1512, 390];
const QUESTION_WAIT_MS = 8 * 60_000;

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  if (developers.length < 2) throw new Error('The demo project needs two AI developers.');
  const [senior, other] = developers;
  const text = (page, content) => page.getByText(content, { exact: false }).first().waitFor();

  // The wait limit is the smallest the settings allow, so the question comes within a few minutes.
  const { config, version } = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: { baseVersion: version, limits: { ...config.team.limits, seniorWaitMinutes: 5 } },
  });
  await instance.api(`/api/projects/AC/members/${senior.handle}`, {
    method: 'PATCH',
    body: { senior: true },
  });

  const card = async (title) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.', labels: [] },
      })
    ).key;
  // The Senior is busy on this card for the whole run.
  const busy = await card('Migrate the order history');
  const sessionId = await instance.startSession('AC', busy, senior.handle);
  await instance.waitIdle('AC', sessionId);
  const seniorCard = await card('Rebuild the checkout pricing');
  await instance.api(`/api/projects/AC/tasks/${seniorCard}`, {
    method: 'PATCH',
    body: { developerLevel: { level: 'senior', reason: REASON } },
  });
  // This one is started at once, so it waits for the Senior from the start of the run: the clock of the question
  // (scene f) runs while the other scenes are shot.
  const waiting = await card('Add tiered shipping rates');
  await instance.api(`/api/projects/AC/tasks/${waiting}`, {
    method: 'PATCH',
    body: { developerLevel: { level: 'senior', reason: REASON } },
  });
  await instance.api(`/api/projects/AC/tasks/${waiting}/start`, { method: 'POST', body: {} });
  log(
    `senior ${senior.handle} is busy on ${busy}; ${seniorCard} is a Senior card; ${waiting} waits for them`,
  );

  await step('a. the board shows the Senior mark', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByLabel(`${TEXT.levelSenior}: ${REASON}`).first().waitFor();
    await shoot(page, 'a-board-mark', {
      widths: WIDTHS,
      highlight: `[aria-label="${TEXT.levelSenior}: ${REASON}"]`,
    });
  });

  await step('b. "Ki vigye?" and the confirm dialog', async () => {
    const page = await open({ path: `/p/AC/tasks/${seniorCard}` });
    const select = page.getByLabel(TEXT.who);
    await select.waitFor();
    await shoot(page, 'b-who-takes', { widths: WIDTHS });
    await select.selectOption(other.handle);
    await page.getByRole('button', { name: TEXT.start, exact: true }).click();
    await page.getByRole('button', { name: TEXT.confirm }).waitFor();
    await shoot(page, 'b-confirm', { widths: WIDTHS });
    await page.getByRole('button', { name: TEXT.cancel }).click();
  });

  await step('c. the "Ajánlott" row and its editor', async () => {
    const page = await open({ path: `/p/AC/tasks/${seniorCard}` });
    await page.getByRole('button', { name: TEXT.editLevel }).waitFor();
    await shoot(page, 'c-level-row', { widths: WIDTHS });
    await page.getByRole('button', { name: TEXT.editLevel }).click();
    await page.getByRole('button', { name: TEXT.levelSenior, exact: true }).waitFor();
    await shoot(page, 'c-level-editor', { widths: WIDTHS });
  });

  await step('d. the card that waits for the Senior', async () => {
    const page = await open({ path: `/p/AC/tasks/${waiting}` });
    await text(page, TEXT.waits);
    await shoot(page, 'd-waiting-drawer', { widths: WIDTHS });
    const board = await open({ path: '/p/AC' });
    await text(board, TEXT.waits);
    await shoot(board, 'd-waiting-board', { widths: WIDTHS });
  });

  await step('e. the team and the Keretek field', async () => {
    const page = await open({ path: '/p/AC/team' });
    await page.getByText(TEXT.seniorChip, { exact: true }).first().waitFor();
    await shoot(page, 'e-team', { widths: WIDTHS });
    const profile = await open({ path: `/p/AC/team/${senior.handle}` });
    await profile.getByRole('button', { name: `További műveletek: ${senior.displayName}` }).click();
    await profile.getByRole('button', { name: `Szerkesztés: ${senior.displayName}` }).click();
    await profile.getByLabel('Senior fejlesztő').waitFor();
    await shoot(profile, 'e-member-form', { widths: WIDTHS, highlight: 'text=Senior fejlesztő' });
    const settings = await open({ path: '/p/AC/settings' });
    await settings.getByLabel(TEXT.seniorWait).waitFor();
    await shoot(settings, 'e-limits', { widths: WIDTHS, highlight: `text=${TEXT.seniorWait}` });
  });

  await step('f. the inbox question after the wait limit', async () => {
    const deadline = Date.now() + QUESTION_WAIT_MS;
    for (;;) {
      const { items } = await instance.api('/api/projects/AC/inbox');
      if (items.some((item) => item.state === 'open' && item.payload?.seniorWait)) break;
      if (Date.now() > deadline) throw new Error('The Senior-wait question did not come within 8 minutes.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const page = await open({ path: '/p/AC/inbox' });
    await text(page, TEXT.question);
    await shoot(page, 'f-inbox-question', { widths: WIDTHS, mask: ['time'] });
  });
};
