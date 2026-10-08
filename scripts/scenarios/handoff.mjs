/**
 * Scenario for PM-424 (docs/SCREENSHOTS.md): the assignee hand-over of PM-342 in the web app. The disposable server
 * and browser are real; the hand-over facts of AC-1 (the open handoff, the last one, its record, the timeline rows)
 * are varied only in the browser's responses (`page.route`), because the server's clock (10 minutes) and its
 * fake sessions cannot hold every step still:
 *
 *   1. the Assignee row and the toasts of a live and a fallback change
 *   2. the box in the drawer: waiting_point, writing, paused, closing after the timeout, and no receiver
 *   3. the board mark and the status line, on the board and in the drawer
 *   4. the hand-over note window: a note, a fallback with and without the summary, a failed load
 *   5. the timeline rows
 *   6. the member editor's hint
 *
 *   npm run shots -- scripts/scenarios/handoff.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const DRAWER = '/p/AC/tasks/AC-1';
const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const ai = members.filter((member) => member.kind === 'ai');
  // The old assignee owns the work stage (it can start a session); the receiver is any other AI member.
  const oldOne = ai.find((member) => member.role === 'developer');
  const newOne = ai.find((member) => member !== oldOne);
  if (!oldOne || !newOne) throw new Error('The demo team needs a developer and another AI member.');
  const sessionId = await instance.startSession('AC', 'AC-1', oldOne.handle);
  await instance.waitIdle('AC', sessionId);
  const { task: base } = await instance.api('/api/projects/AC/tasks/AC-1');

  // What the browser is told about AC-1; the steps below change it, then reload.
  const state = {
    handoff: null,
    lastHandoff: null,
    record: null,
    recordStatus: 200,
    work: false,
    assignee: base.assignee,
    timeline: [],
    start: null,
    providers: { [oldOne.handle]: 'codex', [newOne.handle]: 'claude' },
  };
  const handoffOf = (step, extra = {}) => ({
    id: 'hnd_shot',
    from: oldOne.handle,
    to: newOne.handle,
    fromProvider: 'codex',
    toProvider: 'claude',
    reason: 'manual',
    step,
    startedAt: minutes(-3),
    deadlineAt: minutes(7),
    ...extra,
  });
  const refOf = (outcome, extra = {}) => ({
    id: 'hnd_shot',
    from: oldOne.handle,
    to: newOne.handle,
    fromProvider: 'codex',
    toProvider: 'claude',
    outcome,
    endedAt: minutes(-12),
    ...extra,
  });
  const recordOf = (ref, extra = {}) => ({
    ...ref,
    reason: 'manual',
    startedAt: minutes(-15),
    note: null,
    branch: 'AC-1-checkout',
    lastCommit: null,
    uncommitted: null,
    summary: null,
    ...extra,
  });
  const reset = (patch = {}) => {
    Object.assign(
      state,
      {
        handoff: null,
        lastHandoff: null,
        record: null,
        recordStatus: 200,
        work: false,
        timeline: [],
        start: null,
      },
      patch,
    );
  };
  const overlay = (task) => ({
    ...task,
    assignee: state.assignee,
    handoff: state.handoff ?? undefined,
    lastHandoff: state.lastHandoff ?? undefined,
  });

  const page = await open({ path: '/p/AC' });

  await page.route('**/api/projects/AC/board*', async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    board.tasks = board.tasks.map((task) => (task.key === 'AC-1' ? overlay(task) : task));
    board.members = board.members.map((member) => {
      const provider = state.providers[member.handle];
      const next = provider ? { ...member, provider } : member;
      if (member.handle !== oldOne.handle || !state.work) return next;
      const since = minutes(-20);
      return { ...next, taskWork: [{ sessionId, taskKey: 'AC-1', activity: null, since }] };
    });
    await route.fulfill({ response, json: board });
  });
  await page.route('**/api/projects/AC/tasks/AC-1', async (route) => {
    if (route.request().method() === 'PATCH') {
      const body = route.request().postDataJSON() ?? {};
      if (typeof body.assignee === 'string') state.assignee = body.assignee;
      await route.fulfill({ json: { ...overlay(base), handoffStart: state.start ?? undefined } });
      return;
    }
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({
      response,
      json: {
        ...detail,
        task: overlay(detail.task),
        timeline: [...detail.timeline, ...state.timeline],
      },
    });
  });
  await page.route('**/api/projects/AC/tasks/AC-1/handoffs/*', async (route) => {
    if (state.recordStatus !== 200) {
      await route.fulfill({ status: state.recordStatus, json: { error: { code: 'shot', message: 'shot' } } });
      return;
    }
    await route.fulfill({ json: state.record });
  });

  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
  };
  const shot = (name, highlight) => shoot(page, name, { widths: WIDTHS, highlight });
  const stage = async (patch, path = DRAWER) => {
    reset(patch);
    await visit(path);
  };

  // 1. The Assignee row and the toasts.
  await step('the assignee select and the toast of a live change', async () => {
    state.assignee = oldOne.handle;
    reset({ assignee: oldOne.handle, work: true });
    await visit(DRAWER);
    const select = page.locator('select[aria-label="Felelős"]');
    await select.waitFor();
    const options = await select.locator('option').allTextContents();
    log(`assignee options: ${options.join(' | ')}`);
    await shot('assignee-row', 'select[aria-label="Felelős"]');
    state.start = { mode: 'live', from: oldOne.handle };
    state.handoff = handoffOf('waiting_point');
    await select.selectOption(newOne.handle);
    await page.waitForSelector('text=most leadja a munkát');
    await shot('toast-live', 'text=most leadja a munkát');
  });

  await step('the toast of a fallback change', async () => {
    reset({ assignee: oldOne.handle });
    await visit(DRAWER);
    const select = page.locator('select[aria-label="Felelős"]');
    await select.waitFor();
    state.start = { mode: 'fallback', from: oldOne.handle, reason: 'on_leave' };
    state.lastHandoff = refOf('fallback', { fallbackReason: 'on_leave' });
    await select.selectOption(newOne.handle);
    await page.waitForSelector('text=Leadás nélkül indul');
    await shot('toast-fallback', 'text=Leadás nélkül indul');
  });

  // 2. The box.
  const boxStates = [
    ['box-waiting', { handoff: handoffOf('waiting_point'), work: true }],
    ['box-writing', { handoff: handoffOf('writing', { deadlineAt: minutes(4) }), work: true }],
    ['box-paused', { handoff: handoffOf('paused', { deadlineAt: null }), work: true }],
    [
      'box-timeout',
      {
        handoff: handoffOf('closing', { fallbackReason: 'timeout', deadlineAt: null }),
        work: true,
      },
    ],
    ['box-no-receiver', { handoff: handoffOf('writing', { to: null, toProvider: null }), work: true }],
  ];
  for (const [name, patch] of boxStates) {
    await step(name, async () => {
      await stage({ assignee: patch.handoff.to, ...patch });
      await page.waitForSelector('text=/Átadás( folyamatban|: szünetel)/');
      await shot(name, 'section[aria-labelledby]:has-text("Átadás")');
    });
  }

  // 3. The board mark and the status line.
  await step('the board mark: running and paused', async () => {
    await stage({ assignee: newOne.handle, handoff: handoffOf('waiting_point'), work: true }, '/p/AC');
    await page.waitForSelector('text=/Átadás · /');
    await shot('board-mark', 'text=/Átadás · /');
    await stage(
      { assignee: newOne.handle, handoff: handoffOf('paused', { deadlineAt: null }), work: true },
      '/p/AC',
    );
    await page.waitForSelector('text=Átadás · szünetel');
    await shot('board-mark-paused', 'text=Átadás · szünetel');
  });

  // 4. The note window.
  const noteRef = refOf('note');
  const summary = {
    source: 'compact',
    text: 'A vásárló bejelentkezése kész, a fizetési oldal félkész: a kosár összegét még nem ellenőrzi a szerver.',
    at: minutes(-14),
  };
  const noteStates = [
    [
      'note-window',
      'Átadó jegyzet',
      {
        lastHandoff: noteRef,
        record: recordOf(noteRef, {
          note: '## Állapot\n\n- A kosár végpontja kész és tesztelt.\n- A fizetési oldal **félkész**: az összeg ellenőrzése hiányzik.\n\nA következő lépés: a `POST /orders` végpont.',
          lastCommit: 'a1b2c3d4e5f6',
          uncommitted: true,
        }),
      },
    ],
    [
      'note-fallback',
      'Átadás jegyzet nélkül',
      (() => {
        const ref = refOf('fallback', { fallbackReason: 'timeout' });
        return { lastHandoff: ref, record: recordOf(ref, { summary }) };
      })(),
    ],
    [
      'note-fallback-no-summary',
      'Átadás jegyzet nélkül',
      (() => {
        const ref = refOf('fallback', { fallbackReason: 'no_conversation' });
        return { lastHandoff: ref, record: recordOf(ref) };
      })(),
    ],
    ['note-error', 'Átadó jegyzet', { lastHandoff: noteRef, record: recordOf(noteRef), recordStatus: 500 }],
  ];
  for (const [name, button, patch] of noteStates) {
    await step(name, async () => {
      await stage({ assignee: newOne.handle, ...patch });
      await page.getByRole('button', { name: button }).click();
      await page.waitForSelector('dialog[open]');
      if (name === 'note-fallback') {
        await page.getByText('Gépi összefoglaló', { exact: true }).click();
      }
      if (name === 'note-error') await page.waitForSelector('text=Nem sikerült betölteni a jegyzetet.');
      else
        await page.waitForSelector(
          'dialog[open] :text-matches("Utolsó commit|Nem volt leadás|Összefoglaló")',
        );
      await shot(name, 'dialog[open]');
      await page.keyboard.press('Escape');
    });
  }

  // 5. The timeline.
  await step('the timeline rows', async () => {
    const at = (n) => minutes(-30 + n);
    const event = (n, type, data, actor) => ({
      id: `evt_handoff_${n}`,
      projectKey: 'AC',
      taskKey: 'AC-1',
      sessionId: null,
      actor: actor ?? { kind: 'human', handle: 'owner' },
      type,
      data,
      createdAt: at(n),
    });
    const common = {
      handoffId: 'hnd_shot',
      from: oldOne.handle,
      to: newOne.handle,
      fromProvider: 'codex',
      toProvider: 'claude',
    };
    const oldActor = { kind: 'ai', handle: oldOne.handle };
    const newActor = { kind: 'ai', handle: newOne.handle };
    const timeline = [
      event(1, 'task_handoff', { ...common, phase: 'started', reason: 'fix_limit_reassign', mode: 'live' }),
      event(2, 'task_handoff', { ...common, phase: 'retargeted', to: newOne.handle }),
      event(
        3,
        'task_handoff',
        {
          ...common,
          phase: 'note',
          note: '## Állapot\n\nA kosár kész, a fizetési oldal félkész.\n\nKövetkező lépés: a POST /orders végpont.',
          lastCommit: 'a1b2c3d4e5f6',
          uncommitted: false,
        },
        oldActor,
      ),
      event(
        4,
        'session_ended',
        { member: oldOne.handle, exitCode: 0, stop: { kind: 'handed_off', taskKey: 'AC-1' } },
        oldActor,
      ),
      event(5, 'task_handoff', { ...common, phase: 'taken_over' }, newActor),
      event(6, 'task_handoff', {
        ...common,
        phase: 'fallback',
        fallbackReason: 'timeout',
        summary: true,
      }),
      event(7, 'task_handoff', { ...common, phase: 'cancelled', to: oldOne.handle }),
      event(
        8,
        'session_conversation_restarted',
        {
          member: newOne.handle,
          reason: 'provider_changed',
          fromProvider: 'codex',
          toProvider: 'claude',
          summary: true,
        },
        newActor,
      ),
    ];
    await stage({ assignee: newOne.handle, timeline });
    await page.waitForSelector('text=Átadás indult');
    await shot('timeline', 'text=Átadás indult');
  });

  // 6. The member editor.
  await step('the member editor warns before a provider change', async () => {
    reset({ assignee: oldOne.handle });
    await visit('/p/AC/team');
    await page.getByRole('button', { name: `További műveletek: ${oldOne.displayName}` }).click();
    await page.getByRole('button', { name: `Szerkesztés: ${oldOne.displayName}` }).click();
    const provider = page.getByLabel('Szolgáltató');
    await provider.waitFor();
    const current = await provider.inputValue();
    const options = await provider.locator('option').evaluateAll((all) => all.map((o) => o.value));
    const other = options.find((value) => value && value !== current);
    if (!other) throw new Error('No other provider to choose.');
    await provider.selectOption(other);
    await shot('member-hint', 'text=Más szolgáltató nem tudja folytatni');
  });
};
