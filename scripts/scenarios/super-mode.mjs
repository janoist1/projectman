/** PM-766: deterministic DTO fixtures; no live credentials are created or photographed. */
export default async ({ instance, open, shoot, step }) => {
  const page = await open({ path: '/p/AC/settings/integrator' });
  const hu = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  let keys = [];
  let failed = false;
  let token = false;
  const at = new Date().toISOString();
  const base = {
    state: 'active',
    createdAt: at,
    expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    lastUsedAt: at,
    lastUsedChannel: null,
    revokedAt: null,
  };
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (token) body.via = 'integrator';
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/auth/integrator-keys', async (route) => {
    if (failed)
      return route.fulfill({
        status: 503,
        json: { error: { code: 'internal_error', message: 'Fixture unavailable' } },
      });
    if (route.request().method() === 'POST')
      return route.fulfill({ status: 201, json: { key: keys[0], secret: 'pmi_screenshot_example_only' } });
    return route.fulfill({ json: { keys } });
  });
  const options = { widths: [1512, 390] };
  await step('first use', async () => {
    await page.reload();
    await page.getByText(hu.integratorKey.none, { exact: true }).waitFor();
    await shoot(page, 'super-empty', options);
  });
  keys = [
    { ...base, id: 'super', mode: 'super', prefix: 'pmi_super_demo', lastUsedChannel: 'mcp' },
    { ...base, id: 'read', mode: 'read', prefix: 'pmi_read_demo' },
    { ...base, id: 'legacy', mode: 'legacy', prefix: 'pmi_legacy_demo' },
    { ...base, id: 'expired', mode: 'super', prefix: 'pmi_expired_demo', state: 'expired', expiresAt: at },
  ];
  await step('active keys and replacement', async () => {
    await page.reload();
    await page.getByText('pmi_super_demo…', { exact: true }).waitFor();
    await shoot(page, 'super-active', options);
    await shoot(page, 'super-active-legacy', {
      ...options,
      highlight: 'li:has(code:has-text("pmi_legacy_demo"))',
    });
    await page.getByRole('button', { name: hu.integratorKey.new, exact: true }).click();
    await shoot(page, 'super-create', options);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: hu.integratorKey.submit, exact: true })
      .click();
    await page.getByText('pmi_screenshot_example_only', { exact: true }).waitFor();
    await shoot(page, 'super-secret', options);
    await page.getByRole('button', { name: hu.integratorKey.done, exact: true }).click();
    await page.getByRole('button', { name: hu.integratorKey.revoke, exact: true }).first().click();
    await shoot(page, 'super-revoke', options);
    await page.keyboard.press('Escape');
  });
  await step('expiry and error', async () => {
    keys[0].expiresAt = new Date(Date.now() + 3600000).toISOString();
    await page.reload();
    await page.getByText(hu.integratorKey.today, { exact: true }).waitFor();
    await shoot(page, 'super-expiring', options);
    failed = true;
    await page.reload();
    await page.getByText(hu.integratorKey.error, { exact: true }).waitFor();
    await shoot(page, 'super-error', options);
    failed = false;
  });
  await step('token view', async () => {
    token = true;
    await page.reload();
    await page.getByText(hu.integratorKey.ownerOnly, { exact: true }).waitFor();
    await shoot(page, 'super-token-view', options);
    token = false;
  });
  await step('audit, empty and paginated', async () => {
    const audit = {
      id: 'audit_demo',
      projectKey: 'AC',
      taskKey: 'AC-1',
      prefix: 'pmi_super_demo',
      operatorMode: 'super',
      requestId: 'req_demo',
      handoffId: null,
      operation: 'member.update',
      outcome: 'unknown',
      errorCode: null,
      createdAt: at,
    };
    let populated = false;
    await page.route('**/api/projects/AC/operator-super/audit?*', (route) =>
      route.fulfill({ json: { entries: populated ? [audit] : [], nextBefore: populated ? audit.id : null } }),
    );
    await page.goto(`${new URL(page.url()).origin}/p/AC/sessions?by=super&prefix=pmi_super_demo`);
    await page.getByText(hu.superMode.empty, { exact: true }).waitFor();
    await shoot(page, 'super-audit-empty', options);
    populated = true;
    await page.reload();
    await page.getByRole('button', { name: hu.superMode.more, exact: true }).waitFor();
    await shoot(page, 'super-audit-page', options);
  });
  await step('timeline and configuration history', async () => {
    const actor = {
      kind: 'ai',
      handle: 'operator',
      via: 'integrator',
      operatorMode: 'super',
      credential: { id: 'demo', prefix: 'pmi_super_demo' },
    };
    const command = {
      kind: 'merge_order',
      repo: 'webshop',
      taskKeys: [],
      expectedRevision: 0,
      reason: 'Queue maintenance',
    };
    const handoff = {
      id: 'handoff_demo',
      projectKey: 'AC',
      taskKey: 'AC-1',
      requestedBy: { kind: 'ai', handle: 'operator' },
      reason: 'Queue maintenance',
      command,
      expectedConfigVersion: null,
      state: 'pending',
      operationId: 'operation_demo',
      createdAt: at,
      updatedAt: at,
    };
    await page.route('**/api/projects/AC/operator-super/handoffs/handoff_demo', (route) =>
      route.fulfill({ json: { handoff } }),
    );
    await page.route('**/api/projects/AC/operator-super/handoffs?*', (route) =>
      route.fulfill({ json: { handoffs: [handoff] } }),
    );
    await page.route('**/api/projects/AC/operator-super/operations/operation_demo', (route) =>
      route.fulfill({
        json: {
          operation: {
            id: 'operation_demo',
            projectKey: 'AC',
            taskKey: 'AC-1',
            handoffId: handoff.id,
            state: 'succeeded',
            requestId: '00000000-0000-4000-8000-000000000000',
            command,
            ownerQuestionId: null,
            errorCode: null,
            createdAt: at,
            updatedAt: at,
          },
          result: null,
        },
      }),
    );
    await page.route('**/api/projects/AC/tasks/AC-1', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const event = { projectKey: 'AC', taskKey: 'AC-1', sessionId: null, createdAt: at };
      body.timeline = [
        {
          ...event,
          id: 'handoff_event',
          actor: handoff.requestedBy,
          type: 'super_handoff_changed',
          data: { handoffId: handoff.id, state: 'pending' },
        },
        {
          ...event,
          id: 'operation_event',
          actor,
          type: 'super_operation_changed',
          data: { operationId: 'operation_demo', state: 'succeeded', resultKind: null },
        },
        {
          ...event,
          id: 'legacy_event',
          actor: { kind: 'human', handle: 'owner', via: 'integrator' },
          type: 'task_note',
          data: { text: 'Historical record' },
        },
      ];
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${new URL(page.url()).origin}/p/AC/tasks/AC-1/timeline`);
    await page.getByRole('button', { name: hu.integratorKey.prefix, exact: true }).first().click();
    await page.getByText('pmi_super_demo…', { exact: true }).first().waitFor();
    await page.locator('#timeline-handoff_event').scrollIntoViewIfNeeded();
    await shoot(page, 'super-timeline', options);
    await page.route('**/api/projects/AC/config', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.history = [{ version: body.version, at, author: 'operator', message: 'Queue maintenance', actor }];
      await route.fulfill({ response, json: body });
    });
    await page.goto(`${new URL(page.url()).origin}/p/AC/settings/history`);
    await page.getByText('pmi_super_demo…', { exact: true }).waitFor();
    await shoot(page, 'super-history', options);
  });
};
