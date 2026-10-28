/**
 * Screenshots for PM-1026 (docs/SCREENSHOTS.md): renaming an AI member's handle and showing the old ones.
 *
 * The server and the rename are real (PM-1025). The browser's responses are varied only for what the demo
 * instance cannot show: the member's e-mail address (the channel is not set up), a running session of the
 * member, the `member_session_live` refusal and the task timeline rows of a renamed member.
 *
 *   npm run shots -- scripts/scenarios/member-rename.mjs --widths 1512,390
 *
 * Images (each at 1512 and 390): a-menu, b-dialog-email, c-field-invalid, d-field-taken, e-working,
 * f-session-live, g-after-rename, h-timeline, i-menu-admin.
 */

const NEW_HANDLE = 'dev-nova';
const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const workers = members.filter(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  // The developer can be started on AC-1 (it owns the work stage), so it is the one that works.
  const busy = workers.find((member) => member.role === 'developer') ?? workers[0];
  const renamed = workers.find((member) => member.handle !== busy.handle);
  const other = busy;
  if (!renamed || !busy) throw new Error('the demo project needs two AI workers');
  const owner = (await instance.api('/api/me')).handles.AC;
  log(`renamed: ${renamed.handle}, busy: ${busy.handle}, owner: ${owner}`);

  const state = { email: false, sessionLive: false, timeline: [] };

  let page = await open({ path: `/p/AC/team/${renamed.handle}` });
  const ui = await page.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const fill = (text, values) => text.replace(/\{(\w+)\}/g, (_, name) => values[name]);

  await page.route(
    (url) => url.pathname === '/api/projects/AC/email',
    (route) => {
      if (!state.email) return route.fallback();
      return json(route, 200, {
        configured: true,
        enabled: true,
        fromAddress: 'projectman@mail.example.com',
        memberDomain: 'mail.example.com',
        senders: [renamed, busy].map((member) => ({
          handle: member.handle,
          displayName: member.displayName,
          sendWithoutApproval: false,
          address: `${member.handle}@mail.example.com`,
          addressConflict: false,
        })),
        contacts: [],
      });
    },
  );
  await page.route(
    (url) => /^\/api\/projects\/AC\/members\/[^/]+\/rename$/.test(url.pathname),
    (route) => {
      if (!state.sessionLive) return route.fallback();
      return json(route, 409, {
        error: {
          code: 'member_session_live',
          message: 'The member is working',
          details: { reason: 'workspace', member: renamed.handle },
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/api/projects/AC/tasks/AC-1',
    async (route) => {
      if (route.request().method() !== 'GET' || !state.timeline.length) return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      json(route, response.status(), { ...body, timeline: [...body.timeline, ...state.timeline] });
    },
  );

  const dialog = () => page.getByRole('dialog');
  const menuName = (member) => fill(ui.team.moreFor, { name: member.displayName });
  const openMenu = async (member) => {
    await page.getByRole('button', { name: menuName(member) }).click();
  };
  const openDialog = async (member) => {
    await openMenu(member);
    await page
      .getByRole('button', { name: fill(ui.memberRename.menuFor, { name: member.displayName }) })
      .click();
    await dialog().waitFor();
  };
  const submit = () => dialog().getByRole('button', { name: ui.memberRename.submit, exact: true });
  /** The wide image as it is, the phone image scrolled so the footer (or the line) is in view. */
  const shootBoth = async (name, target) => {
    await shoot(page, name, { widths: [1512], fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await target().scrollIntoViewIfNeeded();
    await shoot(page, name, { widths: [390], fullPage: false });
  };

  await step('a: the menu with the rename row', async () => {
    await page.getByRole('heading', { level: 1, name: renamed.displayName }).waitFor();
    await openMenu(renamed);
    await page
      .getByRole('button', { name: fill(ui.memberRename.menuFor, { name: renamed.displayName }) })
      .waitFor();
    await shootBoth('a-menu', () =>
      page.getByRole('button', { name: fill(ui.memberRename.menuFor, { name: renamed.displayName }) }),
    );
    await page.keyboard.press('Escape');
  });

  await step('b: the dialog with the e-mail line', async () => {
    state.email = true;
    await page.reload();
    await openDialog(renamed);
    await dialog().getByLabel(ui.memberRename.label).fill(NEW_HANDLE);
    await page.getByText('mail.example.com').first().waitFor();
    await shootBoth('b-dialog-email', submit);
  });

  await step('c: the malformed handle', async () => {
    await dialog().getByLabel(ui.memberRename.label).fill('Dev_Sonnet 3');
    await submit().click();
    await dialog().getByText(ui.memberRename.invalid).waitFor();
    await shootBoth('c-field-invalid', submit);
  });

  await step('d: the taken handle', async () => {
    await dialog().getByLabel(ui.memberRename.label).fill(other.handle);
    await submit().click();
    await dialog()
      .getByText(fill(ui.memberRename.taken, { handle: other.handle }))
      .waitFor();
    await shootBoth('d-field-taken', submit);
  });

  await step('f: the refusal while a session holds the workspace', async () => {
    state.sessionLive = true;
    await dialog().getByLabel(ui.memberRename.label).fill(NEW_HANDLE);
    await submit().click();
    await dialog().getByRole('alert').waitFor();
    await shootBoth('f-session-live', submit);
    state.sessionLive = false;
  });

  await step('g: after the rename, the profile with the old handle and the toast', async () => {
    state.email = false;
    await submit().click();
    await page.getByText(ui.memberRename.former).first().waitFor();
    await page
      .getByText(fill(ui.memberRename.done, { from: renamed.handle, to: NEW_HANDLE }), { exact: true })
      .waitFor();
    await shootBoth('g-after-rename', () => page.getByText(ui.memberRename.former).first());
  });

  await step('h: the timeline with the rename and a row under the old handle', async () => {
    const at = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
    const event = (id, minutes, actor, type, data) => ({
      id: `evt_shot_${id}`,
      projectKey: 'AC',
      taskKey: 'AC-1',
      sessionId: null,
      actor,
      type,
      data,
      createdAt: at(minutes),
    });
    state.timeline = [
      event('note_old', 20, { kind: 'ai', handle: renamed.handle }, 'task_note', {
        text: 'Az első változat kész, a tesztek zöldek.',
      }),
      event('renamed', 5, { kind: 'human', handle: owner }, 'member_renamed', {
        from: renamed.handle,
        to: NEW_HANDLE,
        version: 2,
      }),
      event('note_new', 2, { kind: 'ai', handle: NEW_HANDLE }, 'task_note', {
        text: 'Az új azonosítóval folytatom.',
      }),
    ];
    await page.goto(new URL('/p/AC/tasks/AC-1/timeline', page.url()).href);
    await page.getByText('Az új azonosítóval folytatom.').waitFor();
    await shootBoth('h-timeline', () => page.getByText('Az első változat kész, a tesztek zöldek.'));
    state.timeline = [];
  });

  await step('e: the member works, so the rename waits', async () => {
    const sessionId = await instance.startSession('AC', 'AC-1', busy.handle);
    await instance.waitIdle('AC', sessionId);
    log(
      `session ${sessionId} of ${busy.handle}: ${(await instance.api(`/api/projects/AC/sessions/${sessionId}`)).session?.state}`,
    );
    await page.goto(new URL(`/p/AC/team/${busy.handle}`, page.url()).href);
    await page.getByRole('heading', { level: 1, name: busy.displayName }).waitFor();
    await openDialog(busy);
    await dialog().getByRole('status').waitFor();
    if ((await submit().getAttribute('aria-disabled')) !== 'true')
      throw new Error('the rename button is not aria-disabled while the member works');
    await shootBoth('e-working', submit);
    await page.keyboard.press('Escape');
  });

  await step('i: an admin sees no rename row', async () => {
    const admin = await instance.invite({
      project: 'AC',
      email: 'admin@acme.test',
      name: 'Dana Admin',
      access: 'admin',
    });
    page = await open({ as: admin, path: `/p/AC/team/${renamed.handle}` });
    await page.getByRole('heading', { level: 1, name: renamed.displayName }).waitFor();
    await openMenu({ ...renamed, displayName: renamed.displayName });
    const rows = await page
      .getByRole('button', { name: fill(ui.memberRename.menuFor, { name: renamed.displayName }) })
      .count();
    if (rows !== 0) throw new Error('an admin is offered the rename row');
    await shoot(page, 'i-menu-admin', { widths: [1512, 390], fullPage: false });
  });
};
