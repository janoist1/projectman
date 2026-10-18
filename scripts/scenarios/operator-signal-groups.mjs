/** PM-781: chronological, collapsible signal groups and bulk dismissal on desktop and phone. */
export default async ({ instance, open, shoot }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const members = await instance.api('/api/projects/AC/members');
  const operator = members.find((member) => member.role === 'ai_operator').handle;
  const at = (minute) => new Date(Date.now() - (120 - minute) * 60_000).toISOString();
  const makeSignals = (count, start = 0) =>
    Array.from({ length: count }, (_, index) => ({
      id: `sig_group_${index}`,
      kind: 'nobody',
      state: 'open',
      actionable: true,
      taskKey: 'AC-1',
      subject: null,
      inboxItemId: null,
      messageId: null,
      raisedAt: at(start + index),
      decidedAt: null,
      decidedBy: null,
      resolvedAt: null,
    }));
  const messages = [
    {
      id: 'msg_group_question',
      projectKey: 'AC',
      from: owner,
      to: [operator],
      taskKey: null,
      body: 'Mi a helyzet a munkával?',
      createdAt: at(60),
      deliveredAt: at(60),
    },
    {
      id: 'msg_group_reply',
      projectKey: 'AC',
      from: operator,
      to: [owner],
      taskKey: null,
      body: 'A munka halad. A legújabb válasz itt, a beviteli mező fölött látszik.',
      createdAt: at(61),
      deliveredAt: at(61),
    },
  ];
  let signals = makeSignals(55);
  let readOnly = false;
  let fail = true;
  const page = await open({ path: '/p/AC' });
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route(
    (url) => url.pathname === '/api/projects/AC/operator',
    async (route) => {
      const response = await route.fetch();
      await json(route, response.status(), {
        ...(await response.json()),
        readOnly,
        signals,
        openSignals: signals.filter((signal) => signal.state === 'open').length,
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/projects/AC/messages' && url.searchParams.get('threadWith') === operator,
    async (route) => {
      const response = await route.fetch();
      await json(route, response.status(), { ...(await response.json()), messages });
    },
  );
  await page.route(
    (url) => /\/operator\/signals\/sig_group_\d+\/dismiss$/.test(url.pathname),
    async (route) => {
      const id = route.request().url().split('/').at(-2);
      if (fail && id === 'sig_group_1')
        return json(route, 500, { error: { code: 'internal', message: 'Temporary failure' } });
      const signal = signals.find((signal) => signal.id === id);
      Object.assign(signal, { state: 'dismissed', decidedAt: new Date().toISOString(), decidedBy: owner });
      await json(route, 200, signal);
    },
  );
  await page.reload();
  const panel = page.locator('#operator-panel');
  const toggle = panel.locator('h3 button[aria-expanded]').first();
  const capture = async (name) => shoot(page, name, { widths: [1512, 390] });
  const reopen = async () => {
    await page.reload();
    await page.click('[data-operator-button]');
    await toggle.waitFor();
  };
  await reopen();
  await capture('a-collapsed');
  // Verify the real browser layout, including the phone viewport used by shoot.
  for (const width of [1512, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const reply = panel.getByText(messages[1].body);
    const composer = panel.locator('textarea');
    const replyBox = await reply.boundingBox();
    const composerBox = await composer.boundingBox();
    if (!replyBox || !composerBox || replyBox.y < 0 || replyBox.y + replyBox.height > composerBox.y)
      throw new Error('The latest reply is outside the visible thread');
  }
  await toggle.click();
  await capture('a-expanded');
  await panel.getByRole('button', { name: /^Mind / }).click();
  await capture('a-confirm');
  await panel.getByRole('button', { name: /^Mégse$/ }).click();
  await panel
    .locator('li')
    .first()
    .getByRole('button', { name: /^Most ne$/ })
    .click();
  await panel.locator('li[data-state="dismissed"]').waitFor();
  for (const width of [1512, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const log = document.querySelector('#operator-panel [role="log"]');
      const dismissed = log.querySelector('li[data-state="dismissed"]');
      const next = log.querySelector('li[data-state="open"] button');
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const viewport = log.getBoundingClientRect();
        return rect.top >= viewport.top && rect.bottom <= viewport.bottom;
      };
      return visible(dismissed) && visible(next) && document.activeElement === next;
    });
  }
  await capture('a-dismissed-row');
  await panel.getByRole('button', { name: /^Mind / }).click();
  await panel.getByRole('button', { name: /^Igen, mindet/ }).click();
  await panel.getByRole('alert').waitFor();
  await capture('a-partial-failure');
  fail = false;
  await panel.getByRole('button', { name: /^Újra$/ }).click();
  await panel.locator('h3 button[aria-expanded="false"]').waitFor();
  await capture('a-all-dismissed');
  signals = makeSignals(2, 62);
  await reopen();
  await capture('b-after-reply');
  signals = makeSignals(55, 62);
  await reopen();
  await toggle.click();
  for (const width of [1512, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => {
      const log = document.querySelector('#operator-panel [role="log"]');
      const header = log.querySelector('h3 button[aria-expanded="true"]').getBoundingClientRect();
      const viewport = log.getBoundingClientRect();
      return header.top >= viewport.top && header.bottom <= viewport.bottom;
    });
  }
  await capture('b-expanded-after-reply');
  signals = makeSignals(1, 62);
  await page.reload();
  await page.click('[data-operator-button]');
  await panel.locator('[data-signal]').waitFor();
  await capture('c-single');
  signals = makeSignals(6);
  readOnly = true;
  await reopen();
  await toggle.click();
  await capture('d-read-only');
};
