/** PM-891 review: the Operator's sender in both the board row and drawer heading. */
export default async ({ open, shoot, step }) => {
  const page = await open({ path: '/p/AC' });
  const origin = new URL(page.url()).origin;
  const hu = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const at = new Date().toISOString();
  const operation = {
    id: 'status-command',
    projectKey: 'AC',
    taskKey: 'AC-1',
    handoffId: null,
    state: 'waiting_owner',
    requestId: '00000000-0000-4000-8000-000000000000',
    ownerQuestionId: 'operator-question',
    errorCode: null,
    createdAt: at,
    updatedAt: at,
    command: {
      kind: 'administration',
      request: {
        kind: 'owner_command',
        target: { kind: 'hub' },
        command: 'git status --short',
        timeoutSeconds: 120,
        reason: hu.operatorGrant.operations.status,
      },
    },
  };
  let item;
  await page.route('**/api/projects/AC/inbox?*', (route) => route.fulfill({ json: { items: [item] } }));
  await page.route('**/api/projects/AC/board', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.openInboxCount = 1;
    await route.fulfill({ response, json: body });
  });
  await page.route('**/api/projects/AC/operator-super/operations/status-command', (route) =>
    route.fulfill({ json: { operation, result: null } }),
  );
  for (const kind of ['command', 'handoff'])
    await step(kind, async () => {
      item = {
        id: 'operator-question',
        projectKey: 'AC',
        taskKey: 'AC-1',
        kind: 'question',
        assignees: ['owner'],
        source: 'system',
        sessionId: null,
        title: hu.ownerCommand.title,
        body: null,
        state: 'open',
        resolution: null,
        createdAt: at,
        payload: {
          question: hu.ownerCommand.title,
          ...(kind === 'command'
            ? {
                superOperation: {
                  operationId: operation.id,
                  commandHash: 'hash',
                  expectedConfigVersion: null,
                  expiresAt: new Date(Date.now() + 600000).toISOString(),
                },
              }
            : {
                operatorHandoff: {
                  queueItemId: 'queue',
                  reason: 'processing_failed',
                  action: hu.operatorGrant.operations.status,
                  detail: null,
                  operationId: null,
                },
              }),
        },
        options:
          kind === 'command'
            ? [
                { id: 'yes', label: hu.ownerCommand.yes, style: 'primary' },
                { id: 'no', label: hu.ownerCommand.no, style: 'danger' },
              ]
            : [
                { id: 'todo_done', label: hu.inbox.options.todo_done, style: 'primary' },
                { id: 'todo_cannot', label: hu.inbox.handedOff.cannot, style: 'secondary' },
              ],
      };
      await page.goto(`${origin}/p/AC`);
      await page
        .getByText(/Operátor kérdezett/)
        .first()
        .waitFor();
      await shoot(page, `review3-${kind}-board`, {
        widths: [1512, 390],
        highlight: 'a[data-phase]:has-text("AC-1")',
      });
      await page.goto(`${origin}/p/AC/tasks/AC-1`);
      await page
        .getByText(/Operátor kérdezett/)
        .last()
        .waitFor();
      await shoot(page, `review3-${kind}-drawer`, { widths: [1512, 390] });
    });
};
