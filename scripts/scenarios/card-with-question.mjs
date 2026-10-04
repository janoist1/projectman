/**
 * Sample scenario (docs/SCREENSHOTS.md): a card with an open question, seen by a non-admin account.
 *
 *   npm run shots -- scripts/scenarios/card-with-question.mjs
 */
const QUESTION = 'Which colour should the basket button be?';

export default async ({ instance, open, shoot, snapshot, step, log }) => {
  // A fake AI developer asks the question on the first card of the demo project.
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([{ tool: 'ask_human', arguments: { question: QUESTION } }]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);

  // Not the owner: an invited developer of the project.
  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  await step('open the card', async () => {
    // The account is not the owner: print what it may do in the project (the avatar says only "Te").
    const me = await instance.api('/api/me', { as: colleague });
    log(
      `signed in as ${me.email}: ${JSON.stringify(me.projects.map(({ key, access }) => ({ key, access })))}`,
    );
    const page = await open({ as: colleague, path: '/p/AC/tasks/AC-1' });
    await page.waitForFunction((text) => document.body.innerText.includes(text), QUESTION);
    log(await snapshot(page));
    // The question is in the card's timeline, below the fold: the highlight scrolls it into view.
    await shoot(page, 'card-question', {
      widths: [1512, 390],
      highlight: `text=${QUESTION} >> visible=true`,
    });
  });
};
