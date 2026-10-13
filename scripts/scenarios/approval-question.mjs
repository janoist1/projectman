/**
 * Scenario for PM-484 (docs/SCREENSHOTS.md): the merge after an approval, and the note of a question that
 * asks for an approval. The demo project's merge target is its done stage, which asks for the people-only label
 * `merge-approved`; a card in front of it waits for that approval, so the "Rád vár" item says what follows.
 * It shoots, at 1512 and 390 px:
 *
 *   a. the approval item when the owner merges ("te olvasztod be"); f. when another member merges
 *   b. the question item of an agent that asks for the approval, in its four variants: the jump link (the open
 *      approval is the viewer's), someone else can approve, no open approval request, the label is already on
 *   c. after the jump link: the focus on the approval item's heading and its frame (reduced motion: the frame stays)
 *   d. the note in the dark theme
 *   e. the drawer of the card with both items
 *
 *   npm run shots -- scripts/scenarios/approval-question.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, inbox).
const TEXT = {
  thenMerge: 'Jóváhagyás után ',
  thenMergeYou: 'Jóváhagyás után te olvasztod be',
  notApproval: 'Ez kérdés, nem jóváhagyás',
  jump: 'Ugrás a jóváhagyáshoz',
  others: 'A jóváhagyást ',
  none: 'Nincs nyitott jóváhagyási kérés',
  done: 'Már rajta van a kártyán',
};
const WIDTHS = [1512, 390];
const LABEL = { id: 'merge-approved', name: 'Beolvasztás jóváhagyva', setBy: 'humans' };
const QUESTION = `Jóváhagyod a beolvasztást? (${LABEL.name})`;

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const members = config.team.members;
  const owner = members.find((member) => member.kind === 'human').handle;
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer').handle;
  const stages = config.pipeline.stages;
  const done = stages.find((stage) => stage.kind === 'done');
  // The release stage would take the merge target (and its gate) away from the approval: leave it out.
  const kept = stages.filter((stage) => stage.kind !== 'release');
  const from = kept[kept.indexOf(done) - 1];
  if (!done || !from) throw new Error('The demo pipeline needs a stage in front of the done stage.');
  log(`${from.id} -> ${done.id}; the owner ${owner}, the developer ${developer}`);

  const configure = async (merger) => {
    const current = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: current.version, merger },
    });
  };
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      merger: { kind: 'member', handle: owner },
      pipeline: {
        ...config.pipeline,
        labels: [...config.pipeline.labels.filter((label) => label.id !== LABEL.id), LABEL],
        stages: kept.map((stage) =>
          stage.id === done.id
            ? { ...stage, gate: { conditions: [{ type: 'has_label', label: LABEL.id }] } }
            : { ...stage, gate: undefined },
        ),
      },
    },
  });

  const card = async (title) => {
    const { key } = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.', labels: [] },
    });
    await instance.api(`/api/projects/AC/tasks/${key}`, { method: 'PATCH', body: { stageId: from.id } });
    return key;
  };
  // An agent asks for the approval in a question; the app notes that the answer sets no label.
  const ask = async (key) => {
    const sessionId = await instance.startSession('AC', key, developer);
    await instance.waitIdle('AC', sessionId);
    await instance.setFakeCalls([{ tool: 'ask_human', arguments: { question: QUESTION, to: [owner] } }]);
    await instance.say('AC', sessionId, 'CALLS please');
    await instance.waitIdle('AC', sessionId);
  };
  const itemsOf = async () => (await instance.api('/api/projects/AC/inbox')).items;
  const questionOf = (items, key) =>
    items.find((item) => item.taskKey === key && item.payload?.approvalLabel === LABEL.id);
  const gateOf = (items, key) => items.find((item) => item.payload?.gate?.taskKey === key);

  const open1 = await card('Add a wish list');
  await ask(open1);
  const open2 = await card('Show delivery estimates');
  await ask(open2);
  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });
  const known = new Set(members.map((member) => member.handle));
  const dana = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'human' && !known.has(member.handle),
  );
  if (!dana) throw new Error('The invited colleague is not a member of the project.');
  const items = await itemsOf();
  const gate = gateOf(items, open1);
  const question = questionOf(items, open1);
  log(`gate ${gate?.id} ${JSON.stringify(gate?.payload?.gate?.merge)}; question ${question?.id}`);
  if (!gate || !question) throw new Error('The card needs both an approval request and a question.');
  log(`colleague ${colleague.email} is ${dana?.handle}`);

  const hint = (page) => page.locator('[data-approval-hint]');
  // The server's answer is rewritten in the browser for the variants it does not give by itself.
  const inboxOf = async (change, kind, as) => {
    const page = await open(as ? { as, path: '/p/AC' } : { path: '/p/AC' });
    await page.route(/\/api\/projects\/AC\/inbox\?/, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.items = change(body.items);
      await route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    });
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await page.locator(`[data-approval-hint="${kind}"]`).first().waitFor();
    return page;
  };
  const only =
    (...keys) =>
    (all) =>
      all.filter((item) => keys.includes(item.taskKey) || !item.taskKey);

  await step('a. the approval item, the owner merges', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    await page.getByText(TEXT.thenMergeYou, { exact: false }).first().waitFor();
    await shoot(page, 'a-gate-you', { widths: WIDTHS, highlight: `#inbox-item-${gate.id}` });
  });

  await step('b. the question: the jump link', async () => {
    const page = await inboxOf(only(open1), 'jump');
    await page.getByText(TEXT.notApproval, { exact: false }).first().waitFor();
    await shoot(page, 'b-question-jump', { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
  });

  await step('b. the question: someone else can approve', async () => {
    const page = await inboxOf(
      (all) =>
        only(open1)(all).map((item) => (item.id === gate.id ? { ...item, assignees: [dana.handle] } : item)),
      'others',
    );
    await shoot(page, 'b-question-others', { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
  });

  await step('b. the question: no open approval request', async () => {
    const page = await inboxOf((all) => only(open1)(all).filter((item) => item.id !== gate.id), 'none');
    await shoot(page, 'b-question-none', { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
  });

  await step('b. the question: the label is already on', async () => {
    const before = await itemsOf();
    const second = questionOf(before, open2);
    if (!second) throw new Error('The second card needs its question.');
    await instance.api(`/api/projects/AC/tasks/${open2}/labels`, {
      method: 'POST',
      body: { add: [LABEL.id] },
    });
    // The server closes such a question by itself; the browser is shown the moment before.
    const page = await inboxOf((all) => [...all.filter((item) => item.id !== second.id), second], 'done');
    await shoot(page, 'b-question-done', { widths: WIDTHS, highlight: `#inbox-item-${second.id}` });
  });

  await step('c. after the jump link: the focus and the frame', async () => {
    const page = await inboxOf(only(open1), 'jump');
    // Animations are off in the images: with reduced motion the lit frame stays on the item.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: TEXT.jump }).click();
    await page.locator(`#inbox-item-${gate.id}[data-flash="static"]`).waitFor();
    log(`focused: ${await page.evaluate(() => document.activeElement?.textContent)}`);
    await shoot(page, 'c-after-jump', { widths: WIDTHS });
  });

  await step('d. the note in the dark theme', async () => {
    const page = await inboxOf(only(open1), 'jump');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'd-question-dark', { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('e. the drawer', async () => {
    const page = await open({ path: `/p/AC/tasks/${open1}` });
    await hint(page).first().waitFor();
    await shoot(page, 'e-drawer', { widths: WIDTHS });
  });

  // The request carries who merges as of the moment it was made: a card that reaches its gate after the
  // setting changed is the one that names someone else.
  await step('f. the approval item, another member merges', async () => {
    await configure({ kind: 'member', handle: developer });
    const third = await card('Add order history');
    const other = gateOf(await itemsOf(), third);
    log(`gate ${other?.id} ${JSON.stringify(other?.payload?.gate?.merge)}`);
    if (!other) throw new Error('The third card needs its approval request.');
    const page = await open({ path: '/p/AC/inbox' });
    // The line names the merger: "Jóváhagyás után {name} beolvasztja ...", not "te olvasztod be".
    await page
      .locator(`#inbox-item-${other.id}`)
      .getByText(/Jóváhagyás után .+ beolvasztja a main ágba/)
      .waitFor();
    await shoot(page, 'f-gate-other', { widths: WIDTHS, highlight: `#inbox-item-${other.id}` });
    await configure({ kind: 'member', handle: owner });
  });
};
