/**
 * Scenario for PM-453 (docs/SCREENSHOTS.md): the merge on the screen. The merge states of cards that wait for the
 * release are laid over the real server's answers (the way `handoff.mjs` does), so every state is shot without
 * a real git merge. It shoots, at 1512 and 390 px:
 *
 *   a. the board: one card in each merge state (the "Rád vár" lines and the merge steps)
 *   b. the drawer of each state: requested (AI merger), requested (the viewer, as the inbox card), queued,
 *      running, failed on a conflict, failed on the check, blocked, merged, a conflict being fixed (PM-471),
 *      merged after a fixed conflict (the "Ütközés javítva" fold)
 *   c. the drawer's move panel refused for want of the merge
 *   d. the inbox: the merge request, the request after a conflict and the alert of a stopped merge
 *   e. the settings: who merges, the merge requirement of a repository, and "no one can merge" as a field error
 *
 *   npm run shots -- scripts/scenarios/merge.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: task.merge, inbox, settings.team.merger).
const TEXT = {
  why: 'Miért áll?',
  conflictInbox: 'Nem sikerült beolvasztani: ',
  queued: 'Beolvasztás: sorra vár',
  conflict: 'Nem sikerült beolvasztani: ütközés',
  checkFailed: 'Nem sikerült beolvasztani: elbukott az ellenőrzés',
  blocked: 'A beolvasztás elakadt',
  refused: 'Még nincs beolvasztva',
  mergeInbox: 'Beolvasztás: ',
  mergerGroup: 'Beolvasztó',
  mergerLabel: 'Ki olvasztja be',
  moveOpen: 'Áthelyezés',
  moveTarget: 'Áthelyezés lépésbe',
  moveSubmit: 'Áthelyez',
};
const WIDTHS = [1512, 390];
const REPO = 'webshop';
const BASE = 'main';
const hex = (seed) => seed.repeat(40).slice(0, 40);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const members = config.team.members;
  const owner = members.find((member) => member.kind === 'human').handle;
  const reviewer = members.find((member) => member.role === 'code_review')?.handle;
  if (!reviewer) throw new Error('The demo project needs a code review member.');
  const stages = config.pipeline.stages;
  const target = stages.find((stage) => stage.kind === 'release');
  const before = stages[stages.indexOf(target) - 1];
  if (!target || !before) throw new Error('The demo pipeline needs a stage in front of the release.');
  log(`${before.id} -> ${target.id}; the owner ${owner}, the code reviewer ${reviewer}`);

  const card = async (title) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, repo: REPO, description: 'Fictional Acme webshop demo task.', labels: [] },
      })
    ).key;

  const mergeOf = (key, patch) => ({
    id: `merge-${key}`,
    repo: REPO,
    base: BASE,
    toStageId: target.id,
    merger: owner,
    requestedAt: ago(40),
    state: 'requested',
    landed: 'nowhere',
    commit: hex('a1b2c3'),
    branch: `${key}-work`,
    ...patch,
  });
  const conflict = {
    reason: 'conflict',
    at: ago(8),
    base: hex('9f8e7d'),
    files: ['src/cart/totals.ts', 'src/checkout/summary.tsx'],
  };
  const checkFailed = {
    reason: 'check_failed',
    at: ago(8),
    base: hex('9f8e7d'),
    command: 'npm test',
    outputTail:
      'FAIL src/cart/totals.test.ts\n  ● totals › adds the shipping fee\n    expected 1290\n    received 1190\n\nTests: 1 failed, 41 passed',
  };
  const blocked = {
    reason: 'push_rejected',
    message: 'The push to the remote was rejected.',
    at: ago(6),
    detail: '! [rejected] main -> main (fetch first)',
  };
  const merged = {
    via: 'tool',
    mergeCommit: hex('c0ffee'),
    commit: hex('a1b2c3'),
    repo: REPO,
    base: BASE,
    at: ago(3),
    by: owner,
    check: { command: 'npm test', status: 'passed' },
    pushed: { remote: 'origin', commitUrl: 'https://github.com/acme/webshop/commit/c0ffee' },
    pullRequests: [{ number: 11, url: 'https://github.com/acme/webshop/pull/11' }],
  };

  // The cards, one in each state: `overlay` is laid over the task, `events` over its timeline.
  const specs = {
    requestedAi: { title: 'Add tiered shipping rates' },
    requestedYou: { title: 'Show delivery estimates' },
    queued: { title: 'Add a wish list' },
    running: { title: 'Save the cart for later' },
    conflict: { title: 'Round the order totals' },
    checkFailed: { title: 'Validate the postcode' },
    blocked: { title: 'Send the order confirmation e-mail' },
    merged: { title: 'Show the gift wrap option' },
    fixing: { title: 'Total the gift wrap fee' },
    fixed: { title: 'Show the shipping countdown' },
  };
  for (const spec of Object.values(specs)) spec.key = await card(spec.title);
  const inbox = [];
  const events = {};
  const overlays = {};
  const requestedEvent = (key, merge) => ({
    type: 'task_merge_requested',
    data: {
      mergeId: merge.id,
      merger: merge.merger,
      repo: merge.repo,
      base: merge.base,
      toStageId: merge.toStageId,
    },
    at: merge.requestedAt,
  });
  const mergeItem = (key, merge, extra = {}) => ({
    id: `inb-${key}-merge`,
    projectKey: 'AC',
    kind: 'merge_request',
    assignees: [owner],
    source: 'system',
    sessionId: null,
    taskKey: key,
    title: `Merge ${key} into ${BASE}`,
    body: null,
    payload: { mergeRequest: { taskKey: key, mergeId: merge.id, repo: REPO, base: BASE, ...extra } },
    options: [{ id: 'merge', label: 'Merge', style: 'primary' }],
    state: 'open',
    resolution: null,
    createdAt: merge.requestedAt,
  });
  const setup = (spec, merge, extra = {}) => {
    overlays[spec.key] = { stageId: before.id, merge, ...extra };
    events[spec.key] = [requestedEvent(spec.key, merge)];
  };

  setup(specs.requestedAi, mergeOf(specs.requestedAi.key, { merger: reviewer }));

  const asked = mergeOf(specs.requestedYou.key, {});
  setup(specs.requestedYou, asked);
  inbox.push(mergeItem(specs.requestedYou.key, asked));

  setup(
    specs.queued,
    mergeOf(specs.queued.key, { state: 'queued', step: 'queued', startedBy: owner, startedAt: ago(1) }),
  );
  setup(
    specs.running,
    mergeOf(specs.running.key, { state: 'running', step: 'checking', startedBy: owner, startedAt: ago(1) }),
  );

  const conflicted = mergeOf(specs.conflict.key, { state: 'failed', failure: conflict });
  setup(specs.conflict, conflicted);
  events[specs.conflict.key].push({
    type: 'task_merge_failed',
    data: { ...conflict, mergeId: conflicted.id },
    at: conflict.at,
  });
  inbox.push(mergeItem(specs.conflict.key, conflicted, { failure: conflict }));

  const unchecked = mergeOf(specs.checkFailed.key, {
    merger: reviewer,
    state: 'failed',
    failure: checkFailed,
  });
  setup(specs.checkFailed, unchecked);
  events[specs.checkFailed.key].push({
    type: 'task_merge_failed',
    data: { ...checkFailed, mergeId: unchecked.id },
    at: checkFailed.at,
  });

  const stopped = mergeOf(specs.blocked.key, { state: 'blocked', block: blocked });
  setup(specs.blocked, stopped);
  events[specs.blocked.key].push({
    type: 'task_merge_blocked',
    data: {
      mergeId: stopped.id,
      repo: REPO,
      base: BASE,
      reason: blocked.reason,
      message: blocked.message,
      landed: 'nowhere',
    },
    at: blocked.at,
  });
  inbox.push({
    ...mergeItem(specs.blocked.key, stopped),
    id: `inb-${specs.blocked.key}-blocked`,
    kind: 'alert',
    title: blocked.message,
    payload: {
      alert: 'merge_blocked',
      taskKey: specs.blocked.key,
      mergeId: stopped.id,
      reason: blocked.reason,
      message: blocked.message,
    },
    options: [{ id: 'seen', label: 'seen', style: 'primary' }],
  });

  // PM-471: the AI merger fixes a simple conflict in its own checkout; the box has no button until it submits.
  setup(
    specs.fixing,
    mergeOf(specs.fixing.key, {
      merger: reviewer,
      state: 'fixing',
      failure: conflict,
      fix: { by: reviewer, base: conflict.base, branch: `merge-fix/${specs.fixing.key}`, startedAt: ago(2) },
    }),
  );
  events[specs.fixing.key].push({
    type: 'task_merge_failed',
    data: { ...conflict, mergeId: `merge-${specs.fixing.key}` },
    at: conflict.at,
  });

  const resolution = {
    note: 'Kept both changes in `src/cart/totals.ts`: the **shipping fee** from main and the gift wrap line from the card.\n\n- `src/checkout/summary.tsx`: took main’s layout and re-added the wrap row.',
    commit: hex('d4d4d4'),
  };
  overlays[specs.fixed.key] = { stageId: target.id, merged: { ...merged, resolution } };
  events[specs.fixed.key] = [
    {
      type: 'task_merge_requested',
      data: { mergeId: 'merge-fixed', merger: reviewer, repo: REPO, base: BASE, toStageId: target.id },
      at: ago(40),
    },
    { type: 'task_merged', data: { ...merged, resolution, mergeId: 'merge-fixed' }, at: merged.at },
  ];

  overlays[specs.merged.key] = { stageId: target.id, merged };
  events[specs.merged.key] = [
    {
      type: 'task_merge_requested',
      data: { mergeId: 'merge-done', merger: owner, repo: REPO, base: BASE, toStageId: target.id },
      at: ago(40),
    },
    { type: 'task_merged', data: { ...merged, mergeId: 'merge-done' }, at: merged.at },
  ];

  // The labels the stage in front of the release asks for, so the card stands ready to be merged.
  const labels = ['client-accepted', 'merge-approved'];
  const overlayTask = (task) => {
    const overlay = overlays[task.key];
    if (!overlay) return task;
    const { merge, ...rest } = overlay;
    return {
      ...task,
      ...rest,
      labels: [...new Set([...(task.labels ?? []), ...labels])],
      ...(merge ? { merge } : {}),
    };
  };
  const eventOf = (key, event, index) => ({
    id: `evt-${key}-${index}`,
    projectKey: 'AC',
    taskKey: key,
    sessionId: null,
    actor: { kind: 'system', handle: null },
    type: event.type,
    data: event.data,
    createdAt: event.at,
  });

  const state = { refuse: null, unresolved: false };
  const page = await open({ path: '/p/AC' });

  await page.route('**/api/projects/AC/board*', async (route) => {
    const response = await route.fetch();
    const board = await response.json();
    board.tasks = board.tasks.map(overlayTask);
    await route.fulfill({ response, json: board });
  });
  await page.route(/\/api\/projects\/AC\/tasks\/AC-\d+(\?.*)?$/, async (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (route.request().method() === 'PATCH' && state.refuse === key) {
      await route.fulfill({
        status: 409,
        json: {
          error: {
            code: 'task_not_merged',
            message: 'The approved commit is not on the default branch',
            details: { reason: 'not_merged', merger: reviewer, base: BASE },
          },
        },
      });
      return;
    }
    if (route.request().method() !== 'GET' || !overlays[key]) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({
      response,
      json: {
        ...detail,
        task: overlayTask(detail.task),
        timeline: [...detail.timeline, ...(events[key] ?? []).map((event, i) => eventOf(key, event, i))],
      },
    });
  });
  await page.route('**/api/projects/AC/inbox*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const view = await response.json();
    await route.fulfill({ response, json: { ...view, items: [...inbox, ...view.items] } });
  });
  await page.route('**/api/projects/AC/config', async (route) => {
    if (route.request().method() === 'PATCH' && state.unresolved) {
      await route.fulfill({
        status: 400,
        json: {
          error: {
            code: 'config_invalid',
            message: 'Invalid configuration',
            details: {
              issues: [{ path: 'team.merger', code: 'merger_unresolved', detail: 'code_reviewer' }],
            },
          },
        },
      });
      return;
    }
    await route.continue();
  });

  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
  };
  const shot = (name, highlight) => shoot(page, name, { widths: WIDTHS, highlight });

  await step('the board, one card in each merge state', async () => {
    await visit('/p/AC');
    await page.getByText(specs.merged.title).first().waitFor();
    await shot('board');
  });

  const drawerShots = [
    // Another member sees the request in "Miért áll?"; the merger's own request is the inbox card of the drawer.
    ['drawer-requested-ai', specs.requestedAi, TEXT.why],
    ['drawer-requested-you', specs.requestedYou, TEXT.mergeInbox],
    ['drawer-queued', specs.queued, TEXT.queued],
    ['drawer-running', specs.running, 'Beolvasztás a main ágba'],
    ['drawer-failed-conflict', specs.conflict, TEXT.conflictInbox],
    ['drawer-failed-check', specs.checkFailed, TEXT.checkFailed],
    ['drawer-blocked', specs.blocked, TEXT.blocked],
    ['drawer-merged', specs.merged, 'Beolvasztotta'],
    ['drawer-fixing', specs.fixing, 'Az ütközést javítják'],
    ['drawer-fixed', specs.fixed, 'Ütközés javítva'],
  ];
  for (const [name, spec, text] of drawerShots) {
    await step(`the drawer: ${name}`, async () => {
      await visit(`/p/AC/tasks/${spec.key}`);
      await page.getByText(text).first().waitFor();
      // The fold of a fixed conflict is shot open, with what the merger wrote.
      if (name === 'drawer-fixed') await page.getByText(text).first().click();
      await shot(name);
    });
  }

  await step('the move panel refused for want of the merge', async () => {
    state.refuse = specs.requestedAi.key;
    await visit(`/p/AC/tasks/${specs.requestedAi.key}`);
    await page.getByRole('button', { name: TEXT.moveOpen }).click();
    await page.getByLabel(TEXT.moveTarget).selectOption(target.id);
    await page.getByRole('button', { name: TEXT.moveSubmit, exact: true }).click();
    await page.getByText(TEXT.refused).first().waitFor();
    await shot('drawer-refused', `text=${TEXT.refused} >> visible=true`);
    state.refuse = null;
  });

  await step('the inbox: the request, the request after a conflict and the stopped merge', async () => {
    await visit('/p/AC/inbox');
    await page.getByRole('heading', { name: `Beolvasztás: ${specs.requestedYou.key}` }).waitFor();
    await shot('inbox');
  });

  await step('the settings: who merges and which repository needs a merge', async () => {
    await visit('/p/AC/settings/team');
    await page.getByRole('region', { name: TEXT.mergerGroup }).waitFor();
    await shot('settings-merger', 'section[aria-labelledby="settings-merger-title"]');
    await visit('/p/AC/settings/repos');
    await page.getByLabel(`Beolvasztás · ${REPO}`).waitFor();
    await shot('settings-repo-merge', 'select >> visible=true');
  });

  await step('the settings: no one can merge, as the field error', async () => {
    state.unresolved = true;
    await visit('/p/AC/settings/team');
    const kind = page.getByLabel(TEXT.mergerLabel);
    await kind.waitFor();
    await kind.selectOption('developer');
    await page.getByRole('alert').first().waitFor();
    await shot('settings-merger-unresolved', 'section[aria-labelledby="settings-merger-title"]');
  });
};
