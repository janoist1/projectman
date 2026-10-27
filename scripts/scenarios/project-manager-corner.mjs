/**
 * Screenshots for PM-1042 (docs/SCREENSHOTS.md): the project manager in the top right corner, and the
 * machine grant that moved out of its panel (the machine panel row and Settings → Integrator).
 *
 * The server and the fake CLIs are real, but a real manager turn (steps, signals, a queue) needs a running
 * session, so the corner's answer (`/project-manager`) and the thread are changed in the browser, as
 * `operator.mjs` does. Everything else is the real UI on the real demo project.
 *
 *   npm run shots -- scripts/scenarios/project-manager-corner.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  if (!pm) throw new Error('the demo project has no project manager');
  const owner = (await instance.api('/api/me')).handles.AC;
  const worker = members.find(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  log(`pm: ${pm.handle}, owner: ${owner}, worker: ${worker?.handle}`);

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const message = (id, from, to, body, createdAt, extra = {}) => ({
    id,
    projectKey: 'AC',
    from,
    to: [to],
    taskKey: null,
    body,
    createdAt,
    deliveredAt: createdAt,
    ...extra,
  });
  const signal = (id, kind, extra = {}) => ({
    id,
    kind,
    state: 'open',
    actionable: true,
    taskKey: 'AC-1',
    subject: null,
    inboxItemId: null,
    messageId: null,
    raisedAt: minutesAgo(12),
    decidedBy: null,
    decidedAt: null,
    resolvedAt: null,
    ...extra,
  });
  const request = {
    id: 'opr_demo1',
    messageId: 'msg_pm_1',
    quote: 'Állítsd át az AC-2 prioritását magasra',
    openedAt: minutesAgo(30),
    closedAt: minutesAgo(27),
    steps: [
      {
        id: 'ops_1',
        requestId: 'opr_demo1',
        at: minutesAgo(28),
        action: 'task_priority',
        status: 'done',
        taskKey: 'AC-2',
        member: null,
        changes: [],
        configVersion: null,
        inboxItemId: null,
        signalId: null,
        refusal: null,
      },
    ],
  };
  const thread = [
    message('msg_pm_1', owner, pm.handle, request.quote, minutesAgo(30)),
    message('msg_pm_2', pm.handle, owner, 'Az AC-2 prioritását magasra állítottam.', minutesAgo(27), {
      operatorRequest: 'opr_demo1',
    }),
  ];

  // What the browser is told on top of the server's answers.
  const state = { corner: {}, grant: null, messages: [], answer: 'ok' };
  const attach = async (page) => {
    page.on('response', (response) => {
      if (response.status() >= 400) log(`${response.status()} ${response.url()}`);
    });
    await page.route(
      (url) => url.pathname === '/api/projects/AC/project-manager',
      async (route) => {
        // `loading` never answers; `error` answers with a failure.
        if (state.answer === 'loading') return;
        if (state.answer === 'error')
          return json(route, { error: { code: 'internal', message: 'The corner could not be read' } }, 500);
        const response = await route.fetch();
        const body = await response.json();
        json(route, { ...body, ...state.corner }, response.status());
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages' && url.search.includes(`threadWith=${pm.handle}`),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, { ...body, messages: [...body.messages, ...state.messages] }, response.status());
      },
    );
    await page.route(
      (url) => url.pathname === '/api/auth/operator-grant',
      async (route) => {
        if (!state.grant) return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, { grant: { ...body.grant, ...state.grant } }, response.status());
      },
    );
  };
  const reset = (corner = {}, messages = []) => {
    state.corner = corner;
    state.messages = messages;
  };
  const openWith = async (options = {}) => {
    const page = await open({ path: '/p/AC', width: 1512, ...options });
    await attach(page);
    await page.goto(new URL(options.path ?? '/p/AC', page.url()).href);
    await page.waitForSelector('[data-operator-button]');
    return page;
  };
  const openPanel = async (page, composer = true) => {
    await page.click('[data-operator-button]');
    await page.waitForSelector(composer ? '#operator-panel textarea' : '#operator-panel');
    await page.waitForTimeout(400);
  };

  await step('a. the owner: a signal, the steps and an approval', async () => {
    reset(
      {
        requests: [request],
        signals: [
          signal('ops_s1', 'nobody', { messageId: 'msg_sig_1' }),
          signal('ops_s2', 'silent', { actionable: false, messageId: 'msg_sig_2', raisedAt: minutesAgo(40) }),
        ],
        openSignals: 2,
        queue: { open: 2, current: { id: 'q1', title: 'AC-3 átnézése' } },
      },
      [
        ...thread,
        message(
          'msg_sig_1',
          pm.handle,
          owner,
          'Az AC-1 kártyát most senki nem viheti. Javaslom, hogy adj fejlesztő szerepet valakinek.',
          minutesAgo(12),
          { operatorSignal: 'ops_s1', taskKey: 'AC-1' },
        ),
        message(
          'msg_sig_2',
          pm.handle,
          owner,
          'Az egyik munkamenet régóta dolgozik, de nem ad jelet.',
          minutesAgo(40),
          { operatorSignal: 'ops_s2', taskKey: 'AC-1' },
        ),
      ],
    );
    const page = await openWith();
    await openPanel(page);
    await shoot(page, 'a-owner-panel', { widths: WIDTHS });
  });

  await step('b. the button: signal, queue, on leave, nothing', async () => {
    const states = {
      'b-button-signal': {
        openSignals: 1,
        signals: [signal('ops_s1', 'nobody')],
        queue: { open: 0, current: null },
      },
      'b-button-queue': { openSignals: 0, signals: [], queue: { open: 3, current: null } },
      'b-button-on-leave': {
        openSignals: 0,
        signals: [],
        queue: { open: 0, current: null },
        state: 'on_leave',
        member: { handle: pm.handle, displayName: pm.displayName, onLeave: true },
      },
      'b-button-none': { openSignals: 0, signals: [], queue: { open: 0, current: null } },
      'b-button-working': {
        openSignals: 0,
        signals: [],
        queue: { open: 0, current: null },
        state: 'working',
      },
    };
    for (const [name, corner] of Object.entries(states)) {
      reset(corner);
      const page = await openWith();
      await shoot(page, name, { widths: WIDTHS, highlight: '[data-operator-button]' });
    }
    // On a narrow desktop the label sheds the name and shows "PM".
    reset({ openSignals: 0, signals: [], queue: { open: 0, current: null } });
    const narrow = await openWith({ width: 1024 });
    await shoot(narrow, 'b-button-narrow-desktop', { widths: [1024], highlight: '[data-operator-button]' });
  });

  await step('c. a client', async () => {
    // A client writes only to the project's contacts: the project manager is one of them.
    const { config, version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: {
        baseVersion: version,
        contacts: [...new Set([...(config.team.contacts ?? []), pm.handle])],
      },
    });
    const client = await instance.invite({
      project: 'AC',
      email: 'cleo@acme.test',
      name: 'Cleo Client',
      access: 'client',
    });
    reset({}, []);
    const page = await openWith({ as: client });
    await openPanel(page);
    await shoot(page, 'c-client-panel', { widths: WIDTHS });
  });

  await step('d. a read-only viewer', async () => {
    const viewer = await instance.invite({
      project: 'AC',
      email: 'vera@acme.test',
      name: 'Vera Viewer',
      access: 'viewer',
    });
    reset({}, []);
    const page = await openWith({ as: viewer });
    await openPanel(page);
    await shoot(page, 'd-viewer-panel', { widths: WIDTHS });
  });

  await step('e. first use, f. on leave, g. no project manager (owner)', async () => {
    const empty = { requests: [], signals: [], openSignals: 0, queue: { open: 0, current: null } };
    for (const [name, corner] of [
      ['e-first-use', empty],
      [
        'f-on-leave',
        {
          ...empty,
          state: 'on_leave',
          member: { handle: pm.handle, displayName: pm.displayName, onLeave: true },
        },
      ],
      ['g-no-manager', { ...empty, state: 'missing', member: null, sessionId: null }],
    ]) {
      reset(corner);
      const page = await openWith();
      await openPanel(page, corner.state !== 'missing');
      await shoot(page, name, { widths: WIDTHS });
    }
  });

  await step('h. loading and error', async () => {
    for (const [answer, width] of [
      ['loading', 1512],
      ['loading', 390],
      ['error', 1512],
      ['error', 390],
    ]) {
      reset();
      state.answer = answer;
      const page = await openWith({ width });
      await openPanel(page, false);
      // The failed query retries before the panel shows its error; a resize would restart it.
      if (answer === 'error')
        await page.getByRole('button', { name: 'Újra', exact: true }).waitFor({ timeout: 15000 });
      await shoot(page, `h-${answer}`, { widths: [width] });
    }
    state.answer = 'ok';
  });

  await step('i. the machine panel: grant given and not given', async () => {
    for (const [name, grant] of [
      ['i-machine-grant-on', { active: true, expiresAt: null, canManage: true }],
      ['i-machine-grant-off', { active: false, expiresAt: null, canManage: true }],
    ]) {
      reset();
      state.grant = grant;
      const page = await openWith();
      await page.getByRole('button', { name: /Gép: / }).click();
      await page.getByRole('dialog', { name: 'Gép és munkamenetek' }).waitFor();
      await shoot(page, name, { widths: WIDTHS });
    }
  });

  await step('j. Settings → Integrator', async () => {
    reset();
    state.grant = { active: true, expiresAt: null, canManage: true };
    const page = await openWith({ path: '/p/AC/settings/integrator' });
    await shoot(page, 'j-settings-integrator', { widths: WIDTHS, fullPage: true });
  });
};
