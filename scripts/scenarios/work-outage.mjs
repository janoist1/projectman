/**
 * Scenario for PM-468 (docs/SCREENSHOTS.md): a provider that is not logged in stops the work, and the UI says so.
 * The fake Claude CLI is logged out (`fakeEnv`), a message wakes the developer on a card, and the scenario shoots:
 *
 *   a. "Rád vár": the outage card (heading, Teendő with the login command, Érintettek, the two buttons)
 *   b. the roster: the member reads "Nem tud dolgozni" with the reason
 *   c. the board: the card's orange line "Áll: …"
 *   d. the card's drawer: the login box under the heading "Áll: …"
 *
 *   npm run shots -- scripts/scenarios/work-outage.mjs [--widths 1512,390]
 */

// The fake CLIs the instance starts: `claude auth status` reports a missing login.
export const fakeEnv = { FAKE_CLAUDE_LOGGED_OUT: '1' };

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts).
const TEXT = {
  heading: 'A Claude nincs bejelentkezve',
  engineHeading: 'A(z) Mac mini motor nem csatlakozik',
  cannotWork: 'Nem tud dolgozni',
  stuck: 'Áll: ',
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

  // No highlight on the card itself: its outline would hide the 3 px stripe the review looks at.
  await step('a. Rád vár', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    await page.getByRole('heading', { name: TEXT.heading }).first().waitFor({ timeout: 90_000 });
    await shoot(page, 'a-inbox', { widths: WIDTHS });
  });

  // The server's real outage is the Claude one; the other cases rewrite the inbox answer in the browser.
  const inboxOf = async (change, headingText) => {
    const page = await open({ path: '/p/AC' });
    await page.route(/\/api\/projects\/AC\/inbox\?/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      let changed = 0;
      body.items = body.items.map((item) => {
        if (item.payload?.alert !== 'work_outage') return item;
        changed += 1;
        return change(item);
      });
      log(`inbox answer rewritten: ${changed} outage item(s) of ${body.items.length}`);
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await page.getByRole('heading', { name: headingText }).first().waitFor();
    return page;
  };

  await step('a2. Rád vár, a remote engine does not connect', async () => {
    const outage = {
      kind: 'engine',
      id: 'out_engine',
      engine: { id: 'eng_macmini00001', name: 'Mac mini' },
      since: new Date(Date.now() - 3 * 3600_000).toISOString(),
    };
    const page = await inboxOf(
      (item) => ({ ...item, payload: { ...item.payload, outage } }),
      TEXT.engineHeading,
    );
    await shoot(page, 'a2-inbox-engine', { widths: WIDTHS });
  });

  await step('a3. Rád vár, no card waits', async () => {
    const page = await inboxOf(
      (item) => ({ ...item, payload: { ...item.payload, tasks: [] } }),
      TEXT.heading,
    );
    await shoot(page, 'a3-inbox-no-cards', { widths: WIDTHS });
  });

  await step('b. the roster', async () => {
    const page = await open({ path: '/p/AC/team' });
    await page.getByText(TEXT.cannotWork, { exact: false }).first().waitFor();
    await shoot(page, 'b-roster', { widths: WIDTHS, highlight: `text=${TEXT.cannotWork} >> visible=true` });
  });

  await step('c. the board', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByText(TEXT.stuck, { exact: false }).first().waitFor();
    // The highlight is on the status line, not on the card: the card's orange stripe stays visible.
    await shoot(page, 'c-board', { widths: WIDTHS, highlight: `[data-phase="stuck"] >> text=${TEXT.stuck}` });
  });

  await step('d. the drawer', async () => {
    const page = await open({ path: `/p/AC/tasks/${card}` });
    await page.getByTestId('drawer-outage').waitFor();
    await page.locator('code', { hasText: TEXT.command }).first().waitFor();
    await shoot(page, 'd-drawer', { widths: WIDTHS, highlight: '[data-testid="drawer-outage"]' });
  });
};
