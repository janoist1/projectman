/**
 * Scenario for PM-663 (docs/SCREENSHOTS.md): the confirmation before a message puts an AI member on a card a
 * same-role member already works on (409 card_busy). The scenario shoots the states the UI/UX review asks for:
 *
 *   1. case A: a same-role member works on the card, the card thread asks
 *   2. case B: two same-role recipients on a card nobody works on, the message form asks
 *   3. case C: two groups (developers with a worker, QA with two joiners), the footer in sight on the phone
 *   4. "Küldés mégis" while the resend is on its way
 *   5. the conversation with one member asks
 *
 *   npm run shots -- scripts/scenarios/card-busy-warning.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts).
const TEXT = {
  titleWorking: 'Ezen a kártyán már dolgozik valaki',
  titleJoining: 'Az üzenet többeket küldene ugyanarra a munkára',
  confirm: 'Küldés mégis',
  back: 'Vissza',
  send: 'Küldés', // common.send: the card thread and the conversation
  sendForm: 'Elküldöm', // messages.send: the new-message form
  newMessage: 'Új üzenet',
  messageText: 'Üzenet', // messages.text
  task: 'Kapcsolódó feladat', // messages.task
  conversationTask: 'Feladat', // messages.composer.task
  addTo: 'Címzett hozzáadása',
  thread: 'A kártya beszélgetése',
};
const BUSY_CARD = 'AC-1';
const FREE_CARD = 'AC-2';

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  const working = developers[0];
  const joining = developers[1];
  const qa = members.find((member) => member.kind === 'ai' && member.role === 'qa');
  log(`developers ${working.handle} (works) and ${joining.handle}, qa ${qa.handle}`);

  const secondQa = await instance.api('/api/projects/AC/members', {
    method: 'POST',
    body: { role: 'qa', displayName: 'Réka' },
  });
  // Only the developers own the work stage, so only a developer can work on the card.
  const sessionId = await instance.startSession('AC', BUSY_CARD, working.handle);
  await instance.waitIdle('AC', sessionId);

  /** The new-message form in its dialog, filled for `to` about `card`; the send button is clicked last. */
  const fillForm = async (page, to, card, text) => {
    await page.getByRole('button', { name: TEXT.newMessage }).first().click();
    const form = page.getByRole('dialog', { name: TEXT.newMessage });
    await form.waitFor();
    // The accessible name holds the display name and the handle: match the handle as a whole word.
    for (const handle of to)
      await form.getByRole('checkbox', { name: new RegExp(`\\b${handle}\\b(?!-)`) }).check();
    await form.getByLabel(new RegExp(TEXT.task)).selectOption(card);
    await form.getByLabel(TEXT.messageText, { exact: true }).fill(text);
    await form.getByRole('button', { name: TEXT.sendForm }).click();
  };
  const warning = (page, title) => page.getByRole('dialog', { name: title });
  /** The first focus is on "Vissza": logged for each case, and a failure when it is anywhere else. */
  const expectBackFocused = async (page, label) => {
    await page.waitForTimeout(300);
    const active = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    log(`${label}: focus on "${active}"`);
    if (active !== TEXT.back)
      throw new Error(`${label}: the focus is on "${active}", not on "${TEXT.back}".`);
  };

  await step('1. case A: the card thread, a same-role member already works on the card', async () => {
    const page = await open({ path: `/p/AC/tasks/${BUSY_CARD}/thread` });
    const region = page.getByRole('region', { name: TEXT.thread });
    await region.waitFor();
    await region.getByRole('button', { name: TEXT.addTo }).click();
    await page
      .getByRole('group', { name: TEXT.addTo })
      .getByRole('checkbox', { name: new RegExp(joining.displayName) })
      .check();
    await region.getByRole('textbox').fill('Vedd át a kosár oldalt is, kérlek.');
    // Enter sends in the card thread: the sender is on the keyboard, so the focus ring shows on "Vissza".
    await region.getByRole('textbox').press('Enter');
    await warning(page, TEXT.titleWorking).waitFor();
    await expectBackFocused(page, 'case A');
    await shoot(page, 'case-a-card-thread', { widths: [1512, 390] });
    await warning(page, TEXT.titleWorking).getByRole('button', { name: TEXT.back }).click();
  });

  await step('2. case B: the message form, two same-role recipients on a card nobody works on', async () => {
    const page = await open({ path: '/p/AC/messages' });
    await fillForm(page, [working.handle, joining.handle], FREE_CARD, 'Ketten nézzétek meg a pénztárat.');
    await warning(page, TEXT.titleJoining).waitFor();
    await expectBackFocused(page, 'case B');
    await shoot(page, 'case-b-message-form', { widths: [1512, 390] });
  });

  await step('3. case C: two groups, the footer in sight', async () => {
    const page = await open({ path: '/p/AC/messages' });
    // The developers' group has a worker and a joiner; the QA group has two joiners and no worker.
    await fillForm(
      page,
      [joining.handle, qa.handle, secondQa.handle],
      BUSY_CARD,
      'Nézzétek át együtt a kosarat.',
    );
    await warning(page, TEXT.titleWorking).waitFor();
    await expectBackFocused(page, 'case C');
    await shoot(page, 'case-c-two-groups', { widths: [1512, 390] });
  });

  await step('4. "Küldés mégis" while the resend is on its way', async () => {
    const page = await open({ path: '/p/AC/messages' });
    // Hold the resend back so the loading state stays on screen.
    await page.route('**/api/projects/AC/messages', async (route) => {
      const body = route.request().postData() ?? '';
      if (route.request().method() === 'POST' && body.includes('despiteWorkers')) {
        await new Promise((resolve) => setTimeout(resolve, 8000));
      }
      await route.continue();
    });
    await fillForm(page, [joining.handle], BUSY_CARD, 'Ezt mégis küldd.');
    const dialog = warning(page, TEXT.titleWorking);
    await dialog.waitFor();
    await dialog.getByRole('button', { name: TEXT.confirm }).click();
    await page.waitForTimeout(600);
    await shoot(page, 'loading', { widths: [1512, 390] });
  });

  await step('5. the conversation with one member', async () => {
    const page = await open({ path: `/p/AC/messages/with/${joining.handle}` });
    const box = page.getByRole('textbox').last();
    await box.waitFor();
    await page.getByLabel(TEXT.conversationTask).selectOption(BUSY_CARD);
    await box.fill('Ez neked szól a kosárról.');
    await page.getByRole('button', { name: TEXT.send, exact: true }).click();
    await warning(page, TEXT.titleWorking).waitFor();
    await expectBackFocused(page, 'conversation');
    await shoot(page, 'conversation', { widths: [1512, 390] });
  });
};
