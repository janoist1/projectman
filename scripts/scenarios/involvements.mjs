/** PM-251 review fixtures, varied only in the disposable browser's responses. */
const TEXT = {
  quote: 'Kérlek, készíts tervet az Üzenetek oldalhoz.',
  stop: 'Rossz kártyán dolgozott.',
  long: 'A tervező másik kártyán dolgozott, ezért ezt a munkamenetet most leállítom. Az új kártyán újra bevonom, és a pontos feladatot ott írom le, hogy az előzmények követhetők maradjanak.',
};
export default async ({ instance, open, shoot, step }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const developer = config.team.members.find((m) => m.kind === 'ai' && m.role === 'developer');
  const owner = config.team.members.find((m) => m.kind === 'human' && m.access === 'owner');
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  const detail = await instance.api('/api/projects/AC/tasks/AC-1');
  const sessionDetail = await instance.api(`/api/projects/AC/sessions/${sessionId}`);
  const by = { kind: 'human', handle: owner.handle };
  const integrator = { ...by, via: 'integrator' };
  const at = (n) => new Date(Date.now() - (20 - n) * 60_000).toISOString();
  const event = (n, data, type = 'session_started') => ({
    id: `evt_shot_${n}`,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId,
    actor: { kind: 'ai', handle: developer.handle },
    type,
    data: { member: developer.handle, resumed: false, ...data },
    createdAt: at(n),
  });
  const timeline = [
    event(1, { cause: { kind: 'start_button', by } }),
    event(2, { cause: { kind: 'message', by: integrator, quote: TEXT.quote, messageId: 'msg_shot' } }),
    event(3, { cause: { kind: 'refinement', labels: ['plan-ok'] } }),
    event(4, { cause: { kind: 'hand_over', by, from: 'dev', to: 'review' } }),
    event(5, { stop: { kind: 'manual', by, note: TEXT.stop }, exitCode: 0 }, 'session_ended'),
    event(6, { stop: { kind: 'manual', by: integrator }, exitCode: 0 }, 'session_ended'),
    event(
      7,
      { stop: { kind: 'step_done', taskKey: 'AC-1', stageId: 'review' }, exitCode: 0 },
      'session_ended',
    ),
  ];
  const items = [...timeline].reverse().map((event) => ({ event, taskTitle: detail.task.title }));
  const page = await open({ path: '/p/AC' });
  const visit = (path) => page.goto(new URL(path, page.url()).href);
  const shot = (name) => shoot(page, name, { widths: [1512, 390] });
  await page.route('**/api/projects/AC/tasks/AC-1', (route) =>
    route.fulfill({ json: { ...detail, timeline: [...detail.timeline, ...timeline] } }),
  );
  await page.route(`**/api/projects/AC/sessions/${sessionId}`, (route) =>
    route.fulfill({
      json: {
        ...sessionDetail,
        chat: [
          ...sessionDetail.chat,
          {
            id: 'chat_shot',
            ts: at(8),
            kind: 'team_message',
            direction: 'in',
            from: owner.handle,
            via: 'integrator',
            to: [developer.handle],
            text: TEXT.quote,
          },
        ],
      },
    }),
  );
  let mode = 'list';
  let finishLoading;
  await page.route('**/api/projects/AC/involvements*', async (route) => {
    if (mode === 'loading')
      await new Promise((resolve) => {
        finishLoading = resolve;
      });
    const rows =
      mode === 'empty'
        ? []
        : new URL(route.request().url()).searchParams.get('limit') === '5'
          ? items.slice(0, 5)
          : items;
    await route.fulfill({
      json: {
        items: rows,
        counts: {
          started: rows.filter(({ event }) => event.type === 'session_started').length,
          stopped: rows.filter(({ event }) => event.type === 'session_ended').length,
        },
        nextBefore: null,
      },
    });
  });
  await step('timeline and session conversation', async () => {
    await visit('/p/AC/tasks/AC-1');
    await page
      .getByText(/Indítás gomb/)
      .first()
      .waitFor();
    await shot('involvement-timeline');
    await shoot(page, 'involvement-stops', { widths: [1512, 390], highlight: '#timeline-evt_shot_7' });
    await visit(`/p/AC/sessions/${sessionId}`);
    await page.getByText(TEXT.quote, { exact: true }).waitFor();
    await shot('integrator-conversation');
  });
  await step('stop dialog states', async () => {
    await page.setViewportSize({ width: 1512, height: 900 });
    await page.getByRole('button', { name: 'További műveletek', exact: true }).click();
    await page.getByRole('button', { name: 'Leállítás', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await shot('stop-dialog-empty');
    await page.getByLabel('Miért? (nem kötelező)').fill(TEXT.long);
    await shot('stop-dialog-counter');
    await page.route(`**/api/projects/AC/sessions/${sessionId}/stop`, (route) =>
      route.fulfill({
        status: 409,
        json: { error: { code: 'session_not_running', message: 'The session ended.' } },
      }),
    );
    await page.getByRole('dialog').getByRole('button', { name: 'Leállítás', exact: true }).click();
    await page.getByRole('alert').waitFor();
    await shot('stop-dialog-error');
  });
  await step('overview states', async () => {
    await visit('/p/AC/sessions');
    await page.getByText(TEXT.stop, { exact: false }).waitFor();
    await shot('involvements-list');
    mode = 'loading';
    await visit('/p/AC/sessions');
    await page.getByRole('status', { name: 'Betöltés…', exact: true }).waitFor();
    await shot('involvements-loading');
    mode = 'empty';
    finishLoading?.();
    await visit('/p/AC/sessions?period=all');
    await page.getByText('Még nincs rögzített bevonás.', { exact: true }).waitFor();
    await shot('involvements-first-use');
    await visit(`/p/AC/sessions?member=${developer.handle}`);
    await page.getByText('Nincs a szűrésnek megfelelő bevonás.', { exact: true }).waitFor();
    await shot('involvements-no-results');
    mode = 'list';
  });
  await step('team and profile', async () => {
    await visit('/p/AC/team');
    await page.getByRole('heading', { name: 'Legutóbbi bevonások' }).waitFor();
    await shoot(page, 'recent-involvements', { widths: [1512, 390], highlight: '#recent-involvements' });
    await page.route(`**/api/projects/AC/members/${developer.handle}/profile`, async (route) => {
      const response = await route.fetch();
      const profile = await response.json();
      for (const session of profile.sessions)
        if (session.id === sessionId) session.startCause = timeline[1].data.cause;
      profile.timeline.push(...timeline);
      await route.fulfill({ response, json: profile });
    });
    await visit(`/p/AC/team/${developer.handle}`);
    await page
      .getByText(/csapatüzenet/)
      .first()
      .waitFor();
    await shoot(page, 'member-involvements', { widths: [1512, 390], highlight: 'p[class*="involvement"]' });
  });
  await step('integrator key states with a fictional secret', async () => {
    const metadata = {
      prefix: 'pmi_example',
      createdAt: at(1),
      expiresAt: new Date(Date.now() + 90 * 86_400_000).toISOString(),
      lastUsedAt: at(8),
      revokedAt: null,
      state: 'active',
    };
    let key = null;
    await page.route('**/api/auth/integrator-key', async (route) => {
      if (route.request().method() === 'POST') {
        key = metadata;
        await route.fulfill({ status: 201, json: { key, secret: 'pmi_example_not_a_real_access_key' } });
      } else await route.fulfill({ json: { key } });
    });
    await visit('/p/AC/settings/integrator');
    await page.getByText('Még nincs kulcs.', { exact: true }).waitFor();
    await shot('integrator-no-key');
    await page.getByRole('button', { name: 'Kulcs létrehozása', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Kulcs létrehozása', exact: true }).click();
    await page.getByText('pmi_example_not_a_real_access_key', { exact: true }).waitFor();
    await shot('integrator-once-visible-example');
    await page.getByRole('button', { name: 'Kész, bemásoltam' }).click();
    await shot('integrator-active');
    key = { ...metadata, expiresAt: new Date(Date.now() + 3 * 86_400_000).toISOString() };
    await page.reload();
    await page.getByText(/A kulcs 3 nap múlva lejár/).waitFor();
    await shot('integrator-expiring');
    key = { ...metadata, state: 'revoked', revokedAt: at(9) };
    await page.reload();
    await page.getByText('Visszavonva', { exact: true }).waitFor();
    await shot('integrator-revoked');
  });
};
