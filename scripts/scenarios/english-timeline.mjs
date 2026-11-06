/**
 * PM-1180: the card timeline, the session view, the "How we work" page, a member's context page and the
 * Involvements list in English; the same timeline once in Hungarian, to show that text did not change.
 *
 *   npm run shots -- scripts/scenarios/english-timeline.mjs --widths 1512,390
 *
 * The owner's language is set through the API. The timeline rows that need a payload of their own are added to
 * the card's response in the browser (the pattern of `involvements.mjs`): a note and a message stay as written.
 */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const developer = config.team.members.find((m) => m.kind === 'ai' && m.role === 'developer');
  const owner = config.team.members.find((m) => m.kind === 'human' && m.access === 'owner');
  const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
  await instance.waitIdle('AC', sessionId);
  const detail = await instance.api('/api/projects/AC/tasks/AC-1');
  const stages = config.pipeline.stages;
  const labels = config.pipeline.labels;
  const at = (n) => new Date(Date.now() - (40 - n) * 60_000).toISOString();
  const human = { kind: 'human', handle: owner.handle };
  const system = { kind: 'system', handle: null };
  const ai = { kind: 'ai', handle: developer.handle };
  const row = (n, type, data, actor = system) => ({
    id: `evt_en_${n}`,
    projectKey: 'AC',
    taskKey: 'AC-1',
    sessionId: null,
    actor,
    type,
    data,
    createdAt: at(n),
  });
  const events = [
    row(1, 'task_labels_changed', { added: [labels[0].id], removed: [], reason: 'refinement' }, human),
    row(2, 'task_stage_changed', { from: stages[0].id, to: stages[1].id }, human),
    row(3, 'refinement_turn', { reason: 'started', label: labels[0].id, member: developer.handle }, ai),
    row(4, 'acceptance_item_changed', { change: 'added', text: 'Works on mobile', taskKey: 'AC-1' }, human),
    row(
      5,
      'question_asked',
      { question: 'Melyik színű legyen a gomb?', screening: true, inboxItemId: 'x' },
      ai,
    ),
    row(
      6,
      'task_handoff',
      { phase: 'note', from: developer.handle, to: owner.handle, note: 'Átadom, a tesztek zöldek.' },
      ai,
    ),
    row(7, 'task_loop', { phase: 'escalated', reason: 'continued', deciders: [owner.handle] }),
    row(8, 'task_fix_limit', { phase: 'passed_on', deciders: [owner.handle] }),
    row(
      9,
      'task_fix_limit',
      { phase: 'decided', decision: 'another_round', extraRounds: 2, note: 'Még egy kör.' },
      human,
    ),
    row(10, 'task_check_changed', { check: 'qa', to: 'retest_needed' }),
    row(11, 'task_note', { text: 'Ez egy megjegyzés magyarul.' }, human),
    row(12, 'obligation_woken', { kind: 'merge', responsible: developer.handle, minutes: 30 }),
    row(13, 'team_paused', { scope: 'instance', reason: 'deploy', source: 'system' }),
    row(14, 'session_ended', { stop: { kind: 'idle', idleMinutes: 1 }, exitCode: 0 }),
  ];
  const withEvents = (page) =>
    page.route('**/api/projects/AC/tasks/AC-1', (route) =>
      route.fulfill({ json: { ...detail, timeline: [...detail.timeline, ...events] } }),
    );
  const showCard = async (name) => {
    const page = await open({ path: '/p/AC/tasks/AC-1/steps' });
    await page.evaluate(() => window.localStorage.setItem('pm:cardStory.view', 'all'));
    await withEvents(page);
    await page.reload();
    await shoot(page, name, { widths: WIDTHS, fullPage: true });
    // The drawer scrolls and the shot height is fixed: a second image with the rows that were below the fold.
    for (const [index, id] of ['evt_en_8', 'evt_en_14'].entries()) {
      await page.locator(`[id="timeline-${id}"]`).scrollIntoViewIfNeeded();
      await shoot(page, `${name}-more${index + 1}`, { widths: WIDTHS });
    }
  };

  await step('hungarian timeline, unchanged', async () => {
    await showCard('timeline-hu');
  });

  await instance.api('/api/auth/language', { method: 'PUT', body: { language: 'en' } });

  await step('english card timeline', async () => {
    await showCard('timeline-en');
  });
  await step('english session, with the closed state', async () => {
    await instance.api(`/api/projects/AC/sessions/${sessionId}/stop`, { method: 'POST', body: {} });
    const page = await open({ path: `/p/AC/sessions/${sessionId}` });
    await shoot(page, 'session-en', { widths: WIDTHS });
  });
  await step('how we work', async () => {
    const page = await open({ path: '/p/AC/how-we-work' });
    await shoot(page, 'how-we-work-en', { widths: WIDTHS, fullPage: true });
  });
  await step('a member context page', async () => {
    const page = await open({ path: `/p/AC/team/${developer.handle}/context` });
    await shoot(page, 'member-context-en', { widths: WIDTHS });
  });
  await step('involvements', async () => {
    const page = await open({ path: '/p/AC/sessions' });
    await shoot(page, 'involvements-en', { widths: WIDTHS });
  });
  await step('how we work, with a rule panel open', async () => {
    const page = await open({ path: '/p/AC/how-we-work' });
    await page
      .getByRole('button', { name: /Code review/ })
      .first()
      .click();
    await shoot(page, 'how-we-work-panel-en', { widths: WIDTHS });
  });
  await step('the handoff box on the card', async () => {
    const providers = { from: 'codex', to: 'claude' };
    const handoff = {
      id: 'hnd_shot',
      from: developer.handle,
      to: owner.handle,
      fromProvider: providers.from,
      toProvider: providers.to,
      reason: 'manual',
      step: 'waiting_point',
      startedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      deadlineAt: new Date(Date.now() + 7 * 60_000).toISOString(),
    };
    const page = await open({ path: '/p/AC/tasks/AC-1' });
    await page.route('**/api/projects/AC/tasks/AC-1', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, task: { ...body.task, handoff } } });
    });
    await page.reload();
    await shoot(page, 'handoff-box-en', { widths: WIDTHS });
  });
  await step('the pause confirmation, bar and details', async () => {
    const page = await open({ path: '/p/AC' });
    await page
      .getByRole('button', { name: /^Account/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Pause the team' }).click();
    await page.getByText('Pause the team?').waitFor();
    await shoot(page, 'pause-confirm-en', { widths: WIDTHS });
    await page.getByRole('button', { name: 'Pause', exact: true }).last().click();
    await page
      .getByText(/The team is (paused|stopping)/)
      .first()
      .waitFor();
    // A shot resizes the window: look at the bar and its details once per width, on a fresh page.
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width > 800 ? 982 : 844 });
      await page.reload();
      await page.getByText('The team is paused').first().waitFor();
      await shoot(page, `pause-bar-en-${width}`, { widths: [width] });
      await page
        .getByRole('button', { name: /details/i })
        .first()
        .click();
      await shoot(page, `pause-details-en-${width}`, { widths: [width] });
    }
    await instance.api('/api/projects/AC/pause/resume', { method: 'POST', body: {} });
  });
};
