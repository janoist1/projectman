/**
 * Scenario for PM-291 (docs/SCREENSHOTS.md): the card's drawer offers the Start only when a person can start
 * the card, and says what it waits for otherwise. The demo project has no refinement, so the scenario
 * sets one up first: the labels `refine`, `ui`, `scope-ok` and `design-ok` (people set the last two) and a gate
 * on the work stage that asks for them. Then it shoots four states:
 *
 *   a. a card that is not worked out: the Kidolgozás button is the main action, no Start
 *   b. a card that is being refined: the standing in the status line, the steps closed and open
 *   c. a card that can be started: the Start and "Ki vigye?"
 *   d. the same card while AI work is switched off: the Start is disabled, with a note
 *   e. a member working on a card that is being refined, narrow (the worker's sentence with its detail line)
 *
 *   npm run shots -- scripts/scenarios/start-block.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, taskStatus and task).
const TEXT = {
  notRefined: 'Még nincs kidolgozva',
  progress: 'Kidolgozás: 1/2 lépés kész',
  steps: 'Lépések',
  start: 'Indítás',
  aiOff: 'Az AI-munka ki van kapcsolva',
};
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const patchConfig = async (change) => {
    const { config, version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: version, ...change(config) },
    });
  };

  // The refinement: people set the labels, so no AI member starts working on the cards.
  await patchConfig((config) => {
    const person = config.team.members.find((member) => member.kind === 'human').handle;
    const labels = config.pipeline.labels.filter(
      (label) => !['refine', 'ui', 'scope-ok', 'design-ok'].includes(label.id),
    );
    labels.push(
      { id: 'refine', name: 'Kidolgozásra vár', setBy: 'anyone' },
      { id: 'ui', name: 'Felületi', setBy: 'anyone' },
      { id: 'scope-ok', name: 'Kidolgozás eldöntve', setBy: { members: [person] } },
      { id: 'design-ok', name: 'UI/UX terv kész', setBy: { members: [person] } },
    );
    const stages = config.pipeline.stages.map((stage) =>
      stage.kind === 'work'
        ? {
            ...stage,
            gate: {
              conditions: [
                { type: 'has_label', label: 'scope-ok' },
                { type: 'has_label', label: 'design-ok', when: 'ui' },
              ],
            },
          }
        : stage,
    );
    return { pipeline: { ...config.pipeline, labels, stages } };
  });

  const card = async (title, labels) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.', labels },
      })
    ).key;
  const notWorkedOut = await card('Add gift wrapping', []);
  const beingRefined = await card('Show delivery estimates', ['ui', 'refine', 'scope-ok']);
  const startable = await card('Add a wish list', ['scope-ok']);
  log(`cards: ${notWorkedOut}, ${beingRefined}, ${startable}`);

  const text = (page, content) => page.getByText(content, { exact: false }).first().waitFor();
  const toggle = (page) => page.getByRole('button', { name: TEXT.steps });

  await step('a. a card that is not worked out', async () => {
    const page = await open({ path: `/p/AC/tasks/${notWorkedOut}` });
    await text(page, TEXT.notRefined);
    await shoot(page, 'a-not-worked-out', { widths: WIDTHS });
  });

  await step('b. a card that is being refined, the steps closed and open', async () => {
    const page = await open({ path: `/p/AC/tasks/${beingRefined}` });
    await text(page, TEXT.progress);
    await shoot(page, 'b-refining-closed', { widths: WIDTHS });
    await toggle(page).click();
    await shoot(page, 'b-refining-steps', { widths: WIDTHS });
  });

  await step('c. a card that can be started', async () => {
    const page = await open({ path: `/p/AC/tasks/${startable}` });
    await page.getByRole('button', { name: TEXT.start, exact: true }).waitFor();
    await shoot(page, 'c-startable', { widths: WIDTHS });
  });

  // A member working on a card that is being refined: the worker's sentence has a detail line, and the
  // refinement row stands under it (the narrow width is where the status line wrapped, PM-291 UI/UX review).
  await step('e. a member works on the card being refined, narrow', async () => {
    const worker = (await instance.api('/api/projects/AC/members')).find(
      (member) => member.kind === 'ai' && member.role === 'developer',
    );
    const working = await card('Show stock levels', ['ui', 'refine', 'scope-ok']);
    const sessionId = await instance.startSession('AC', working, worker.handle);
    await instance.waitIdle('AC', sessionId);
    await instance.setFakeCalls([
      {
        tool: 'set_current_work',
        arguments: {
          summary: 'plans the stock level badges',
          detail: 'Compares the badge on the product page with the one in the basket.',
        },
      },
    ]);
    await instance.say('AC', sessionId, 'CALLS please');
    await instance.waitIdle('AC', sessionId);
    const page = await open({ path: `/p/AC/tasks/${working}`, width: 390 });
    await text(page, TEXT.progress);
    await toggle(page).click();
    await shoot(page, 'e-working-steps', { widths: [390] });
  });

  await step('d. AI work is switched off', async () => {
    await patchConfig(() => ({ limits: { aiEnabled: false } }));
    const page = await open({ path: `/p/AC/tasks/${startable}` });
    await text(page, TEXT.aiOff);
    await shoot(page, 'd-ai-off', { widths: WIDTHS });
  });
};
