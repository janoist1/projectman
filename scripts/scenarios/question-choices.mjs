/**
 * PM-1056: decision questions with buttons in "Rád vár" (docs/SCREENSHOTS.md).
 *
 *   npm run shots -- scripts/scenarios/question-choices.mjs --widths 1512,390
 *
 * Shoots a yes/no question, the same with a recommendation and consequences, the field after "Más válasz"
 * (with the focus in it) and an information question without buttons (the field is open).
 */
const YES_NO = 'Should the basket button turn green when the cart is not empty?';
const RECOMMENDED = 'Should we turn on the automatic regeneration of the snapshot files?';
const INFORMATION = 'Which staging URL should be used for the check?';

export default async ({ instance, open, shoot, step, log }) => {
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: YES_NO, options: ['Yes', 'No'] } },
    {
      tool: 'ask_human',
      arguments: {
        question: RECOMMENDED,
        options: [
          {
            label: 'Yes, turn it on',
            consequence: 'A merge regenerates the files and the queue does not stop.',
          },
          { label: 'No, keep it as it is', consequence: 'A conflict in the files still stops the queue.' },
        ],
        recommended: 'Yes, turn it on',
        recommendation_reason: 'It removes the most common stop in the queue.',
      },
    },
    { tool: 'ask_human', arguments: { question: INFORMATION, response_purpose: 'information' } },
  ]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);

  // The Operator's screening has handled the questions by now; show the real items as open ones.
  const asked = (await instance.api('/api/projects/AC/inbox?state=all')).items.filter(
    (item) => item.kind === 'question' && [YES_NO, RECOMMENDED, INFORMATION].includes(item.title),
  );
  log(`${asked.length} questions, states: ${asked.map((item) => item.state).join(', ')}`);
  const open_ = asked.map(({ payload, ...item }) => {
    const { screening, ...rest } = payload ?? {};
    return { ...item, state: 'open', resolution: null, payload: rest };
  });

  await step('the question buttons', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByRole('heading', { name: 'Folyamat', exact: true }).waitFor();
    await page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.items)
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...body, items: open_ }),
        });
      return route.fulfill({ response });
    });
    await page.goto(`${instance.webUrl}/p/AC/inbox`);
    for (const text of [YES_NO, RECOMMENDED, INFORMATION])
      await page.waitForFunction((value) => document.body.innerText.includes(value), text);
    await shoot(page, 'a-yes-no', { highlight: `text=${YES_NO} >> visible=true` });
    await shoot(page, 'b-recommended', { highlight: `text=${RECOMMENDED} >> visible=true` });
    await shoot(page, 'd-information-open-field', { highlight: `text=${INFORMATION} >> visible=true` });

    // The free answer: the field opens and takes the focus.
    const card = page.locator('article', { hasText: YES_NO }).first();
    await card.getByRole('button', { name: 'Más válasz' }).click();
    await shoot(page, 'c-other-answer-focus', { highlight: `text=${YES_NO} >> visible=true` });
  });
};
