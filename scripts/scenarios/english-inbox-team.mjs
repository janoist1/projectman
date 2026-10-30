/**
 * PM-1181: the "For you" list, the Operator, the team, messages and feedback in English.
 *
 *   npm run shots -- scripts/scenarios/english-inbox-team.mjs --widths 1512,390
 *
 * The owner's language is set to English through the API. Real questions come from the fake CLI; the other
 * kinds of the list are added in the browser (the inbox answer), so one list shows several kinds at once.
 */
const WIDTHS = [1512, 390];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const QUESTION = 'Should the basket button turn green when the cart is not empty?';

export default async ({ instance, open, shoot, step, log }) => {
  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });
  const members = await instance.api('/api/projects/AC/members');
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const owner = (await instance.api('/api/me')).handles.AC;

  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([
    { tool: 'ask_human', arguments: { question: QUESTION, options: ['Yes', 'No'] } },
  ]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);
  const asked = (await instance.api('/api/projects/AC/inbox?state=all')).items
    .filter((item) => item.kind === 'question' && item.title === QUESTION)
    .map(({ payload, ...item }) => {
      const { screening, ...rest } = payload ?? {};
      return { ...item, state: 'open', resolution: null, payload: rest };
    });

  const item = (id, kind, title, options, extra = {}) => ({
    id,
    projectKey: 'AC',
    kind,
    assignees: [owner],
    source: developer.handle,
    sessionId: null,
    taskKey: 'AC-1',
    title,
    body: null,
    payload: {},
    options,
    state: 'open',
    resolution: null,
    createdAt: minutesAgo(20),
    ...extra,
  });
  const extras = [
    item(
      'inb_en_permission',
      'permission',
      'Run a command',
      [
        { id: 'allow', label: 'allow', style: 'primary' },
        { id: 'allow_session', label: 'allow_session', style: 'secondary' },
        { id: 'deny', label: 'deny', style: 'danger' },
      ],
      { payload: { toolName: 'Bash', toolInput: { command: 'npm test' } } },
    ),
    item('inb_en_decision', 'decision', 'Which developer takes the card?', [
      { id: 'a', label: 'Give it to another developer', style: 'primary' },
      { id: 'b', label: 'One more round', style: 'secondary' },
    ]),
    item('inb_en_alert', 'alert', 'The connection to the provider dropped', [
      { id: 'seen', label: 'seen', style: 'primary' },
    ]),
  ];

  const attach = async (page) => {
    await page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.items && route.request().method() === 'GET' && !route.request().url().includes('state=all'))
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...body, items: [...extras, ...asked, ...body.items] }),
        });
      return route.fulfill({ response });
    });
  };
  const visit = async (path, width = 1512) => {
    const page = await open({ path: '/p/AC', width });
    await attach(page);
    await page.goto(new URL(path, page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    return page;
  };

  await step('for you', async () => {
    const page = await visit('/p/AC/inbox');
    await page.waitForFunction((text) => document.body.innerText.includes(text), QUESTION);
    await shoot(page, 'inbox-en', { widths: WIDTHS });
  });

  await step('operator panel', async () => {
    const page = await visit('/p/AC');
    await page.waitForSelector('[data-operator-button]');
    await page.click('[data-operator-button]');
    await page.waitForSelector('#operator-panel textarea');
    await shoot(page, 'operator-en', { widths: WIDTHS });
  });

  for (const [name, path] of [
    ['team', '/p/AC/team'],
    ['messages', '/p/AC/messages'],
    ['feedback', '/p/AC/feedback'],
    ['how-we-work', '/p/AC/how-we-work'],
  ]) {
    await step(name, async () => {
      const page = await visit(path);
      await page.waitForTimeout(800);
      await shoot(page, `${name}-en`, { widths: WIDTHS });
    });
  }

  await step('member profile', async () => {
    const page = await visit(`/p/AC/team/${developer.handle}`);
    await page.waitForTimeout(800);
    await shoot(page, 'member-en', { widths: WIDTHS });
  });
  log(`owner ${owner}, developer ${developer.handle}`);
};
