/**
 * Scenario for PM-296 (docs/SCREENSHOTS.md): a session that rests after a stop is "Lezárva" with its reason, and a new
 * message continues it. The disposable server really closes the sessions here:
 *
 *   a. AC-1: the card moves on after the developer's step -> "Lezárva · lépés kész" (step_done)
 *   b. AC-2: the owner stops the session -> "Lezárva · leállítottad" (manual, by the viewer)
 *   then, for both: the session page (header, line above the box, timeline), the card's drawer with the
 *   sessions list, and the developer's profile (past sessions and the activity list); finally a message to
 *   the closed session of AC-2, which starts it again (the reason and the line go).
 *
 * The other reasons (idle after 15 minutes, a card done, withdrawn or sent back, a pause) need the clock or a
 * long run; the tests of the web app cover every kind against the fake backend.
 *
 *   npm run shots -- scripts/scenarios/closed-session.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  const developer = developers[0];

  const waitState = async (sessionId, states) => {
    const deadline = Date.now() + 40_000;
    for (;;) {
      const { session } = await instance.api(`/api/projects/AC/sessions/${sessionId}`);
      if (states.includes(session.state)) return session;
      if (Date.now() > deadline) throw new Error(`Session ${sessionId} stayed ${session.state}.`);
      await delay(250);
    }
  };

  // a. The card moves on after the developer's step: the session closes by itself.
  const moved = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', moved);
  await step('move AC-1 on', async () => {
    const { config } = await instance.api('/api/projects/AC/config');
    const { task } = await instance.api('/api/projects/AC/tasks/AC-1');
    const stages = config.pipeline.stages;
    const next = stages[stages.findIndex((stage) => stage.id === task.stageId) + 1];
    log(`AC-1 is in ${task.stageId}, moves to ${next?.id}`);
    await instance.api('/api/projects/AC/tasks/AC-1', { method: 'PATCH', body: { stageId: next.id } });
    const session = await waitState(moved, ['exited']);
    log(`AC-1 session: ${session.state}, lastStop ${JSON.stringify(session.lastStop)}`);
  });

  // b. The owner stops a session.
  const stopped = await instance.startSession('AC', 'AC-2', developer.handle);
  await instance.waitIdle('AC', stopped);
  await step('stop the AC-2 session', async () => {
    await instance.api(`/api/projects/AC/sessions/${stopped}/stop`, { method: 'POST' });
    const session = await waitState(stopped, ['exited']);
    log(`AC-2 session: ${session.state}, lastStop ${JSON.stringify(session.lastStop)}`);
  });

  const page = await open({ path: `/p/AC/sessions/${moved}` });
  await step('the session after a finished step', async () => {
    await page.waitForSelector('text=Lezárva');
    await shoot(page, 'step-done-session', { widths: WIDTHS, highlight: 'text=Magától lezárult' });
  });

  await step('the session the owner stopped', async () => {
    await page.goto(new URL(`/p/AC/sessions/${stopped}`, page.url()).href);
    await page.waitForSelector('text=Leállítottad.');
    await shoot(page, 'stopped-session', { widths: WIDTHS, highlight: 'text=Leállítottad.' });
  });

  await step('the card drawer and its sessions list', async () => {
    await page.goto(new URL('/p/AC/tasks/AC-1', page.url()).href);
    await page.waitForSelector('text=Lezárva · lépés kész');
    await shoot(page, 'card-drawer', {
      widths: WIDTHS,
      highlight: 'text=Lezárva · lépés kész',
    });
  });

  await step('the developer profile', async () => {
    await page.goto(new URL(`/p/AC/team/${developer.handle}`, page.url()).href);
    await page.waitForSelector('text=Lezárva · leállítottad');
    await shoot(page, 'profile', { widths: WIDTHS, highlight: 'text=Lezárva · leállítottad' });
  });

  await step('a message continues the closed session', async () => {
    await page.goto(new URL(`/p/AC/sessions/${stopped}`, page.url()).href);
    await page.waitForSelector('text=Leállítottad.');
    await page.getByLabel('Üzenet a munkamenetnek').fill('Folytasd, kérlek.');
    await page.getByRole('button', { name: 'Küldés' }).click();
    await waitState(stopped, ['starting', 'working', 'idle']);
    await page.waitForSelector('text=Leállítottad.', { state: 'detached' });
    await shoot(page, 'continued-session', { widths: WIDTHS });
  });
};
