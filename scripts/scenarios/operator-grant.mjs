/** PM-891: deterministic grant, handoff and command DTOs; no real machine command runs. */
export default async ({ open, shoot, step }) => {
  const page = await open({ path: '/p/AC/settings/integrator' });
  const hu = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const at = new Date().toISOString();
  const options = { widths: [1512, 390] };
  const origin = new URL(page.url()).origin;
  let grant = {
    active: false,
    grantId: null,
    grantedAt: null,
    grantedBy: null,
    expiresAt: null,
    lastUsedAt: null,
    canManage: true,
  };
  let audits = [];
  let keys = [];
  let token = false;
  let grantFailure = false;
  let commandState = 'ready';
  let items = [];
  const key = {
    id: 'demo-key',
    mode: 'super',
    prefix: 'pmi_demo',
    state: 'active',
    createdAt: at,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedChannel: null,
  };
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (token) body.via = 'integrator';
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/auth/operator-grant', (route) =>
    grantFailure
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'internal_error', message: 'Fixture unavailable' } },
        })
      : route.fulfill({ json: { grant } }),
  );
  await page.route('**/api/auth/operator-grant/audit', (route) =>
    route.fulfill({ json: { entries: audits } }),
  );
  await page.route('**/api/auth/integrator-keys', (route) => route.fulfill({ json: { keys } }));
  await page.route('**/api/auth/integrator-keys/audit*', (route) =>
    route.fulfill({ json: { entries: [], nextBefore: null } }),
  );
  await page.route('**/api/projects/AC/inbox?*', (route) => route.fulfill({ json: { items } }));
  const reload = async (path) => {
    await page.goto(`${origin}${path}`);
  };
  await step('grant settings and confirmations', async () => {
    await page.reload();
    await page.getByText(hu.operatorGrant.inactive, { exact: true }).waitFor();
    await shoot(page, 'grant-first-use', options);
    await page.getByRole('button', { name: hu.operatorGrant.grant, exact: true }).click();
    await shoot(page, 'grant-confirm', options);
    await page.keyboard.press('Escape');
    keys = [key];
    await page.reload();
    await page.getByText(hu.operatorGrant.clientInactive).waitFor();
    await shoot(page, 'grant-absent-key-present', options);
    grant = {
      ...grant,
      active: true,
      grantId: 'grant-demo',
      grantedAt: at,
      grantedBy: 'Owner',
      expiresAt: new Date(new Date().setHours(23, 59, 59, 999)).toISOString(),
    };
    await page.reload();
    await page.getByRole('button', { name: hu.operatorGrant.extend }).waitFor();
    await shoot(page, 'grant-expiring', options);
    await page.getByText(hu.operatorGrant.capabilities, { exact: true }).click();
    await shoot(page, 'grant-capabilities', options);
    await page.getByText(hu.operatorGrant.capabilities, { exact: true }).click();
    await page.getByRole('button', { name: hu.operatorGrant.extend }).click();
    await shoot(page, 'grant-extend', options);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: hu.operatorGrant.revoke, exact: true }).click();
    await shoot(page, 'grant-revoke', options);
    await page.keyboard.press('Escape');
    grant.canManage = false;
    token = true;
    await page.reload();
    await page.getByText(hu.operatorGrant.ownerOnly).waitFor();
    await shoot(page, 'grant-own-login-required', options);
    token = false;
    grant.canManage = true;
    grantFailure = true;
    await page.reload();
    await page.getByText(hu.operatorGrant.error, { exact: true }).waitFor();
    await shoot(page, 'grant-load-error', options);
    grantFailure = false;
    grant.active = false;
    audits = [
      { grantId: 'old', action: 'expired', at, expiresAt: at, by: 'Owner' },
      { grantId: 'new', action: 'granted', at, expiresAt: null, by: 'Owner' },
      { grantId: 'older', action: 'replaced', at, expiresAt: at, by: 'Owner' },
    ];
    await page.reload();
    await page.getByText(hu.operatorGrant.auditExpired, { exact: false }).waitFor();
    await shoot(page, 'grant-expired-audit', {
      ...options,
      highlight: 'h3:has-text("' + hu.operatorGrant.audit + '")',
    });
  });
  const item = (id, title, payload, choices) => ({
    id,
    projectKey: 'AC',
    kind: 'question',
    assignees: ['owner'],
    source: 'system',
    taskKey: 'AC-1',
    sessionId: null,
    title,
    body: null,
    payload: { question: title, ...payload },
    options: choices,
    state: 'open',
    resolution: null,
    createdAt: at,
  });
  await step('all handoff reasons with and without a grant', async () => {
    items = ['owner_reserved', 'no_typed_operation', 'no_grant', 'processing_failed'].map((reason, i) =>
      item(
        `handoff-${i}`,
        hu.inbox.handedOff.reasons[reason],
        {
          operatorHandoff: {
            queueItemId: `q-${i}`,
            reason,
            action: hu.operatorGrant.operations[['deploy', 'status', 'restart', 'process_cleanup'][i]],
            detail: hu.inbox.handedOff.reasons[reason],
            operationId: null,
          },
        },
        [
          { id: 'todo_done', label: 'Done', style: 'primary' },
          { id: 'todo_cannot', label: 'Cannot', style: 'secondary' },
        ],
      ),
    );
    await reload('/p/AC/inbox');
    await page.getByRole('link', { name: hu.inbox.handedOff.grant }).waitFor();
    await shoot(page, 'handoffs-no-grant', options);
    await shoot(page, 'handoffs-no-grant-lower', { ...options, highlight: '#inbox-item-handoff-3' });
    grant.active = true;
    grant.expiresAt = null;
    await page.reload();
    await page.getByText(hu.inbox.handedOff.nowGranted).waitFor();
    await shoot(page, 'handoffs-granted', options);
    await shoot(page, 'handoffs-granted-lower', { ...options, highlight: '#inbox-item-handoff-3' });
  });
  const operation = {
    id: 'command-demo',
    projectKey: 'AC',
    taskKey: 'AC-1',
    handoffId: null,
    state: 'waiting_owner',
    requestId: '00000000-0000-4000-8000-000000000000',
    ownerQuestionId: 'command-question',
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    command: {
      kind: 'administration',
      request: {
        kind: 'owner_command',
        target: { kind: 'hub' },
        command: 'git status --short\nprintf "%s" "review only"',
        cwd: '/work/projectman',
        timeoutSeconds: 120,
        reason: hu.operatorGrant.operations.status,
      },
    },
  };
  await page.route('**/api/projects/AC/operator-super/operations/command-demo', async (route) => {
    if (commandState === 'loading') return;
    if (commandState === 'error')
      return route.fulfill({
        status: 503,
        json: { error: { code: 'internal_error', message: 'Fixture unavailable' } },
      });
    await route.fulfill({
      json: {
        operation,
        result:
          commandState === 'result'
            ? {
                kind: 'owner_command',
                exitCode: 1,
                signal: null,
                stdout: 'M apps/web/src/i18n/hu.ts',
                stderr: 'Example diagnostic output',
                durationMs: 2500,
                truncated: true,
              }
            : null,
      },
    });
  });
  await step('command approval states', async () => {
    items = [
      item(
        'command-question',
        hu.ownerCommand.title,
        {
          superOperation: {
            operationId: operation.id,
            commandHash: 'hash',
            expectedConfigVersion: null,
            expiresAt: new Date(Date.now() + 600000).toISOString(),
          },
        },
        [
          { id: 'yes', label: hu.ownerCommand.yes, style: 'primary' },
          { id: 'no', label: hu.ownerCommand.no, style: 'danger' },
        ],
      ),
    ];
    await page.reload();
    await page.getByRole('button', { name: hu.ownerCommand.yes }).waitFor();
    await shoot(page, 'command-granted', options);
    grant.active = false;
    await page.reload();
    await page.getByText(hu.ownerCommand.noGrant).waitFor();
    await shoot(page, 'command-no-grant', options);
    commandState = 'loading';
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('status', { name: hu.ownerCommand.command }).waitFor();
    await shoot(page, 'command-loading', options);
    commandState = 'error';
    await page.reload();
    await page.getByRole('alert').filter({ hasText: hu.ownerCommand.error }).waitFor();
    await shoot(page, 'command-error', options);
  });
  await step('command result with truncated output', async () => {
    commandState = 'result';
    operation.state = 'failed';
    await page.route('**/api/projects/AC/tasks/AC-1', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      body.timeline = [
        {
          id: 'command-event',
          projectKey: 'AC',
          taskKey: 'AC-1',
          sessionId: null,
          actor: {
            kind: 'ai',
            handle: 'operator',
            via: 'integrator',
            operatorMode: 'super',
            credential: { id: 'demo', prefix: 'operator-app' },
          },
          type: 'super_operation_changed',
          data: { operationId: operation.id, state: 'failed' },
          createdAt: at,
        },
      ];
      await route.fulfill({ response, json: body });
    });
    await reload('/p/AC/tasks/AC-1/timeline');
    await page.getByText(hu.ownerCommand.truncated).waitFor();
    await page.getByText(hu.ownerCommand.stdout, { exact: true }).click();
    await page.getByText(hu.ownerCommand.stderr, { exact: true }).click();
    await shoot(page, 'command-result', options);
  });
};
