/**
 * The review images of the two interface styles (PM-363): Classic and Win 3.11, light and dark, 1512 and 390 px.
 *
 *   npm run shots -- scripts/scenarios/ui-styles.mjs
 *
 * Screens: the board (with an urgent card), an open card with a question and its thread, the "Rád vár" list, the Team page, three Settings
 * pages (engines, owners, and the pipeline with a stage that has no owner) and the Megjelenés picker. The style is the account's own setting (PUT /api/me/ui-style), exactly as a user would set it.
 */
const QUESTION = 'Which colour should the basket button be?';

const STYLES = ['classic', 'win311'];
const SCHEMES = ['light', 'dark'];
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  // A fake AI developer asks a question on the first card, so there is something that needs the owner.
  const developer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: QUESTION, options: ['Green', 'Blue'] } },
  ]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);

  // The Operator's screening has handled the question by now; show the real item as an open one.
  const asked = (await instance.api('/api/projects/AC/inbox?state=all')).items
    .filter((item) => item.kind === 'question' && item.title === QUESTION)
    .map(({ payload, ...item }) => {
      const { screening, ...rest } = payload ?? {};
      return { ...item, state: 'open', resolution: null, payload: rest };
    });

  // An urgent card on the board, and a work stage without anyone to carry it (the pipeline page's warning places).
  const urgent = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Urgent: the payment page is down', repo: 'webshop' },
  });
  await instance.api(`/api/projects/AC/tasks/${urgent.key}`, {
    method: 'PATCH',
    body: { priority: 'urgent' },
  });
  const { config, version } = await instance.api('/api/projects/AC/config');
  const ownerless = config.pipeline.stages.find((stage) => stage.kind === 'work');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...config.pipeline,
        stages: config.pipeline.stages.map((stage) =>
          stage.id === ownerless.id ? { ...stage, owners: [] } : stage,
        ),
      },
    },
  });

  const screens = [
    { name: 'board', path: '/p/AC', ready: 'text=AC-1' },
    { name: 'pipeline', path: '/p/AC/settings/pipeline', ready: 'text=nincs gazdája' },
    {
      name: 'card-question',
      path: '/p/AC/tasks/AC-1/steps',
      ready: `text=${QUESTION} >> visible=true`,
    },
    {
      name: 'card-thread',
      path: '/p/AC/tasks/AC-1/thread',
      ready: `text=${QUESTION} >> visible=true`,
      inbox: true,
    },
    { name: 'waiting-list', path: '/p/AC/inbox', ready: `text=${QUESTION} >> visible=true`, inbox: true },
    { name: 'team', path: '/p/AC/team' },
    { name: 'settings', path: '/p/AC/settings/engines' },
    { name: 'owners', path: '/p/AC/settings/owners' },
    { name: 'appearance', path: '/p/AC/settings/account', ready: '[role=radiogroup]' },
  ];

  for (const style of STYLES) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of SCHEMES) {
      await step(`${style} ${scheme}`, async () => {
        for (const screen of screens) {
          const page = await open({ path: screen.inbox ? '/p/AC' : screen.path });
          await page.emulateMedia({ colorScheme: scheme });
          if (screen.inbox) {
            await page.route('**/api/projects/AC/inbox**', async (route) => {
              const response = await route.fetch();
              const body = await response.json();
              if (!body.items) return route.fulfill({ response });
              return route.fulfill({
                status: 200,
                contentType: 'application/json',
                body: JSON.stringify({ ...body, items: asked }),
              });
            });
            await page.goto(`${instance.webUrl}${screen.path}`);
          }
          if (screen.ready) await page.locator(screen.ready).first().waitFor();
          await shoot(page, `${style}-${scheme}-${screen.name}`, { widths: WIDTHS });
        }
      });
    }
  }
};
