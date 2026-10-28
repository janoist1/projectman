/**
 * PM-1075 review pictures: a step made through a connected Claude (decision 66) beside the plain and the old
 * super rows, varied only in the disposable browser's responses.
 *
 *   a. the card timeline: a direct instruction, external work (MCP), an approved step and an old super row
 *   b. a. with the chip opened
 *   c. the message list (all messages)
 *   d. the conversation list, the last message of a connected Claude
 *   e. "Rád vár", the recently closed rows decided through a connected Claude
 *   h. a conversation thread with the viewer's own connected Claude message
 *   f. Settings → history
 *   g. a. in the dark theme
 */
const WIDTHS = [1512, 390];
const KEY = { id: 'cred_shot', prefix: 'pmk_7Hq2' };

export default async ({ instance, open, shoot, step }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const humans = config.team.members.filter((m) => m.kind === 'human');
  const owner = humans.find((m) => m.access === 'owner');
  const approver = humans.find((m) => m.handle !== owner.handle) ?? owner;
  const developer = config.team.members.find((m) => m.kind === 'ai' && m.role === 'developer');
  const detail = await instance.api('/api/projects/AC/tasks/AC-1');
  const at = (n) => new Date(Date.now() - (20 - n) * 60_000).toISOString();

  const direct = {
    kind: 'human',
    handle: owner.handle,
    via: 'integrator',
    through: { holder: owner.handle, credential: KEY },
  };
  const external = {
    kind: 'ai',
    handle: developer.handle,
    via: 'integrator',
    through: { holder: owner.handle, credential: KEY },
  };
  const approved = { ...external, approvedBy: approver.handle };
  const legacy = {
    kind: 'ai',
    handle: developer.handle,
    via: 'integrator',
    operatorMode: 'super',
    credential: KEY,
  };
  const note = (n, actor, text) => ({
    id: `evt_shot_${n}`,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: null,
    actor,
    type: 'task_note',
    data: { text, mentions: [] },
    createdAt: at(n),
  });
  const timeline = [
    note(1, direct, 'Direct instruction.'),
    note(2, external, 'External work (MCP).'),
    note(3, approved, 'An approved step.'),
    note(4, legacy, 'An old super row.'),
  ];
  const page = await open({ path: '/p/AC/tasks/AC-1' });
  const visit = (path) => page.goto(new URL(path, page.url()).href);
  const shot = (name) => shoot(page, name, { widths: WIDTHS });

  await page.route('**/api/projects/AC/tasks/AC-1', (route) =>
    route.fulfill({ json: { ...detail, timeline: [...detail.timeline, ...timeline] } }),
  );
  const messages = await instance.api('/api/projects/AC/messages');
  const message = (n, actor, to) => ({
    id: `msg_shot_${n}`,
    projectKey: 'AC',
    from: actor.handle,
    via: 'integrator',
    actor,
    to: [to],
    taskKey: 'AC-1',
    body: `Message ${n}.`,
    createdAt: at(n),
    deliveredAt: at(n),
  });
  await page.route('**/api/projects/AC/messages*', (route) =>
    route.fulfill({
      json: {
        ...messages,
        messages: [
          message(1, direct, developer.handle),
          message(2, external, owner.handle),
          message(3, approved, owner.handle),
          message(4, legacy, owner.handle),
        ],
      },
    }),
  );
  const view = await instance.api('/api/projects/AC/config');
  await page.route('**/api/projects/AC/config', (route) =>
    route.fulfill({
      json: {
        ...view,
        history: [approved, external, legacy].map((actor, n) => ({
          version: `${n}abcdef0123456789`,
          message: `Config change ${n + 1}`,
          author: actor.handle,
          at: at(n + 1),
          actor,
        })),
      },
    }),
  );

  const timelineShot = async (name, scheme, expand = false) => {
    await page.emulateMedia({ colorScheme: scheme });
    await visit('/p/AC/tasks/AC-1/timeline');
    await page.getByText('An approved step.').waitFor();
    if (expand) {
      const chips = page.getByRole('button', { name: /Csatlakozott Claude/ });
      for (let i = (await chips.count()) - 1; i >= 0; i--) await chips.nth(i).click();
    }
    await shot(name);
  };

  await step('a. the card timeline', () => timelineShot('a-timeline', 'light'));
  await step('b. the chips opened', () => timelineShot('b-timeline-open', 'light', true));
  await step('c. the message list', async () => {
    await visit('/p/AC/messages/all');
    await page.getByText('Message 3.').waitFor();
    await shot('c-messages');
  });
  await step('d. the conversation list', async () => {
    const other = config.team.members.find(
      (m) => m.kind === 'ai' && m.handle !== developer.handle && m.handle !== owner.handle,
    );
    await page.route('**/api/projects/AC/messages/threads', (route) =>
      route.fulfill({
        json: {
          threads: [
            { peer: developer.handle, lastMessage: message(2, external, owner.handle), unreadCount: 1 },
            { peer: other.handle, lastMessage: message(1, direct, other.handle), unreadCount: 0 },
          ],
          unreadCount: 1,
        },
      }),
    );
    // A wide screen opens the latest conversation beside the list; a narrow one shows the list alone.
    await visit('/p/AC/messages');
    await page.getByText('Message 2.', { exact: false }).first().waitFor();
    await shoot(page, 'd-conversation-list', { widths: [1512] });
    await page.setViewportSize({ width: 390, height: 844 });
    await visit('/p/AC/messages');
    await page.getByText('Message 2.', { exact: false }).first().waitFor();
    await shoot(page, 'd-conversation-list', { widths: [390] });
    await page.setViewportSize({ width: 1512, height: 982 });
  });
  await step('e. the recently closed row in "Rád vár"', async () => {
    const resolved = (n, actor) => ({
      id: `inb_shot_${n}`,
      projectKey: 'AC',
      kind: 'question',
      assignees: [owner.handle],
      source: developer.handle,
      sessionId: null,
      taskKey: 'AC-1',
      title: `Should the basket button turn green? (${n})`,
      body: null,
      payload: {},
      options: [{ id: 'yes', label: 'Yes', style: 'primary' }],
      state: 'resolved',
      resolution: { via: 'integrator', actor, optionId: 'yes', by: actor.handle, at: at(10 + n), note: null },
      createdAt: at(5 + n),
    });
    await page.route('**/api/projects/AC/inbox**', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (!body.items) return route.fulfill({ response });
      return route.fulfill({
        json: { ...body, items: [resolved(1, direct), resolved(2, approved)] },
      });
    });
    await visit('/p/AC/inbox');
    await page.getByText('(2)', { exact: false }).first().waitFor();
    await shot('e-inbox-recent');
  });
  await step('h. a thread with the own connected message', async () => {
    await visit(`/p/AC/messages/with/${developer.handle}`);
    await page.getByText('Message 1.').waitFor();
    await shot('h-thread');
  });
  await step('f. settings history', async () => {
    await visit('/p/AC/settings/history');
    await page.getByText('Config change 1').waitFor();
    await shot('f-history');
  });
  await step('g. the timeline, dark theme', () => timelineShot('g-timeline-dark', 'dark'));
};
