/**
 * Scenario for PM-273 (docs/SCREENSHOTS.md): the card's conversation, the "Beszélgetés" view of the card.
 * A developer member works on AC-1 and writes to the owner, asks a question that the owner answers (the
 * question and the answer are one row), and asks a second one that waits for the owner. The scenario then
 * shoots the states the UI/UX review asks for:
 *
 *   a. quick view, Thread view: messages, the question-and-answer row, the open question, the recipients
 *   b. large window with two columns: the card's right column stays beside the conversation
 *   c. large window, one column (1024 px)
 *   d. a phone (390 px) with the recipient popover open
 *   e. a card without messages: the empty state
 *   f. the limited view of a developer (only what was sent to them or by them)
 *   g. the Card view, with the "Teljes üzenet" link of the timeline
 *
 *   npm run shots -- scripts/scenarios/card-thread.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, task.view and task.thread).
const TEXT = {
  thread: 'Beszélgetés',
  card: 'Kártya',
  qa: 'Kérdés és válasz',
  limited: 'Csak a neked szóló és az általad küldött üzeneteket látod.',
  empty: 'Még nincs üzenet ezen a kártyán.',
  addTo: 'Címzett hozzáadása',
  fullMessage: 'Teljes üzenet',
};
const CARD = 'AC-1';
const LONG_QUESTION =
  'Mutassa az e-mail az összeget?\n\nA sablon ma csak a tételeket listázza. Az összeg a visszaigazoló oldalon már látszik; az e-mailben külön sor kellene hozzá, a szállítási díj és az ÁFA bontásával.\n\n- Az összeg a tételek alatt, külön sorban\n- A szállítási díj és az ÁFA is külön sor\n- A végösszeg kiemelve';
const OPEN_QUESTION = 'Kell az e-mailben a szállítási cím is?';

export default async ({ instance, open, shoot, step, log }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const owner = config.team.members.find((member) => member.kind === 'human' && member.access === 'owner');
  const developer = config.team.members.find((member) => member.kind === 'ai' && member.role === 'developer');
  log(`owner ${owner.handle}, developer ${developer.handle}`);

  const sessionId = await instance.startSession('AC', CARD, developer.handle);
  await instance.waitIdle('AC', sessionId);
  const turn = async (calls) => {
    await instance.setFakeCalls(calls);
    await instance.say('AC', sessionId, 'CALLS please');
    await instance.waitIdle('AC', sessionId);
  };
  const messages = async (as) =>
    (await instance.api(`/api/projects/AC/messages?taskKey=${CARD}`, as ? { as } : {})).messages;

  await step('the developer writes and asks a question, the owner answers it', async () => {
    await turn([
      {
        tool: 'send_message',
        arguments: {
          to: [owner.handle],
          text: 'Elkezdtem a visszaigazoló e-mailt, az első vázlat hamarosan kész.',
        },
      },
      { tool: 'ask_human', arguments: { question: LONG_QUESTION } },
    ]);
    const inbox = (await instance.api('/api/projects/AC/inbox')).items;
    const item = inbox.find(
      (entry) => entry.kind === 'question' && entry.state === 'open' && entry.taskKey === CARD,
    );
    if (!item) throw new Error('The first question did not reach the inbox.');
    const option = item.options.find((candidate) => candidate.id !== 'answer') ?? item.options[0];
    await instance.api(`/api/projects/AC/inbox/${item.id}/resolve`, {
      method: 'POST',
      body: { optionId: option.id, ...(option.id === 'answer' ? { note: 'Igen, az összeget is.' } : {}) },
    });
    const deadline = Date.now() + 10_000;
    while (!(await messages()).some((message) => message.answer)) {
      if (Date.now() > deadline) throw new Error('The answer message did not appear in the card thread.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  });

  await step('the owner writes to the developer, the developer asks again', async () => {
    await instance.api('/api/projects/AC/messages', {
      method: 'POST',
      body: { to: [developer.handle], text: 'Köszi! A mobil nézetet is nézd meg, kérlek.', taskKey: CARD },
    });
    await turn([
      {
        tool: 'send_message',
        arguments: { to: [owner.handle], text: 'Megnéztem, mobilon is jól tördel. Egy kérdésem még lenne.' },
      },
      { tool: 'ask_human', arguments: { question: OPEN_QUESTION } },
    ]);
    log(`messages on ${CARD}: ${(await messages()).length}`);
  });

  const shootThread = async (page, name, options = {}) => {
    await page.getByRole('region', { name: 'A kártya beszélgetése' }).waitFor();
    await page.getByText(TEXT.qa, { exact: true }).first().waitFor();
    await shoot(page, name, options);
  };

  await step('a. quick view, Thread view', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/thread` });
    await shootThread(page, 'thread-quick', {
      widths: [1512, 390],
      highlight: `[role=group][aria-label="${TEXT.qa}"]`,
    });
  });

  await step('b. large window, two columns', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/thread?size=large`, width: 1512 });
    await shootThread(page, 'thread-large', { widths: [1512] });
  });

  await step('c. large window, one column', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/thread?size=large`, width: 1024 });
    await shootThread(page, 'thread-large-narrow', { widths: [1024] });
  });

  await step('d. a phone with the recipient popover open', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/thread`, width: 390 });
    await page.getByRole('region', { name: 'A kártya beszélgetése' }).waitFor();
    await page.getByRole('button', { name: TEXT.addTo }).click();
    await page.getByRole('group', { name: TEXT.addTo }).waitFor();
    await shoot(page, 'thread-phone-recipients', { widths: [390] });
  });

  await step('e. a card without messages', async () => {
    const created = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Add gift wrapping', repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
    });
    const page = await open({ path: `/p/AC/tasks/${created.key}/thread` });
    await page.getByText(TEXT.empty, { exact: true }).waitFor();
    await shoot(page, 'thread-empty', { widths: [1512, 390] });
  });

  await step('f. the limited view of a developer', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    // The owner and the AI member wrote to each other: the developer sees none of it, only what is for them.
    const dana = (await instance.api('/api/projects/AC/config')).config.team.members.find(
      (member) => member.displayName === 'Dana Dev',
    );
    // Enough messages for the log to scroll: it opens at its end, so the limited line must stay in sight.
    const notes = [
      'Dana, a kártyán te nézed át a mobil nézetet.',
      'Először a kosár oldalt, utána a pénztárat.',
      'A képernyőképeket tedd a kártyára.',
      'Ha kérdésed van, itt írd meg, nem külön üzenetben.',
      'A szállítási díj sorát külön nézd meg, ott volt hiba.',
      'A keskeny telefonon (360 px) is próbáld ki.',
      'A végén írd meg, mi maradt nyitva.',
      'Holnap délig kellene, hogy átadhassuk.',
    ];
    for (const text of notes) {
      await instance.api('/api/projects/AC/messages', {
        method: 'POST',
        body: { to: [dana.handle], text, taskKey: CARD },
      });
    }
    const page = await open({ as: colleague, path: `/p/AC/tasks/${CARD}/thread` });
    await page.getByText(TEXT.limited, { exact: true }).waitFor();
    await shoot(page, 'thread-limited', { widths: [1512, 390] });
  });

  await step('g. the Card view with the "Teljes üzenet" link', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}` });
    await page.getByRole('button', { name: TEXT.thread }).waitFor();
    await page.getByRole('link', { name: TEXT.fullMessage }).first().waitFor();
    await shoot(page, 'card-full-message', {
      widths: [1512, 390],
      highlight: `a:has-text("${TEXT.fullMessage}") >> visible=true`,
    });
  });
};
