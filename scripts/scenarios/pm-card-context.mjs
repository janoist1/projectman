/**
 * Screenshots for PM-1305 (docs/SCREENSHOTS.md): the project manager's panel beside a card (the "Kontextus"
 * chip, "Írás a kártyára") and the status line under a comment that mentions someone.
 *
 *   npm run shots -- scripts/scenarios/pm-card-context.mjs --widths 1512,390
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  if (!pm) throw new Error('the demo project has no project manager');
  const [card] = await instance.api('/api/projects/AC/tasks');
  log(`pm: ${pm.handle}, card: ${card.key}`);

  await step('a comment that mentions the manager shows its status line', async () => {
    await instance.api(`/api/projects/AC/tasks/${card.key}/comments`, {
      method: 'POST',
      body: { text: `@${pm.handle} kérlek nézd meg ezt a kártyát` },
    });
    const page = await open({ path: `/p/AC/tasks/${card.key}/thread`, width: 1512 });
    await page.getByRole('textbox', { name: /Hozzászólás szövege|Comment text/ }).waitFor();
    await page.waitForTimeout(500);
    await shoot(page, 'comment-status', { widths: WIDTHS });
  });

  await step('the panel keeps the card as its context and can move the text to the card', async () => {
    const page = await open({ path: `/p/AC/tasks/${card.key}/thread`, width: 1512 });
    await page.waitForSelector('[data-operator-button="drawer"]');
    await page.click('[data-operator-button="drawer"]');
    const box = page.locator('#operator-panel textarea');
    await box.waitFor();
    await box.fill('Ezt inkább a kártyára írnám, nem a beszélgetésbe.');
    await page.waitForTimeout(400);
    await shoot(page, 'panel-context', { widths: WIDTHS });
    await page.getByRole('button', { name: /Írás a kártyára|Write on the card/ }).click();
    await page.getByRole('textbox', { name: /Hozzászólás szövege|Comment text/ }).waitFor();
    await page.waitForTimeout(500);
    await shoot(page, 'written-on-card', { widths: WIDTHS });
  });
};
