import { hu } from '../../apps/web/src/i18n/hu.ts';

const t = (key, params) =>
  key
    .split('.')
    .reduce((value, part) => value[part], hu)
    .replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

/** PM-1008: PM-1001's a–k review scenes at desktop and phone widths.
 * Real API data except the deliberate save error, a temp member view and a legacy timeline event.
 * The compact scene enables the real TaskCard's compact prop in its browser-served module.
 * The inbox scene waits for the real five-minute timer; allow 600 seconds.
 */
const WIDTHS = [1512, 390];
const REASON = 'Touches pricing, tax and the order history';
export default async ({ instance, open, shoot, step, log }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  const developers = config.team.members.filter((m) => m.kind === 'ai' && m.role === 'developer');
  const [large, small] = developers;
  if (!large || !small) throw new Error('The demo needs two developers.');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: { baseVersion: version, limits: { ...config.team.limits, seniorWaitMinutes: 5 } },
  });
  await instance.api(`/api/projects/AC/members/${large.handle}`, {
    method: 'PATCH',
    body: { complexityLimit: 13 },
  });
  const card = async (title, points) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, repo: 'webshop', ...(points ? { complexity: { points, reason: REASON } } : {}) },
      })
    ).key;
  const busy = await card('Migrate the order history');
  await instance.waitIdle('AC', await instance.startSession('AC', busy, large.handle));
  const scored = await card('Rebuild the checkout pricing', 8);
  const waiting = await card('Add tiered shipping rates', 8);
  await instance.api(`/api/projects/AC/tasks/${waiting}/start`, { method: 'POST', body: {} });
  const unscored = await card('Adjust the order summary');
  log(`scored ${scored}, unscored ${unscored}, waiting ${waiting}`);
  const capture = async (page, name, highlight, focus) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 982 });
      if (focus) {
        await focus.scrollIntoViewIfNeeded();
        await focus.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      }
      await shoot(page, name, {
        widths: [width],
        fullPage: true,
        ...(highlight ? { highlight } : {}),
      });
    }
  };
  const complexityRow = (page) => page.getByText(hu.task.complexity.label, { exact: true }).locator('..');
  const edit = async (page) => page.getByRole('button', { name: hu.task.complexity.edit }).click();

  await step('a. board and compact cards', async () => {
    const page = await open({ path: '/p/AC' });
    await page
      .getByTitle(t('task.complexity.mark', { points: 8 }))
      .first()
      .waitFor();
    await capture(page, 'a-board');
    // No product route currently passes compact: use the actual component, with only its default prop enabled.
    const compact = await open({ path: '/p/AC' });
    await compact.route('**/src/features/board/TaskCard.tsx*', async (route) => {
      const response = await route.fetch();
      const source = await response.text();
      if (!source.includes('compact = false')) throw new Error('The TaskCard compact prop was not found.');
      await route.fulfill({ response, body: source.replace('compact = false', 'compact = true') });
    });
    await compact.reload();
    const mark = compact.getByTitle(t('task.complexity.mark', { points: 8 })).first();
    await mark.waitFor();
    await capture(compact, 'a-compact-board', undefined, mark);
  });
  await step('b. architect and developer reading views', async () => {
    const architect = await instance.invite({
      project: 'AC',
      email: 'architect@acme.test',
      name: 'Demo Architect',
      access: 'admin',
    });
    const me = await instance.api('/api/me', { as: architect });
    await instance.api(`/api/projects/AC/members/${me.handles.AC}`, {
      method: 'PATCH',
      body: { roles: ['architect'] },
    });
    const page = await open({ as: architect, path: `/p/AC/tasks/${scored}` });
    await page.getByRole('button', { name: hu.task.complexity.edit }).waitFor();
    await capture(page, 'b-architect', `text=${hu.task.complexity.label}`);
    const developer = await instance.invite({
      project: 'AC',
      email: 'developer@acme.test',
      name: 'Demo Developer',
      access: 'developer',
    });
    const reader = await open({ as: developer, path: `/p/AC/tasks/${scored}` });
    await reader.getByText(hu.task.complexity.label, { exact: true }).waitFor();
    await capture(reader, 'b-developer', `text=${hu.task.complexity.label}`, complexityRow(reader));
  });
  await step('c. 13-point editor and refused save', async () => {
    const page = await open({ path: `/p/AC/tasks/${scored}` });
    await edit(page);
    await page.getByRole('radio', { name: t('task.complexity.points', { points: 13 }), exact: true }).click();
    await capture(page, 'c-editor-13', 'form:has([role="radiogroup"])');
    await page.route(`**/api/projects/AC/tasks/${scored}`, async (route) =>
      route.request().method() === 'PATCH'
        ? route.fulfill({
            status: 403,
            json: { error: { code: 'complexity_forbidden', message: 'Demo refusal' } },
          })
        : route.continue(),
    );
    await page.getByRole('button', { name: hu.task.complexity.save, exact: true }).click();
    await page.getByRole('alert').waitFor();
    await capture(page, 'c-editor-error', 'form:has([role="radiogroup"])');
  });
  await step('d. no developer reaches the points', async () => {
    await instance.api(`/api/projects/AC/members/${large.handle}`, {
      method: 'PATCH',
      body: { complexityLimit: 5 },
    });
    const page = await open({ path: `/p/AC/tasks/${scored}` });
    await page.getByText(t('task.complexity.noneReach', { points: 8 }), { exact: true }).waitFor();
    await capture(page, 'd-none-reach', `text=${hu.task.complexity.label}`, complexityRow(page));
    await edit(page);
    await capture(page, 'd-none-reach-editor', 'form:has([role="radiogroup"])');
    await instance.api(`/api/projects/AC/members/${large.handle}`, {
      method: 'PATCH',
      body: { complexityLimit: 13 },
    });
  });
  await step('e. Start options and confirmation', async () => {
    const page = await open({ path: `/p/AC/tasks/${scored}` });
    const select = page.getByLabel(hu.task.assigneeLabel);
    await select.waitFor();
    await capture(page, 'e-start', `select[aria-describedby]`);
    await select.selectOption(small.handle);
    await page.getByRole('button', { name: hu.task.start, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await capture(page, 'e-confirm');
  });
  await step('f. immediate assignment warning', async () => {
    await instance.api(`/api/projects/AC/tasks/${scored}`, {
      method: 'PATCH',
      body: { assignee: small.handle },
    });
    const page = await open({ path: `/p/AC/tasks/${scored}` });
    await page
      .getByRole('status')
      .filter({
        hasText: t('task.complexity.assigneeWarning', { points: 8, limit: 5, name: small.displayName }),
      })
      .waitFor();
    await capture(page, 'f-assignment', `text=${hu.task.complexity.label}`);
    await instance.api(`/api/projects/AC/tasks/${scored}`, { method: 'PATCH', body: { assignee: null } });
  });
  await step('g. team limits including a temp view', async () => {
    const third = await instance.api('/api/projects/AC/members', {
      method: 'POST',
      body: { role: 'developer', displayName: 'Demo Small Developer' },
    });
    const handle = third.member?.handle ?? third.handle;
    if (!handle) throw new Error('The hired developer has no handle.');
    await instance.api(`/api/projects/AC/members/${handle}`, {
      method: 'PATCH',
      body: { complexityLimit: 3 },
    });
    const page = await open({ path: '/p/AC/team' });
    await page.route('**/api/projects/AC/members', async (route) => {
      const response = await route.fetch();
      const roster = await response.json();
      const temp = {
        ...roster.find((m) => m.handle === small.handle),
        handle: 'demo-temp',
        displayName: 'Demo Temp Developer',
        temp: true,
        complexityLimit: 5,
      };
      await route.fulfill({ response, json: [...roster, temp] });
    });
    await page.reload();
    await page.getByText('demo-temp', { exact: true }).first().waitFor();
    await capture(page, 'g-team');
    await capture(page, 'g-team-lower', `a[href="/p/AC/team/${large.handle}"]`);
    // Expand the app's scroll container for the inventory; keep the fixed tab bar off the content.
    const expanded = await page.addStyleTag({
      content:
        'html, body, #root { height: auto !important; overflow: visible !important; } main { overflow: visible !important; } nav[class*="_tabbar_"] { visibility: hidden !important; }',
    });
    await capture(page, 'g-team-full');
    await expanded.evaluate((node) => node.remove());
  });
  await step('h. member dialogs', async () => {
    const members = await instance.api('/api/projects/AC/members');
    for (const [name, member, temp] of [
      ['developer', members.find((m) => m.handle === large.handle)],
      ['temp', members.find((m) => m.handle === small.handle), true],
      ['qa', members.find((m) => m.role === 'qa')],
    ]) {
      if (!member) throw new Error(`Missing ${name} member`);
      const page = await open({ path: `/p/AC/team/${member.handle}` });
      if (temp) {
        await page.route(`**/api/projects/AC/members/${member.handle}/profile`, async (route) => {
          const response = await route.fetch();
          const profile = await response.json();
          await route.fulfill({
            response,
            json: { ...profile, member: { ...profile.member, temp: true, complexityLimit: 5 } },
          });
        });
        await page.reload();
      }
      await page.getByRole('button', { name: t('team.moreFor', { name: member.displayName }) }).click();
      await page
        .getByRole('button', { name: t('memberEdit.editMember', { name: member.displayName }) })
        .click();
      await page.getByRole('dialog').waitFor();
      await capture(page, `h-${name}`);
    }
  });
  await step('j. limits setting', async () => {
    const page = await open({ path: '/p/AC/settings/limits' });
    await page.getByLabel(hu.settings.limits.seniorWait).waitFor();
    await capture(page, 'j-limits', `text=${hu.settings.limits.seniorWait}`);
  });
  await step('k. points and a historical recommendation in the timeline', async () => {
    await instance.api(`/api/projects/AC/tasks/${scored}`, {
      method: 'PATCH',
      body: { complexity: { points: 13, reason: REASON } },
    });
    const page = await open({ path: `/p/AC/tasks/${scored}/timeline` });
    await page.route(`**/api/projects/AC/tasks/${scored}`, async (route) => {
      const response = await route.fetch();
      const detail = await response.json();
      const old = {
        ...detail.timeline[0],
        id: 'evt_demo_legacy',
        type: 'task_level_changed',
        data: { level: 'senior', reason: REASON, previous: null },
      };
      await route.fulfill({ response, json: { ...detail, timeline: [...detail.timeline, old] } });
    });
    await page.reload();
    await page.getByText(hu.timeline.levelSenior, { exact: false }).first().waitFor();
    await capture(page, 'k-timeline');
  });
  await step('i. real inbox wait question', async () => {
    // The no-reaching scene may settle the original wait; start it again after restoring the limit.
    const detail = await instance.api(`/api/projects/AC/tasks/${waiting}`);
    if (detail.task.assignee)
      await instance.api(`/api/projects/AC/tasks/${waiting}`, { method: 'PATCH', body: { assignee: null } });
    await instance.api(`/api/projects/AC/tasks/${waiting}/start`, { method: 'POST', body: {} });
    const deadline = Date.now() + 7 * 60_000;
    for (;;) {
      const { items } = await instance.api('/api/projects/AC/inbox');
      if (items.some((item) => item.state === 'open' && item.payload?.seniorWait)) break;
      if (Date.now() > deadline) throw new Error('The wait question did not arrive.');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    const page = await open({ path: '/p/AC/inbox' });
    await page.getByRole('heading', { name: hu.inbox.seniorWait.heading }).first().waitFor();
    await capture(page, 'i-inbox');
  });
};
