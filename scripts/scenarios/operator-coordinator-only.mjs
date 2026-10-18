/** PM-780: owner channel after coordinator-only signals have been filtered by the server. */
export default async ({ instance, open, shoot, step }) => {
  const members = await instance.api('/api/projects/AC/members');
  const operator = members.find((member) => member.kind === 'ai' && member.role === 'ai_operator');
  const owner = (await instance.api('/api/me')).handles.AC;
  const at = new Date().toISOString();
  const signal = (id, kind, extra = {}) => ({
    id,
    kind,
    state: 'open',
    actionable: true,
    taskKey: 'AC-1',
    subject: null,
    inboxItemId: null,
    messageId: null,
    raisedAt: at,
    decidedBy: null,
    decidedAt: null,
    resolvedAt: null,
    ...extra,
  });
  const message = (id, body) => ({
    id,
    projectKey: 'AC',
    from: operator.handle,
    to: [owner],
    taskKey: null,
    body,
    createdAt: at,
    deliveredAt: at,
    kind: 'info',
  });
  const scenes = [
    {
      name: 'a-mixed-trailing',
      signals: ['stalled', 'silent', 'nobody'].map((kind, i) => signal(`sig_${i}`, kind)),
      messages: [],
    },
    { name: 'b-only-coordinator-empty', signals: [], messages: [] },
    {
      name: 'c-mixed-linked',
      signals: ['stalled', 'nobody'].map((kind, i) =>
        signal(`linked_${i}`, kind, { messageId: 'msg_mixed' }),
      ),
      messages: [message('msg_mixed', 'A két kártya döntésre vár.')],
    },
    { name: 'd-historical-text', signals: [], messages: [message('msg_old', 'Lezárult szakaszok: AC-1.')] },
    {
      name: 'e-outage',
      signals: [signal('outage', 'outage', { actionable: false, taskKey: null, inboxItemId: 'inb_outage' })],
      messages: [],
    },
  ];
  for (const scene of scenes)
    await step(scene.name, async () => {
      const page = await open({ path: '/p/AC', width: 1512 });
      await page.route(
        (url) => url.pathname === '/api/projects/AC/operator',
        async (route) => {
          const response = await route.fetch();
          const channel = await response.json();
          await route.fulfill({
            json: { ...channel, requests: [], signals: scene.signals, openSignals: scene.signals.length },
          });
        },
      );
      await page.route(
        (url) => url.pathname === '/api/projects/AC/messages' && url.search.includes('threadWith=operator'),
        async (route) => {
          const response = await route.fetch();
          const thread = await response.json();
          await route.fulfill({ json: { ...thread, messages: scene.messages } });
        },
      );
      await page.reload();
      await page.click('[data-operator-button]');
      await page.waitForSelector('#operator-panel textarea');
      if (scene.messages.length)
        await page.getByText(scene.messages[0].body.split(':')[0], { exact: false }).first().waitFor();
      if (scene.signals.length) await page.waitForSelector('#operator-panel [data-state="open"]');
      await shoot(page, scene.name, { widths: [1512, 390] });
      await page.close();
    });
};
