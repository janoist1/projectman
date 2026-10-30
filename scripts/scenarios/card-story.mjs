/**
 * The card's Process tab (PM-1160): the "Most" box, the comment box and the story in rounds.
 * One card goes forward, back and forward again (several rounds, with their outcomes and runs of system
 * events); other cards show a question waiting for the owner, a finished card, a new card and a theme.
 *
 *   npm run shots -- scripts/scenarios/card-story.mjs --widths 1512,390
 */
import { hu } from '../../apps/web/src/i18n/hu.ts';

export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  // The demo owner may set the approval label, so a card can be carried to the done stage.
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        labels: config.pipeline.labels.map((label) =>
          label.id === 'code-review-ok' ? { ...label, setBy: 'anyone' } : label,
        ),
      },
    },
  });
  const stages = config.pipeline.stages;
  const workIndex = stages.findIndex((stage) => stage.kind === 'work');
  const ready = stages.findLast((stage, index) => index < workIndex && stage.kind === 'queue');
  const work = stages[workIndex];
  const review = stages.find((stage, index) => index > workIndex && stage.kind === 'step');
  const done = stages.find((stage) => stage.kind === 'done');
  if (!ready || !review || !done)
    throw new Error('The demo pipeline needs a queue before the work stage, a later step and a done stage.');
  // The first developer is on the Claude fake, which can ask a question.
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const create = async (body) => (await instance.api('/api/projects/AC/tasks', { method: 'POST', body })).key;
  const move = (key, stageId) =>
    instance.api(`/api/projects/AC/tasks/${key}`, { method: 'PATCH', body: { stageId } });
  const comment = (key, text) =>
    instance.api(`/api/projects/AC/tasks/${key}/comments`, { method: 'POST', body: { text } });
  const session = async (key) => {
    const id = await instance.startSession('AC', key, developer.handle);
    await instance.waitIdle('AC', id);
    return id;
  };

  // A card in its second review: ready → work → review → work again → review. The ready queue is a round the
  // card only passed through.
  const rounds = await create({
    title: 'Add a wish list',
    repo: 'webshop',
    stageId: ready.id,
  });
  await move(rounds, work.id);
  await session(rounds);
  await comment(rounds, 'The list needs to survive a reload.');
  await move(rounds, review.id);
  await comment(rounds, 'Reload loses the list: please keep it per account.');
  await move(rounds, work.id);
  await session(rounds);
  await move(rounds, review.id);

  // A card that has gone through the whole pipeline.
  const finished = await create({ title: 'Show delivery estimates', repo: 'webshop', stageId: work.id });
  await move(finished, review.id);
  await instance.api(`/api/projects/AC/tasks/${finished}/labels`, {
    method: 'POST',
    body: { add: ['code-review-ok', 'qa-ok', 'client-accepted', 'merge-approved', 'release-approved'] },
  });
  await move(finished, done.id);

  // A card whose developer asked the owner a question.
  const asking = await create({ title: 'Pick the basket button colour', repo: 'webshop', stageId: work.id });
  // The developer's last session of the first card may still be closing: ask again until it has room.
  let asked;
  for (let attempt = 0; !asked; attempt++) {
    try {
      asked = await instance.startSession('AC', asking, developer.handle);
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await instance.waitIdle('AC', asked);
  await instance.setFakeCalls([
    {
      tool: 'ask_human',
      arguments: { question: 'Which colour should the basket button be?', options: ['Green', 'Blue'] },
    },
  ]);
  await instance.say('AC', asked, 'CALLS please');
  await instance.waitIdle('AC', asked);

  // A theme with one card of its own.
  const theme = await create({ title: 'Checkout redesign', kind: 'theme' });
  await create({ title: 'Redesign the checkout page', themeKey: theme });
  log(`rounds ${rounds}, finished ${finished}, asking ${asking}, theme ${theme}`);

  const story = (page) => page.getByRole('heading', { name: new RegExp(`^${hu.task.story.title}`) });
  const view = (page, value) =>
    page.evaluate((next) => window.localStorage.setItem('pm:cardStory.view', next), value);
  // The drawer scrolls and the screenshot height is fixed: one image of the top (the Now box and the comment
  // box) and one with the story (or `anchor`) scrolled to the top of the drawer, below its sticky tabs.
  const capture = async (page, name, anchor = story(page)) => {
    await shoot(page, name);
    await anchor.evaluate((node) => {
      node.scrollIntoView({ block: 'start' });
      let parent = node.parentElement;
      while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
      parent?.scrollBy(0, -90);
    });
    await shoot(page, `${name}-story`);
  };
  const show = async (path, view_ = 'essence') => {
    const page = await open({ path });
    await view(page, view_);
    await page.reload();
    await story(page).waitFor();
    return page;
  };
  const stepsPath = (key) => `/p/AC/tasks/${key}/steps`;

  await step('a. rounds in the essence view: forward and back chips, the latest round open', async () => {
    await capture(await show(stepsPath(rounds)), 'a-rounds');
  });
  await step('b. a round the card only passed through', async () => {
    const page = await show(stepsPath(rounds));
    const oldest = page.locator('h4 > button[aria-expanded="false"]').last();
    await oldest.click();
    await capture(page, 'b-passed-through', oldest);
  });
  await step('c. the noise folded, then opened', async () => {
    const page = await show(stepsPath(rounds));
    await capture(page, 'c-noise-folded');
    const run = page.getByRole('button', { name: /rendszer-esemény/ }).first();
    await run.click();
    await capture(page, 'c-noise-open');
  });
  await step('d. every event, with the visible switch', async () => {
    await capture(await show(stepsPath(rounds), 'all'), 'd-all');
  });
  await step('e. an old timeline link into a folded round', async () => {
    const detail = await instance.api(`/api/projects/AC/tasks/${rounds}`);
    const note = detail.timeline.find((event) => event.type === 'task_note');
    if (!note) throw new Error('The card has no comment to link to.');
    const page = await open({ path: `${stepsPath(rounds)}#timeline-${note.id}` });
    await story(page).waitFor();
    await capture(page, 'e-old-link');
  });
  await step('f. a question waiting for the owner', async () => {
    await capture(await show(stepsPath(asking)), 'f-waiting');
  });
  await step('g. a finished card', async () => {
    await capture(await show(stepsPath(finished)), 'g-done');
  });
  await step('h. a card that has only just started', async () => {
    await capture(await show(stepsPath('AC-1')), 'h-new');
  });
  await step('i. the Process tab of a theme', async () => {
    await capture(await show(stepsPath(theme)), 'i-theme');
  });
  await step('j. keyboard focus on a round header', async () => {
    const page = await show(stepsPath(rounds));
    await page.keyboard.press('Shift');
    await page.locator('h4 > button[aria-expanded]').first().focus();
    await capture(page, 'j-focus');
  });
};
