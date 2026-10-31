/**
 * PM-1181: the "For you" list, the Operator, the team, messages and feedback in English.
 *
 *   npm run shots -- scripts/scenarios/english-inbox-team.mjs --widths 1512,390
 *
 * The owner's language is set to English through the API. Real questions come from the fake CLI; the other
 * kinds of the list, and a feedback mark, are added in the browser (the answers of the inbox and feedback
 * routes), so one list shows several kinds at once. A dialog closes when the window is resized, so each
 * width opens it again. The last step switches the owner to Hungarian for one shot of the unchanged list.
 */
const WIDTHS = [1512, 390];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const QUESTION = 'Should the basket button turn green when the cart is not empty?';
const SHARED = 'Which staging URL should the checks use?';
const json = (route, body) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

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
  const requestedBy = { kind: 'human', handle: owner };
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
    item(
      'inb_en_gate',
      'decision',
      'Move to Review',
      [
        { id: 'approve', label: 'approve', style: 'primary' },
        { id: 'reject', label: 'reject', style: 'danger' },
      ],
      {
        payload: {
          gate: {
            requestId: 'req_en_1',
            taskKey: 'AC-1',
            fromStageId: 'dev',
            toStageId: 'review',
            stageId: 'review',
            label: 'code-review-ok',
            requestedBy,
          },
        },
      },
    ),
    item(
      'inb_en_loop',
      'decision',
      'Two members keep writing to each other',
      [
        { id: 'stop_work', label: 'stop_work', style: 'danger' },
        { id: 'let_run', label: 'let_run', style: 'secondary' },
      ],
      {
        payload: {
          loop: {
            loopId: 'loop_en_1',
            taskKey: 'AC-1',
            members: [developer.handle, 'pm'],
            count: 14,
            minutes: 20,
            startedAt: minutesAgo(20),
            reason: 'no_watcher',
            watcher: null,
          },
        },
      },
    ),
    item('inb_en_alert', 'alert', 'The connection to the provider dropped', [
      { id: 'seen', label: 'seen', style: 'primary' },
    ]),
    item(
      'inb_en_shared',
      'question',
      SHARED,
      [
        { id: 'option_1', label: 'staging.acme.test', style: 'primary' },
        { id: 'option_2', label: 'preview.acme.test', style: 'secondary' },
      ],
      {
        payload: {
          question: SHARED,
          options: ['staging.acme.test', 'preview.acme.test'],
          group: {
            primaryItemId: 'inb_en_shared',
            itemIds: ['inb_en_shared', 'inb_en_shared_2'],
            combinedQuestion: SHARED,
            originalQuestion: SHARED,
            primaryTaskKey: 'AC-1',
            sources: [
              {
                itemId: 'inb_en_shared',
                taskKey: 'AC-1',
                taskTitle: 'Build the product catalogue',
                asker: developer.handle,
                question: 'Which staging URL should I check?',
                createdAt: minutesAgo(20),
                state: 'live',
              },
              {
                itemId: 'inb_en_shared_2',
                taskKey: 'AC-2',
                taskTitle: 'Add a shopping basket',
                asker: developer.handle,
                question: 'Where do I run the end-to-end checks?',
                createdAt: minutesAgo(15),
                state: 'live',
              },
            ],
          },
        },
      },
    ),
  ];

  const mark = {
    id: 'fbm_en0000000001',
    projectKey: 'AC',
    author: { handle: owner, name: 'You', kind: 'human', color: 2 },
    surface: { id: 'shop', name: 'Shop', origin: 'https://shop.acme.test' },
    pageUrl: 'https://shop.acme.test/basket',
    pagePath: '/basket',
    pageTitle: 'Your basket',
    kind: 'point',
    body: 'The total is wrong after removing an item.',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: 320, y: 240 },
      rect: null,
    },
    status: 'new',
    outcome: null,
    card: null,
    working: false,
    commentCount: 0,
    unread: false,
    hasScreenshot: false,
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(30),
    lastActivityAt: minutesAgo(30),
    closedAt: null,
  };

  /** Opens the app on `path`; `items` is what the "For you" list holds (default: the extras and the real question). */
  const visit = async (path, { width = 1512, items, feedback = false } = {}) => {
    const page = await open({ path: '/p/AC', width });
    await page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.items && route.request().method() === 'GET' && !route.request().url().includes('state=all'))
        return json(route, { ...body, items: items ?? [...asked, ...extras, ...body.items] });
      return route.fulfill({ response });
    });
    if (feedback) {
      const surface = { ...mark.surface };
      await page.route('**/api/projects/AC/feedback', (route) =>
        json(route, { marks: [mark], surfaces: [surface], markers: [], canProcess: true, canMark: true }),
      );
      await page.route('**/api/projects/AC/feedback/summary', (route) =>
        json(route, { configured: true, canMark: true, canProcess: true, todo: 1, unreadReplies: 0 }),
      );
      await page.route('**/api/projects/AC/feedback/settings', (route) =>
        json(route, {
          publicBaseUrl: null,
          surfaces: [{ ...surface, lastMarkAt: mark.createdAt }],
          markers: [],
        }),
      );
    }
    await page.goto(new URL(path, page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    return page;
  };
  /** Runs `show` at each width: opens the page again, so a dialog of the width before is gone. */
  const atWidths = async (name, path, show, options = {}) => {
    for (const width of WIDTHS) {
      const page = await visit(path, { ...options, width });
      await page.waitForTimeout(800);
      await show(page);
      await shoot(page, `${name}-${width}`, { widths: [width] });
      await page.close();
    }
  };
  const menuOfProfile = (page) => page.getByRole('button', { name: /^More actions/ }).first();

  await step('for you: several kinds', async () => {
    const page = await visit('/p/AC/inbox');
    await page.waitForFunction((text) => document.body.innerText.includes(text), QUESTION);
    await shoot(page, 'inbox-en', { widths: WIDTHS });
    await page.close();
    // The shot resizes the window and the list scrolls back: scroll to the item at each width.
    const shown = {
      gate: (page) => page.getByRole('button', { name: /^Approve/ }).first(),
      loop: (page) => page.getByText('A card is going in circles').first(),
      'shared-question': (page) => page.getByText(SHARED).first(),
    };
    for (const [name, locate] of Object.entries(shown))
      for (const width of WIDTHS) {
        const page = await visit('/p/AC/inbox', { width });
        await page.waitForFunction((text) => document.body.innerText.includes(text), QUESTION);
        await locate(page).scrollIntoViewIfNeeded();
        await shoot(page, `inbox-${name}-${width}`, { widths: [width] });
        await page.close();
      }
  });

  await step('for you: empty', async () => {
    const page = await visit('/p/AC/inbox', { items: [] });
    await page.waitForTimeout(1000);
    await shoot(page, 'inbox-empty-en', { widths: WIDTHS });
  });

  await step('operator panel and the agreement', async () => {
    for (const width of WIDTHS) {
      const page = await visit('/p/AC', { width });
      await page.waitForSelector('[data-operator-button]');
      await page.click('[data-operator-button]');
      await page.waitForSelector('#operator-panel textarea');
      await shoot(page, `operator-${width}`, { widths: [width] });
      await page.getByRole('button', { name: 'How we work together' }).click();
      await page.waitForTimeout(800);
      await shoot(page, `operator-agreement-${width}`, { widths: [width] });
      await page.close();
    }
  });

  await step('team and the hire dialog', async () => {
    await atWidths('team', '/p/AC/team', async () => {});
    await atWidths('hire', '/p/AC/team', async (page) => {
      await page.getByRole('button', { name: 'Hire an AI member' }).first().click();
      await page.getByRole('dialog').waitFor();
    });
  });

  await step('member profile, settings and leave', async () => {
    const profile = `/p/AC/team/${developer.handle}`;
    await atWidths('member', profile, async () => {});
    await atWidths('member-settings', profile, async (page) => {
      await page.getByText('Settings', { exact: true }).first().click();
      await page.waitForTimeout(600);
    });
    await atWidths('member-edit', profile, async (page) => {
      await menuOfProfile(page).click();
      await page.getByRole('button', { name: /^Edit / }).click();
      await page.getByRole('dialog').waitFor();
    });
    // The same dialog scrolled to its last fields (mode, who decides, outbound network).
    await atWidths('member-edit-end', profile, async (page) => {
      await menuOfProfile(page).click();
      await page.getByRole('button', { name: /^Edit / }).click();
      await page.getByRole('dialog').waitFor();
      await page.evaluate(() => {
        for (const element of document.querySelectorAll('[role="dialog"] *'))
          if (element.scrollHeight > element.clientHeight + 20) element.scrollTop = element.scrollHeight;
      });
      await page.waitForTimeout(300);
    });
    // Sending on leave is one click in the "…" menu, with a toast and no dialog; each width starts from "at work".
    const backAtWork = () =>
      instance.api(`/api/projects/AC/members/${developer.handle}`, {
        method: 'PATCH',
        body: { onLeave: false },
      });
    await atWidths('member-leave', profile, async (page) => {
      await backAtWork();
      await page.reload();
      await menuOfProfile(page).click();
      await page.getByRole('button', { name: /^Send .* on leave$/ }).click();
      await page.getByRole('status').first().waitFor();
    });
    await backAtWork();
  });

  await step('messages and the new message dialog', async () => {
    await atWidths('messages', '/p/AC/messages', async () => {});
    await atWidths('message-new', '/p/AC/messages', async (page) => {
      await page.getByRole('button', { name: 'New message' }).click();
      await page.getByRole('dialog').waitFor();
    });
  });

  await step('feedback with a mark', async () => {
    await atWidths('feedback', '/p/AC/feedback', async () => {}, { feedback: true });
  });

  await step('the list in Hungarian', async () => {
    await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'hu' } });
    const page = await open({ path: '/p/AC/inbox', width: 1512 });
    await page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.items && route.request().method() === 'GET' && !route.request().url().includes('state=all'))
        return json(route, { ...body, items: [...asked, ...extras, ...body.items] });
      return route.fulfill({ response });
    });
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await page.waitForFunction(() => document.documentElement.lang === 'hu');
    await page.waitForTimeout(1000);
    await shoot(page, 'inbox-hu', { widths: [1512] });
  });
  log(`owner ${owner}, developer ${developer.handle}`);
};
