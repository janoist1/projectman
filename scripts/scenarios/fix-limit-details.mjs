import { hu } from '../../apps/web/src/i18n/hu.ts';

// API fixtures exercise rendering without changing the disposable instance's decision rules.
export default async ({ instance, open, shoot, step }) => {
  const text = {
    title: hu.inbox.fixLimit.subject,
    options: { label: hu.inbox.options, consequence: hu.inbox.fixLimit.consequence },
  };
  const board = await instance.api('/api/projects/AC/board');
  const task = board.tasks.find((task) => task.assignee) ?? board.tasks[0];
  const owner = board.members.find((member) => member.kind === 'human').handle;
  const lead =
    board.members.find((member) => member.role === 'lead_developer') ??
    board.members.find((member) => member.kind === 'ai');
  const at = new Date().toISOString();
  const actor = { kind: 'ai', handle: lead.handle };
  const base = {
    taskKey: task.key,
    rounds: 6,
    limit: 6,
    changeRequests: 2,
    designChangeRequests: 1,
    sendBacks: 3,
    testsFailed: 2,
    extraRounds: 3,
    extraRoundLimit: 3,
    remainingExtraRounds: 0,
    reason: 'extra_exhausted',
    decider: null,
    note: null,
  };
  const history = [
    { eventId: 'code', at, actor, kind: 'code_review', round: 1, note: 'Validate the input before saving.' },
    {
      eventId: 'design',
      at,
      actor,
      kind: 'design_review',
      round: 2,
      note: 'Keep the explanation visible on mobile.',
    },
    {
      eventId: 'technical',
      at,
      actor,
      kind: 'branch_moved',
      round: null,
      note: null,
      pinned: 'aaaaaaaa',
      head: 'bbbbbbbb',
    },
    { eventId: 'test', at, actor, kind: 'tests_failed', round: 3, note: null, command: 'npm run merge-test' },
    {
      eventId: 'grant-1',
      at,
      actor,
      kind: 'extra_round',
      round: null,
      note: 'The remaining fix is small.',
      extraRound: 1,
    },
    { eventId: 'manual', at, actor, kind: 'send_back', round: 4, note: 'Keep the original error message.' },
    {
      eventId: 'grant-2',
      at,
      actor,
      kind: 'extra_round',
      round: null,
      note: 'Only the error message remains.',
      extraRound: 2,
    },
    {
      eventId: 'test-2',
      at,
      actor,
      kind: 'tests_failed',
      round: 5,
      note: null,
      command: 'npm run merge-test',
    },
    {
      eventId: 'grant-3',
      at,
      actor,
      kind: 'extra_round',
      round: null,
      note: 'Finish the validation.',
      extraRound: 3,
    },
    {
      eventId: 'code-2',
      at,
      actor,
      kind: 'code_review',
      round: 6,
      note: 'The invalid input still reaches storage.',
    },
  ];
  const assessment = {
    recurrence: 'Input validation keeps failing.',
    currentState: 'The view is ready; the validation needs a clearer plan.',
    recommendation: { optionId: 'replan', reason: 'Clarify validation before the next round.' },
  };
  const cases = [
    ['a-exhausted', { history }],
    ['b-assessment', { history, reason: 'passed_on', decider: lead.handle, assessment }],
    ['c-history-open', { history, reason: 'passed_on', decider: lead.handle, assessment }, 'expand'],
    [
      'd-no-lead',
      {
        history: history.slice(0, 4),
        rounds: 3,
        limit: 3,
        changeRequests: 1,
        sendBacks: 1,
        testsFailed: 1,
        extraRounds: 0,
        remainingExtraRounds: 3,
        reason: 'no_ai_decider',
      },
    ],
    ['e-integrator-group', { history }, 'integrator'],
    [
      'f-legacy',
      {
        reason: 'again',
        history: undefined,
        extraRounds: undefined,
        testsFailed: undefined,
        remainingExtraRounds: undefined,
        extraRoundLimit: undefined,
      },
    ],
    ['h-error', { history }, 'error'],
    [
      'j-four-extras',
      {
        history: [
          ...history,
          {
            eventId: 'fourth',
            at,
            actor,
            kind: 'extra_round',
            round: null,
            note: 'One last correction.',
            extraRound: 4,
          },
          {
            eventId: 'code-3',
            at,
            actor,
            kind: 'code_review',
            round: 7,
            note: 'The validation is still incomplete.',
          },
        ],
        extraRounds: 4,
        rounds: 7,
        limit: 7,
        changeRequests: 3,
      },
    ],
    [
      'k-unavailable-recommendation',
      { history, assessment, decider: lead.handle, reason: 'passed_on' },
      'unavailable',
    ],
  ];
  for (const [name, patch, mode] of cases)
    await step(name, async () => {
      const fixLimit = { ...base, ...patch };
      const options = ['replan', 'reassign', 'another_round']
        .filter((id) => mode !== 'unavailable' || id === 'another_round')
        .map((id) => ({
          id,
          label: text.options.label[id],
          consequence: text.options.consequence[id],
          style: 'secondary',
        }));
      const item = {
        id: 'fix-limit-shot',
        projectKey: 'AC',
        kind: 'decision',
        assignees: [owner],
        source: 'system',
        sessionId: null,
        taskKey: task.key,
        title: text.title.replace('{key}', task.key),
        body: null,
        payload: {
          fixLimit,
          ...(mode === 'integrator' ? { recipient: 'integrator', integratorOpenedAt: at } : {}),
        },
        options,
        state: 'open',
        resolution: null,
        createdAt: at,
      };
      const page = await open({ path: '/p/AC/inbox' });
      await page.route(/\/api\/projects\/AC\/inbox(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [item] } }),
      );
      if (mode === 'error')
        await page.route('**/api/projects/AC/inbox/*/resolve', (route) =>
          route.fulfill({ status: 500, json: { error: 'internal_error' } }),
        );
      await page.reload();
      await page
        .locator('article')
        .first()
        .waitFor({ state: mode === 'integrator' ? 'attached' : 'visible' });
      if (mode === 'integrator')
        await page.locator('summary').filter({ hasText: 'Az integrátornak' }).click();
      if (mode === 'expand') await page.locator('summary').filter({ hasText: 'Körök (' }).click();
      if (mode === 'error') {
        await page.getByRole('button', { name: text.options.label.another_round, exact: true }).click();
        await page.getByRole('alert').waitFor();
      }
      await shoot(page, name, { widths: [1512, 390] });
      for (const width of [1512, 390]) {
        await page.setViewportSize({ width, height: width === 1512 ? 982 : 844 });
        await page
          .getByRole('button', { name: text.options.label.another_round, exact: true })
          .scrollIntoViewIfNeeded();
        await shoot(page, `${name}-actions`, { widths: [width] });
      }
      await page.close();
    });
  for (const used of [3, 4])
    await step(`g-signal-${used}`, async () => {
      const page = await open({ path: `/p/AC/tasks/${task.key}` });
      const held = {
        ...base,
        extraRounds: used,
        rounds: 3 + used,
        limit: 3 + used,
        changeRequests: used - 1,
        phase: 'owner',
        recipient: 'integrator',
        deciders: [owner],
        heldAt: at,
      };
      await page.route(`**/api/projects/AC/tasks/${task.key}`, async (route) => {
        const response = await route.fetch();
        const detail = await response.json();
        detail.task.fixLimit = held;
        delete detail.task.startWaiting;
        detail.task.stageId = board.stages.find((stage) => stage.kind === 'work').id;
        detail.wait = {
          reason: 'fix_limit',
          next: [],
          toStageId: null,
          labels: [],
          inboxItemId: null,
          inboxKind: null,
          startWaiting: null,
          prerequisites: [],
          since: at,
        };
        detail.fixRounds = { rounds: held.rounds, limit: held.limit };
        detail.timeline.push({
          id: 'technical-shot',
          projectKey: 'AC',
          taskKey: task.key,
          sessionId: null,
          actor: { kind: 'system', handle: null },
          type: 'task_stage_changed',
          data: {
            from: task.stageId,
            to: task.stageId,
            branchMoved: { branch: 'task', pinned: 'aaaaaaaa', head: 'bbbbbbbb' },
          },
          createdAt: at,
        });
        await route.fulfill({ response, json: detail });
      });
      await page.route('**/api/projects/AC/board', async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        const card = data.tasks.find((card) => card.key === task.key);
        card.fixLimit = held;
        delete card.startWaiting;
        card.stageId = board.stages.find((stage) => stage.kind === 'work').id;
        await route.fulfill({ response, json: data });
      });
      await page.route(/\/api\/projects\/AC\/inbox(?:\?.*)?$/, (route) =>
        route.fulfill({ json: { items: [] } }),
      );
      await page.reload();
      await page.locator('h3').filter({ hasText: 'Megállt a javítási körök határánál' }).waitFor();
      await shoot(page, `g-signal-${used}`, { widths: [1512, 390] });
      if (used === 3) {
        await page.getByRole('button', { name: hu.task.view.timeline, exact: true }).click();
        await page.getByText(hu.fixLimit.events.notCounted, { exact: false }).waitFor();
        await shoot(page, 'g-technical-timeline', { widths: [1512, 390] });
      }
      await page.close();
    });
};
