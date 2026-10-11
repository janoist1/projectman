/**
 * Scenario for PM-501 (docs/SCREENSHOTS.md): the card row of a "Rád vár" item is a link, and the card's drawer
 * opens over the inbox. The demo project's done stage asks for the people-only label `merge-approved`; a card in
 * front of it waits for that approval (a decision), and an agent asks a question on another card. It shoots,
 * at 1512 and 390 px, in the light and the dark theme:
 *
 *   a. the question with the card link        b. the decision with the card link
 *   c. the drawer over the inbox (the link opened it)
 *   d. closed again: the inbox, the focus on the link (the ring is visible)
 *
 *   npm run shots -- scripts/scenarios/inbox-card-link.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const LABEL = { id: 'merge-approved', name: 'Beolvasztás jóváhagyva', setBy: 'humans' };
const QUESTION = 'Elég a süti nélküli mérés, vagy kell GA4 is?';

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const members = config.team.members;
  const owner = members.find((member) => member.kind === 'human').handle;
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer').handle;
  const stages = config.pipeline.stages;
  const done = stages.find((stage) => stage.kind === 'done');
  const kept = stages.filter((stage) => stage.kind !== 'release');
  const from = kept[kept.indexOf(done) - 1];
  if (!done || !from) throw new Error('The demo pipeline needs a stage in front of the done stage.');

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
    return key;
  };
  const asked = await card(
    'Add visitor statistics without cookies, for the shop owner and the marketing team',
  );
  const sessionId = await instance.startSession('AC', asked, developer);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([{ tool: 'ask_human', arguments: { question: QUESTION, to: [owner] } }]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);

  const waiting = await card('Show delivery estimates');
  await instance.api(`/api/projects/AC/tasks/${waiting}`, { method: 'PATCH', body: { stageId: from.id } });

  const items = (await instance.api('/api/projects/AC/inbox')).items;
  const question = items.find((item) => item.taskKey === asked && item.kind === 'question');
  const decision = items.find((item) => item.payload?.gate?.taskKey === waiting);
  log(`question ${question?.id}; decision ${decision?.id}`);
  if (!question || !decision)
    throw new Error('The scenario needs a question and a decision, both with a card.');

  const link = (item) => `#inbox-item-${item.id} [data-inbox-card-link]`;
  for (const theme of ['light', 'dark']) {
    await step(`${theme}: the rows, the drawer over the inbox, and back`, async () => {
      const page = await open({ path: '/p/AC/inbox' });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.locator(link(question)).waitFor();
      await shoot(page, `a-question-${theme}`, { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
      await shoot(page, `b-decision-${theme}`, { widths: WIDTHS, highlight: `#inbox-item-${decision.id}` });

      await page.locator(link(question)).click();
      await page.getByRole('complementary', { name: 'Feladat részletei' }).waitFor();
      await shoot(page, `c-drawer-over-inbox-${theme}`, { widths: WIDTHS });

      await page.keyboard.press('Escape');
      await page.locator(link(question)).waitFor();
      log(`focused after closing: ${await page.evaluate(() => document.activeElement?.textContent)}`);
      await shoot(page, `d-closed-${theme}`, { widths: WIDTHS, highlight: `#inbox-item-${question.id}` });
    });
  }
};
