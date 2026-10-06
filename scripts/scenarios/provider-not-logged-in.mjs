/**
 * Scenario for PM-324 (docs/SCREENSHOTS.md): the start of an AI member whose provider is not logged in waits, and
 * the card says so. The fake Claude CLI is logged out (`fakeEnv`), a message wakes the developer on a card, and
 * the scenario shoots the card on the board and the open drawer with the login command:
 *
 *   a. the board with the card's status line "Indulásra vár: a Claude nincs bejelentkezve"
 *   b. the card's drawer: the hint and the login command in a code element
 *
 *   npm run shots -- scripts/scenarios/provider-not-logged-in.mjs [--widths 1512,390]
 */

// The fake CLIs the instance starts: `claude auth status` reports a missing login.
export const fakeEnv = { FAKE_CLAUDE_LOGGED_OUT: '1' };

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, taskStatus and providers).
const TEXT = {
  waiting: 'Indulásra vár: a Claude nincs bejelentkezve',
  command: 'claude auth login',
};
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const card = (
    await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Add a wish list', repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
    })
  ).key;
  await instance.api('/api/projects/AC/messages', {
    method: 'POST',
    body: { to: [developer.handle], taskKey: card, text: 'Please look at this card.' },
  });
  log(`card ${card} waits for ${developer.handle}`);

  await step('a. the board', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByText(TEXT.waiting, { exact: false }).first().waitFor();
    await shoot(page, 'a-board', { widths: WIDTHS, highlight: `text=${TEXT.waiting} >> visible=true` });
  });

  await step('b. the drawer', async () => {
    const page = await open({ path: `/p/AC/tasks/${card}` });
    await page.getByText(TEXT.waiting, { exact: false }).first().waitFor();
    await page.locator('code', { hasText: TEXT.command }).first().waitFor();
    await shoot(page, 'b-drawer', { widths: WIDTHS, highlight: `code:has-text("${TEXT.command}")` });
  });
};
