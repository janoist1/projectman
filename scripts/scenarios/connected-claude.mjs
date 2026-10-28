/**
 * PM-1075 review pictures: a step made through a connected Claude (decision 66) beside the plain and the old
 * super rows, varied only in the disposable browser's responses.
 *
 *   a. the card timeline: a direct instruction, external work (MCP), an approved step and an old super row
 *   b. a. with the chip opened
 *   c. the message list (all messages)
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
  await step('f. settings history', async () => {
    await visit('/p/AC/settings/history');
    await page.getByText('Config change 1').waitFor();
    await shot('f-history');
  });
  await step('g. the timeline, dark theme', () => timelineShot('g-timeline-dark', 'dark'));
};
