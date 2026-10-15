/** PM-700: critical proposals in the real inbox UI, with typed persisted-payload examples. */
export default async ({ instance, open, shoot, step }) => {
  await instance.invite({
    project: 'AC',
    email: 'review-guest@example.test',
    name: 'Review guest',
    access: 'client',
  });
  const members = await instance.api('/api/projects/AC/members');
  const operator = members.find((member) => member.kind === 'ai' && member.role === 'ai_operator');
  const recipient = members.find((member) => member.kind === 'human' && member.role === 'client');
  const owner = (await instance.api('/api/me')).handles.AC;
  if (!operator || !recipient) throw new Error('Demo members missing');
  const stamp = (minutes) => new Date(Date.now() + minutes * 60_000).toISOString();
  const message =
    'Szia!\n\nA kért munka elkészült. A részleteket a megosztott kártyán találod.\n\nKöszönöm a visszajelzésed!';
  const base = {
    requestId: 'opr_critical',
    stepId: 'ops_critical',
    quote: 'Mutasd meg, mit küldenél az ügyfélnek.',
    action: 'message',
    operation: { op: 'message_send', to: [recipient.handle], text: message, taskKey: 'AC-1' },
    changes: [],
    consequence: 'message_send',
    baseVersion: null,
    session: null,
    stale: null,
    plan: {
      why: 'Az ügyfélnek jelezném, hogy a kért munka elkészült.',
      impact: 'Egy pontos üzenetet kap az Operátor nevében. Másnak nem küldünk értesítést.',
      reversible: false,
    },
    expiresAt: stamp(24 * 60),
  };
  const states = [
    ['message', base],
    [
      'long-message',
      {
        ...base,
        operation: {
          ...base.operation,
          text:
            message +
            '\n\n' +
            'A teljes tájékoztatás megmarad, és a tulajdonos jóváhagyás előtt minden részletet elolvashat. '.repeat(
              50,
            ) +
            '\n\nVége.',
        },
      },
    ],
    [
      'stop',
      {
        ...base,
        action: 'session_stop',
        operation: { op: 'session_stop', sessionId: 'ses_target' },
        consequence: 'session_stop',
        session: { id: 'ses_target', startedAt: stamp(-90) },
        plan: {
          why: 'A fejlesztő ülése elakadt, a leállítást javaslom.',
          impact: 'A munkamenet leáll. A kártya a megszokott módon folytatható.',
          reversible: true,
        },
      },
    ],
    ['expires-soon', { ...base, expiresAt: stamp(25) }],
    ['expired', { ...base, expiresAt: stamp(-1), stale: { reason: 'expired', at: stamp(-1) } }],
    ['interrupted', { ...base, stale: { reason: 'interrupted', at: stamp(-1) } }],
    [
      'legacy',
      {
        ...base,
        action: 'session_stop',
        operation: { op: 'session_stop', sessionId: 'ses_target' },
        consequence: 'session_stop',
        plan: undefined,
        expiresAt: undefined,
      },
    ],
  ];
  const page = await open({ path: '/p/AC' });
  let payload = base;
  await page.route(
    (url) => url.pathname === '/api/projects/AC/inbox',
    async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: [
            {
              id: 'inb_critical',
              projectKey: 'AC',
              kind: 'approval',
              assignees: [owner],
              source: operator.handle,
              sessionId: null,
              taskKey: null,
              title:
                payload.operation.op === 'message_send' ? 'Üzenet az ügyfélnek' : 'Munkamenet leállítása',
              body: null,
              payload: { operator: payload },
              options: payload.stale
                ? [{ id: 'dismiss', label: 'dismiss', style: 'secondary' }]
                : [
                    { id: 'approve', label: 'approve', style: 'primary' },
                    { id: 'reject', label: 'reject', style: 'secondary' },
                  ],
              state: 'open',
              resolution: null,
              createdAt: stamp(-5),
            },
          ],
        }),
      });
    },
  );
  for (const [name, value] of states) {
    await step(name, async () => {
      payload = value;
      await page.goto(new URL('/p/AC/inbox', page.url()).href);
      await page.locator('[data-operator-approval]').waitFor();
      await shoot(page, name, { widths: [1512, 390] });
    });
  }
};
