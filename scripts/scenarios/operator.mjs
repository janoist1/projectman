/**
 * Screenshots for PM-447 (docs/SCREENSHOTS.md): the Operator in the corner, its steps, the signal cards, the
 * Rád vár approvals, the settings history, the Team page and the Messages page.
 *
 * The server and the fake CLIs are real, but a real Operator turn (steps, signals, proposals) needs a running
 * Operator session. So the pages are opened with the Operator's answers added in the browser, as
 * `work-outage.mjs` does: the channel (`/operator`), its thread (`/messages?threadWith=operator`), the inbox,
 * the configuration history, and the two decisions that can fail (409). Everything else is the real UI on the
 * real demo project.
 *
 *   npm run shots -- scripts/scenarios/operator.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

export default async ({ instance, open, shoot, step: scene, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const operator = members.find((member) => member.kind === 'ai' && member.role === 'ai_operator');
  if (!operator) throw new Error('the demo project has no Operator');
  const owner = (await instance.api('/api/me')).handles.AC;
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  const worker = members.find(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  log(`operator: ${operator.handle}, owner: ${owner}, pm: ${pm?.handle}, worker: ${worker?.handle}`);

  // What the browser is told on top of the server's answers.
  const state = {
    readOnly: null,
    requests: [],
    signals: [],
    messages: [],
    inbox: [],
    history: [],
    dismiss: 'ok',
    resolve: 'ok',
    sendFails: false,
  };

  const message = (id, from, to, body, extra = {}) => ({
    id,
    projectKey: 'AC',
    from,
    to: [to],
    taskKey: null,
    body,
    createdAt: minutesAgo(30),
    deliveredAt: minutesAgo(30),
    ...extra,
  });
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const failure = (code, text) => ({ error: { code, message: text } });

  const attach = async (page) => {
    await page.route(
      (url) => url.pathname === '/api/projects/AC/operator',
      async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const signals = state.readOnly !== null || body.readOnly === false ? state.signals : [];
        json(route, response.status(), {
          ...body,
          readOnly: state.readOnly ?? body.readOnly,
          requests: state.requests.length ? state.requests : body.requests,
          signals,
          openSignals: signals.filter((signal) => signal.state === 'open').length,
        });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages' && url.search.includes('threadWith=operator'),
      async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        const messages = [...body.messages, ...state.messages].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        json(route, response.status(), { ...body, messages });
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages',
      async (route) => {
        if (route.request().method() === 'POST' && state.sendFails)
          return json(route, 502, failure('internal', 'The message could not be sent'));
        if (route.request().method() === 'POST') {
          const input = route.request().postDataJSON();
          const signal = state.signals.find((signal) => signal.id === input.operatorSignal);
          if (signal) {
            signal.state = 'accepted';
            signal.decidedAt = new Date().toISOString();
            signal.decidedBy = owner;
            const accepted = message(`msg_accept_${signal.id}`, owner, operator.handle, input.text, {
              operatorSignal: signal.id,
            });
            state.messages.push(accepted);
            return json(route, 202, accepted);
          }
        }
        return route.fallback();
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/inbox',
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, response.status(), { ...body, items: [...state.inbox, ...body.items] });
      },
    );
    await page.route(
      (url) => /\/api\/projects\/AC\/inbox\/inb_op_[a-z0-9_]+\/resolve$/.test(url.pathname),
      (route) => {
        if (state.resolve === 'stale')
          return json(route, 409, failure('operator_approval_stale', 'The proposal is out of date'));
        return json(route, 200, {});
      },
    );
    await page.route(
      (url) => /\/api\/projects\/AC\/operator\/signals\/[a-z0-9_]+\/dismiss$/.test(url.pathname),
      (route) => {
        if (state.dismiss === 'closed')
          return json(route, 409, failure('operator_signal_closed', 'The signal is no longer open'));
        if (state.dismiss === 'failed')
          return json(route, 502, failure('internal', 'The decision could not be sent'));
        const signal = state.signals.find((signal) =>
          route.request().url().includes(`/${signal.id}/dismiss`),
        );
        if (signal) {
          signal.state = 'dismissed';
          signal.decidedAt = new Date().toISOString();
          signal.decidedBy = owner;
          return json(route, 200, signal);
        }
        return route.fallback();
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/config',
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, response.status(), { ...body, history: [...state.history, ...body.history] });
      },
    );
  };

  /** Opens `path` with the Operator's answers added. The page is opened once first so the routes can be set. */
  const openWith = async (path, options = {}) => {
    const page = await open({ path: '/p/AC', width: options.width ?? 1512, as: options.as });
    await attach(page);
    await page.goto(new URL(path, page.url()).href);
    await page.waitForSelector('[data-operator-button]');
    return page;
  };
  const openPanel = async (page) => {
    await page.click('[data-operator-button]');
    await page.waitForSelector('#operator-panel textarea');
  };

  // The request of the owner, its steps and the proposal that waits in Rád vár.
  const approvalPayload = (stepId, overrides = {}) => ({
    requestId: 'opr_demo1',
    stepId,
    quote: 'Add meg a Kutatónak az internetet',
    action: 'member_change',
    operation: { op: 'member_update', handle: worker.handle, changes: { outboundNetwork: true } },
    changes: [
      {
        area: 'member',
        target: worker.handle,
        field: 'outboundNetwork',
        before: 'false',
        after: 'true',
        level: 'approval',
      },
      {
        area: 'member',
        target: worker.handle,
        field: 'permissionMode',
        before: 'default',
        after: 'acceptEdits',
        level: 'approval',
      },
      {
        area: 'member',
        target: worker.handle,
        field: 'schedule',
        before: null,
        after:
          '{"days":["mon","tue","wed","thu","fri"],"time":"08:00","prompt":"Nézd át a nyitott kártyákat"}',
        level: 'approval',
      },
    ],
    consequence: 'network',
    baseVersion: 'base0001',
    session: null,
    stale: null,
    ...overrides,
  });
  const approvalItem = (id, stepId, payload, extra = {}) => ({
    id,
    projectKey: 'AC',
    kind: 'approval',
    assignees: [owner],
    source: operator.handle,
    sessionId: null,
    taskKey: null,
    title: 'Hálózat a Kutatónak',
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
    createdAt: minutesAgo(20),
    ...extra,
  });
  const step = (id, action, status, extra = {}) => ({
    id,
    requestId: 'opr_demo1',
    at: minutesAgo(28),
    action,
    status,
    taskKey: null,
    member: null,
    changes: [],
    configVersion: null,
    inboxItemId: null,
    refusal: null,
    ...extra,
  });

  await step_('a. the corner, owner, first use', async () => {
    const page = await openWith('/p/AC');
    await shoot(page, 'a-corner-closed', { widths: WIDTHS, highlight: '[data-operator-button]' });
    await openPanel(page);
    await shoot(page, 'a-corner-first-use', { widths: WIDTHS });
  });

  function step_(title, fn) {
    return scene(title, fn);
  }

  await step_('b. a thread with steps: done, waiting for approval, refused', async () => {
    state.requests = [
      {
        id: 'opr_demo1',
        messageId: 'msg_op_1',
        quote: 'Add meg a Kutatónak az internetet, és állítsd át az AC-2 prioritását magasra',
        openedAt: minutesAgo(30),
        closedAt: minutesAgo(27),
        steps: [
          step('ops_1', 'task_priority', 'done', { taskKey: 'AC-2' }),
          step('ops_0', 'member_change', 'done', {
            member: worker.handle,
            changes: [
              {
                area: 'member',
                target: worker.handle,
                field: 'model',
                before: 'opus',
                after: 'sonnet',
                level: 'now',
              },
            ],
            configVersion: 'op00001',
          }),
          step('ops_2', 'member_change', 'awaiting_approval', {
            member: worker.handle,
            changes: approvalPayload('ops_2').changes,
            inboxItemId: 'inb_op_demo1',
          }),
          step('ops_3', 'member_retire', 'refused', {
            member: pm?.handle ?? 'pm',
            refusal: { code: 'operator_never', message: 'Az Operátor nem bocsáthat el tagot.' },
          }),
        ],
      },
    ];
    state.messages = [
      message(
        'msg_op_1',
        owner,
        operator.handle,
        'Add meg a Kutatónak az internetet, és állítsd át az AC-2 prioritását magasra',
        { createdAt: minutesAgo(30) },
      ),
      message(
        'msg_op_2',
        operator.handle,
        owner,
        'Az AC-2 prioritását magasra állítottam. A Kutató hálózata jóváhagyást kér, az a Rád vár-ban vár rád.',
        { createdAt: minutesAgo(27), operatorRequest: 'opr_demo1' },
      ),
    ];
    state.inbox = [approvalItem('inb_op_demo1', 'ops_2', approvalPayload('ops_2'))];
    const page = await openWith('/p/AC');
    await openPanel(page);
    await page.waitForSelector('#operator-panel [data-request]');
    await shoot(page, 'b-corner-steps', { widths: WIDTHS });
  });

  await step_('c. the signal cards', async () => {
    const task = 'AC-1';
    const signal = (id, kind, extra = {}) => ({
      id,
      kind,
      state: 'open',
      actionable: true,
      taskKey: task,
      subject: null,
      inboxItemId: null,
      messageId: null,
      raisedAt: minutesAgo(12),
      decidedBy: null,
      decidedAt: null,
      resolvedAt: null,
      ...extra,
    });
    state.signals = [
      signal('ops_s1', 'nobody', { messageId: 'msg_sig_1', raisedAt: minutesAgo(50) }),
      signal('ops_s2', 'silent', { actionable: false, messageId: 'msg_sig_2', raisedAt: minutesAgo(40) }),
      signal('ops_s3', 'outage', { taskKey: null, subject: 'out_claude', raisedAt: minutesAgo(30) }),
      signal('ops_s4', 'stalled', {
        state: 'resolved',
        messageId: 'msg_sig_4',
        raisedAt: minutesAgo(90),
        resolvedAt: minutesAgo(60),
      }),
      signal('ops_s5', 'nobody', {
        state: 'accepted',
        messageId: 'msg_sig_5',
        taskKey: 'AC-2',
        raisedAt: minutesAgo(120),
        decidedBy: owner,
        decidedAt: minutesAgo(100),
      }),
    ];
    state.messages = [
      message(
        'msg_sig_1',
        operator.handle,
        owner,
        'Az AC-1 kártyát most senki nem viheti. Javaslom, hogy adj fejlesztő szerepet valakinek, aki ráér.',
        { createdAt: minutesAgo(50), operatorSignal: 'ops_s1', taskKey: task },
      ),
      message(
        'msg_sig_2',
        operator.handle,
        owner,
        'Az egyik munkamenet régóta dolgozik, de nem ad jelet. Megnézhetem, mi történik vele.',
        { createdAt: minutesAgo(40), operatorSignal: 'ops_s2', taskKey: task },
      ),
      message('msg_sig_4', operator.handle, owner, 'Egy munkamenet vár a válaszodra.', {
        createdAt: minutesAgo(90),
        operatorSignal: 'ops_s4',
        taskKey: task,
      }),
      message('msg_sig_5', operator.handle, owner, 'Az AC-2 kártyát senki nem viheti.', {
        createdAt: minutesAgo(120),
        operatorSignal: 'ops_s5',
        taskKey: 'AC-2',
      }),
    ];
    state.requests = [];
    state.inbox = [];
    const page = await openWith('/p/AC');
    await shoot(page, 'c-signals-button', { widths: WIDTHS, highlight: '[data-operator-button]' });
    await openPanel(page);
    await page.waitForSelector('#operator-panel article, #operator-panel [data-signal]');
    await shoot(page, 'c-signals', { widths: WIDTHS });

    // "Most ne" on a signal that was closed meanwhile: the server's 409 stays on the card.
    state.dismiss = 'closed';
    await page.getByRole('button', { name: 'Most ne' }).first().click();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'c-signal-409', { widths: WIDTHS });
    state.dismiss = 'ok';
  });

  await step_('c2. grouped owner decisions', async () => {
    const base = {
      state: 'open',
      messageId: 'msg_summary',
      subject: null,
      inboxItemId: null,
      raisedAt: minutesAgo(15),
      decidedBy: null,
      decidedAt: null,
      resolvedAt: null,
    };
    const reset = () => {
      state.readOnly = false;
      state.dismiss = 'ok';
      state.signals = [
        { ...base, id: 'ops_sum1', kind: 'nobody', taskKey: 'AC-1', actionable: true },
        {
          ...base,
          id: 'ops_sum2',
          kind: 'stalled',
          taskKey: 'AC-2',
          actionable: true,
          raisedAt: minutesAgo(12),
        },
        {
          ...base,
          id: 'ops_sum3',
          kind: 'outage',
          taskKey: null,
          actionable: false,
          inboxItemId: 'inb_outage',
        },
      ];
      state.messages = [
        message(
          'msg_summary',
          operator.handle,
          owner,
          '**Megtettem**\n\nEllenőriztem a táblát és elindítottam a szabad fejlesztőt.\n\n**Döntés kell**\n\nHárom dologhoz kell a szavad, lent soronként dönthetsz.',
        ),
      ];
    };
    reset();
    const page = await openWith('/p/AC');
    await openPanel(page);
    const card = page.locator('[data-signal-list]');
    await card.waitFor();
    await shoot(page, 'c2-summary-open', { widths: WIDTHS });
    await card.getByRole('button', { name: 'Igen, intézd' }).first().click();
    await card.getByRole('status').waitFor();
    await shoot(page, 'c2-summary-accepted', { widths: WIDTHS });
    await card.getByRole('button', { name: 'Most ne' }).first().click();
    await card.getByRole('button', { name: 'Most ne' }).last().click();
    await card.getByRole('button').waitFor({ state: 'detached' });
    await shoot(page, 'c2-summary-settled', { widths: WIDTHS });
    for (const mode of ['failed', 'closed']) {
      reset();
      state.dismiss = mode;
      const errorPage = await openWith('/p/AC');
      await openPanel(errorPage);
      await errorPage.locator('[data-signal-list]').getByRole('button', { name: 'Most ne' }).first().click();
      await errorPage.getByRole('alert').first().waitFor();
      await shoot(errorPage, `c2-summary-${mode}`, { widths: WIDTHS });
    }
    reset();
    state.readOnly = true;
    state.signals[0].state = 'accepted';
    state.signals[0].decidedAt = minutesAgo(1);
    const readPage = await openWith('/p/AC');
    await openPanel(readPage);
    await readPage.locator('[data-signal-list]').waitFor();
    await shoot(readPage, 'c2-summary-read-only', { widths: WIDTHS });
    state.readOnly = null;
    state.dismiss = 'ok';
  });

  await step_('d. Rád vár: the proposal, and a stale one', async () => {
    state.signals = [];
    state.requests = [];
    state.messages = [];
    state.inbox = [
      approvalItem('inb_op_demo1', 'ops_2', approvalPayload('ops_2')),
      approvalItem(
        'inb_op_demo2',
        'ops_4',
        approvalPayload('ops_4', {
          requestId: 'opr_demo2',
          stepId: 'ops_4',
          quote: 'Állítsd le a futó munkamenetet',
          action: 'session_stop',
          operation: { op: 'session_stop', sessionId: 'ses_demo' },
          changes: [],
          consequence: 'session_stop',
          session: { id: 'ses_demo', startedAt: minutesAgo(90) },
          stale: { reason: 'session_changed', at: minutesAgo(5) },
        }),
        { title: 'Munkamenet leállítása', createdAt: minutesAgo(15) },
      ),
    ];
    const page = await openWith('/p/AC/inbox');
    await page.getByText('Kérted:', { exact: false }).first().waitFor();
    await shoot(page, 'd-inbox-approval', { widths: WIDTHS });

    // Approving after the configuration moved on: the card turns stale in place, with no toast.
    state.resolve = 'stale';
    await page.getByRole('button', { name: 'Jóváhagyom' }).first().click();
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'd-inbox-stale-409', { widths: WIDTHS });
    state.resolve = 'ok';
  });

  await step_('e. settings history with the Operator', async () => {
    state.inbox = [];
    state.history = [
      {
        version: 'op00001',
        message: 'Szövegíró: Sonnet',
        author: operator.displayName,
        at: minutesAgo(25),
        operator: operator.handle,
        request: 'A szövegíró legyen Sonnet, mert a jelenlegi túl lassú',
        approvedBy: owner,
      },
      {
        version: 'op00002',
        message: 'Hálózat: Kutató',
        author: operator.displayName,
        at: minutesAgo(180),
        operator: operator.handle,
        request: 'Add meg a Kutatónak az internetet',
      },
    ];
    const page = await openWith('/p/AC/settings/history');
    await page.getByText('Jóváhagyta', { exact: false }).first().waitFor();
    await shoot(page, 'e-history', { widths: WIDTHS });
  });

  await step_('f. the Team page: the built-in Operator, its menu and editor', async () => {
    state.history = [];
    const page = await openWith('/p/AC/team');
    await page.getByRole('link', { name: operator.displayName }).first().waitFor();
    await shoot(page, 'f-team', { widths: WIDTHS, highlight: `a[href$="/team/${operator.handle}"]` });
    // The shot above left the page at the last width: back to the desktop one.
    await page.setViewportSize({ width: WIDTHS[0], height: 982 });
    await page.getByRole('button', { name: `További műveletek: ${operator.displayName}` }).click();
    await page.getByRole('button', { name: 'Az Operátor modelljének szerkesztése' }).waitFor();
    await shoot(page, 'f-team-menu', { widths: [WIDTHS[0]] });
    await page.getByRole('button', { name: 'Az Operátor modelljének szerkesztése' }).click();
    await page.getByRole('dialog').waitFor();
    await shoot(page, 'f-team-editor', { widths: [WIDTHS[0]] });
    // The menu closes when the page is resized, so the phone gets its own pass.
    const phone = await openWith('/p/AC/team', { width: WIDTHS[1] });
    await phone.getByRole('link', { name: operator.displayName }).first().waitFor();
    await phone.getByRole('button', { name: `További műveletek: ${operator.displayName}` }).click();
    await phone.getByRole('button', { name: 'Az Operátor modelljének szerkesztése' }).waitFor();
    await shoot(phone, 'f-team-menu', { widths: [WIDTHS[1]] });
    await phone.getByRole('button', { name: 'Az Operátor modelljének szerkesztése' }).click();
    await phone.getByRole('dialog').waitFor();
    await shoot(phone, 'f-team-editor', { widths: [WIDTHS[1]] });
  });

  await step_('g. Messages: the pm as the distributor, empty thread', async () => {
    if (!pm) return;
    const page = await openWith(`/p/AC/messages/with/${pm.handle}`);
    await page.getByText('elosztó', { exact: false }).first().waitFor();
    await shoot(page, 'g-messages-pm', { widths: WIDTHS });
  });

  await step_('h. states: the team is paused, a send fails', async () => {
    await instance.api('/api/projects/AC/pause', { method: 'POST', body: {} });
    let page = await openWith('/p/AC');
    await openPanel(page);
    await page.getByText('szünet', { exact: false }).first().waitFor();
    await shoot(page, 'h-paused', { widths: WIDTHS });
    await instance.api('/api/projects/AC/pause/resume', { method: 'POST', body: {} });

    state.sendFails = true;
    page = await openWith('/p/AC');
    await openPanel(page);
    await page.fill('#operator-panel textarea', 'Mi a helyzet?');
    await page.press('#operator-panel textarea', 'Enter');
    await page.getByRole('alert').first().waitFor();
    await shoot(page, 'h-send-failed', { widths: WIDTHS });
    state.sendFails = false;
  });

  await step_('i. a person who is not an owner', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    const danaHandle = (await instance.api('/api/me', { as: colleague })).handles.AC;
    state.requests = [
      {
        id: 'opr_dana1',
        messageId: 'msg_dana_1',
        quote: 'Állítsd át a szövegírót Sonnetre',
        openedAt: minutesAgo(10),
        closedAt: minutesAgo(9),
        steps: [
          {
            ...step('ops_d1', 'member_change', 'refused', {
              member: worker.handle,
              refusal: { code: 'operator_owner_only', message: 'Változtatást csak a tulajdonos kérhet.' },
            }),
            requestId: 'opr_dana1',
          },
        ],
      },
    ];
    state.messages = [
      message('msg_dana_1', danaHandle, operator.handle, 'Állítsd át a szövegírót Sonnetre', {
        createdAt: minutesAgo(10),
      }),
      message(
        'msg_dana_2',
        operator.handle,
        danaHandle,
        'Ezt nem tehetem meg neked, mert változtatást csak a tulajdonos kérhet. Írj neki.',
        { createdAt: minutesAgo(9), operatorRequest: 'opr_dana1' },
      ),
    ];
    state.signals = [];
    state.inbox = [];
    state.readOnly = true;
    // First use: the read-only introduction, before any request.
    const savedRequests = state.requests;
    const savedMessages = state.messages;
    state.requests = [];
    state.messages = [];
    let page = await openWith('/p/AC', { as: colleague });
    await openPanel(page);
    await shoot(page, 'i-guest-first-use', { widths: WIDTHS });
    state.requests = savedRequests;
    state.messages = savedMessages;
    page = await openWith('/p/AC', { as: colleague });
    await openPanel(page);
    await page.waitForSelector('#operator-panel [data-request]');
    await shoot(page, 'i-guest-refused', { widths: WIDTHS });
  });
};
