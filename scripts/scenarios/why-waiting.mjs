/**
 * Scenario for PM-461 (docs/SCREENSHOTS.md): "Miért áll?" on the screen. The owner is the card mover, so a
 * developer's finished step becomes a "Vidd tovább" item. It shoots, at 1512 and 390 px:
 *
 *   a. the board: a card that waits for the busy Senior, a "Rád vár · vidd tovább" card and an approval card
 *   b. the drawer of the Senior-waiting card: the box with three rows, no button
 *   c. the drawer of the hand-on card as the card mover: the box with the four rows and "Tovább: …"
 *   d. the same card as a colleague who is not the card mover: the box without a button
 *   e. the drawer of the approval card: the "Hová lépne" row
 *   f. the inbox: the "Vidd tovább" item, then its gate error after the next column closed behind it
 *
 *   npm run shots -- scripts/scenarios/why-waiting.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: task.whyBox, inbox.handOn).
const TEXT = {
  box: 'Miért áll?',
  move: /^Tovább: /,
  needsYou: 'Rád vár',
  gateError: 'A kapu még nem enged tovább',
};
const REASON = 'Touches pricing, tax and the order history';
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const members = config.team.members;
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  // Only the fake Claude runs the scripted calls ("CALLS"): the developer who finishes the step is one of its members.
  const developer = developers.find((member) => (member.provider ?? 'claude') === 'claude');
  const senior = developers.find((member) => member !== developer);
  if (!developer || !senior)
    throw new Error('The demo project needs two AI developers, one of them on Claude.');
  const owner = members.find((member) => member.kind === 'human').handle;
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const stepIndex = stages.findIndex((stage, index) => index > workIndex && stage.kind === 'step');
  const stepStage = stages[stepIndex];
  const after = stages[stepIndex + 1];
  if (!stepStage || !after) throw new Error('The demo pipeline has no step followed by another stage.');
  log(`work ${stages[workIndex].id}, step ${stepStage.id}, after ${after.id}; card mover ${owner}`);

  // The owner takes cards on, and the stage after the review step asks for a person's approval.
  const labels = config.pipeline.labels.filter(
    (label) => !['code-review-ok', 'merge-approved'].includes(label.id),
  );
  labels.push(
    { id: 'code-review-ok', name: 'Code review rendben', setBy: 'anyone' },
    { id: 'merge-approved', name: 'Összefésülés jóváhagyva', setBy: 'humans' },
  );
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      cardMover: { kind: 'human', handle: owner },
      pipeline: {
        ...config.pipeline,
        labels,
        stages: stages.map((stage) =>
          stage.id === after.id
            ? {
                ...stage,
                gate: {
                  conditions: [
                    { type: 'has_label', label: 'code-review-ok' },
                    { type: 'has_label', label: 'merge-approved' },
                  ],
                },
              }
            : stage,
        ),
      },
    },
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

  // 1. The Senior is busy, so a Senior card that is started waits for them (the capacity wait).
  const busy = await card('Migrate the order history');
  const busySession = await instance.startSession('AC', busy, senior.handle);
  await instance.waitIdle('AC', busySession);
  const capacity = await card('Add tiered shipping rates');
  await instance.api(`/api/projects/AC/tasks/${capacity}`, {
    method: 'PATCH',
    body: { developerLevel: { level: 'senior', reason: REASON } },
  });
  await instance.api(`/api/projects/AC/tasks/${capacity}/start`, { method: 'POST', body: {} });

  // 2. A developer finishes the step and moves the card on: the card mover is asked instead.
  const handOn = await card('Add a wish list');
  const session = await instance.startSession('AC', handOn, developer.handle);
  await instance.waitIdle('AC', session);
  await instance.setFakeCalls([
    { tool: 'update_task', arguments: { task_key: handOn, stage_id: stepStage.id } },
  ]);
  await instance.say('AC', session, 'CALLS please');
  // The echo of the turn comes before its calls, so the idle state says nothing: wait for the request itself.
  let asked;
  for (let attempt = 0; attempt < 100; attempt++) {
    asked = await instance.api(`/api/projects/AC/tasks/${handOn}`);
    if (asked.task.handOn) break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (!asked.task.handOn)
    throw new Error(
      `${handOn} has no hand-on request: stage ${asked.task.stageId}, wait ${asked.wait?.reason}.`,
    );

  // 3. A card in the review step with code-review-ok: only the person's approval is missing.
  const approval = await card('Show delivery estimates');
  await instance.api(`/api/projects/AC/tasks/${approval}`, {
    method: 'PATCH',
    body: { stageId: stepStage.id },
  });
  await instance.api(`/api/projects/AC/tasks/${approval}/labels`, {
    method: 'POST',
    body: { add: ['code-review-ok'] },
  });
  log(`cards: ${capacity} waits for the Senior, ${handOn} asks ${owner}, ${approval} waits for an approval`);

  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  const box = (page) => page.getByRole('region', { name: TEXT.box });

  await step('a. the board', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByText(TEXT.needsYou, { exact: false }).first().waitFor();
    await shoot(page, 'a-board', { widths: WIDTHS });
  });

  await step('b. the card that waits for the Senior', async () => {
    const page = await open({ path: `/p/AC/tasks/${capacity}` });
    await box(page).waitFor();
    await shoot(page, 'b-capacity', { widths: WIDTHS });
  });

  await step('c. the card mover with the button', async () => {
    const page = await open({ path: `/p/AC/tasks/${handOn}` });
    await box(page).getByRole('button', { name: TEXT.move }).waitFor();
    await shoot(page, 'c-hand-on-mover', { widths: WIDTHS });
  });

  await step('e. the approval card', async () => {
    const page = await open({ path: `/p/AC/tasks/${approval}` });
    await box(page).waitFor();
    await shoot(page, 'e-approval', { widths: WIDTHS });
  });

  await step('f. the inbox item and its gate error', async () => {
    const page = await open({ path: '/p/AC/inbox' });
    const button = page.getByRole('button', { name: TEXT.move }).first();
    await button.waitFor();
    await shoot(page, 'f-inbox-item', { widths: WIDTHS });
    // The next column closes behind the request: the click is refused and the item stays.
    const current = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: {
        baseVersion: current.version,
        pipeline: {
          ...current.config.pipeline,
          stages: current.config.pipeline.stages.map((stage) =>
            stage.id === stepStage.id
              ? { ...stage, gate: { conditions: [{ type: 'has_label', label: 'merge-approved' }] } }
              : stage,
          ),
        },
      },
    });
    await button.click();
    await page.getByRole('alert').filter({ hasText: TEXT.gateError }).waitFor();
    await shoot(page, 'f-inbox-error', { widths: WIDTHS });
  });

  await step('d. a colleague who is not the card mover', async () => {
    const page = await open({ as: colleague, path: `/p/AC/tasks/${handOn}` });
    await box(page).waitFor();
    await shoot(page, 'd-hand-on-colleague', { widths: WIDTHS });
    const board = await open({ as: colleague, path: '/p/AC' });
    await board.getByText(owner, { exact: false }).first().waitFor();
    await shoot(board, 'd-board-colleague', { widths: WIDTHS });
  });
};
