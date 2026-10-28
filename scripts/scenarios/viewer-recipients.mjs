/**
 * Screenshots for PM-1102 (docs/SCREENSHOTS.md): whom the viewer may write to, in Settings → Team and on
 * the viewer's message surfaces.
 *
 *   npm run shots -- scripts/scenarios/viewer-recipients.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  const worker = members.find(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  if (!pm || !worker) throw new Error('the demo project has no project manager or worker');
  log(`pm: ${pm.handle}, worker: ${worker.handle}`);

  const setPolicy = async (viewerRecipients, contacts) => {
    const { version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: version, viewerRecipients, contacts },
    });
  };
  // Load the actual locale through Vite; UI wording stays in hu.ts.
  const first = await open({});
  const ui = await first.evaluate(async () => (await import('/src/i18n/hu.ts')).hu);
  const contactsRegion = (page) =>
    page.getByRole('region', { name: ui.settings.team.contacts.label }).first();
  const shootContacts = async (page, name) => {
    await contactsRegion(page).waitFor();
    await shoot(page, name, { widths: WIDTHS, highlight: `text=${ui.settings.team.viewerRecipients.label}` });
  };

  const viewer = await instance.invite({
    project: 'AC',
    email: 'viewer-recipients@example.test',
    name: 'Vera Viewer',
    access: 'viewer',
  });
  const developer = await instance.invite({
    project: 'AC',
    email: 'dev-recipients@example.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  await step('a: manager, project manager mode (the default)', async () => {
    await setPolicy('project_manager', []);
    await shootContacts(await open({ path: '/p/AC/settings/team' }), 'a-settings-default');
  });
  await step('b: manager, contacts mode, the project manager is no contact', async () => {
    await setPolicy('contacts', [worker.handle]);
    await shootContacts(await open({ path: '/p/AC/settings/team' }), 'b-settings-manager-not-contact');
  });
  await step('c: manager, contacts mode, empty list', async () => {
    await setPolicy('contacts', []);
    await shootContacts(await open({ path: '/p/AC/settings/team' }), 'c-settings-no-contacts');
  });
  await step('d: not a manager, contacts mode', async () => {
    await setPolicy('contacts', [worker.handle]);
    await shootContacts(await open({ as: developer, path: '/p/AC/settings/team' }), 'd-settings-read-only');
  });
  await step('e: viewer, project manager mode: list and composer', async () => {
    await setPolicy('project_manager', []);
    const page = await open({ as: viewer, path: '/p/AC/messages' });
    const newMessage = page.getByRole('button', { name: ui.messages.new }).first();
    await newMessage.waitFor();
    await shoot(page, 'e-viewer-messages', { widths: WIDTHS });
    await newMessage.click();
    await page.getByRole('group', { name: ui.messages.recipients }).first().waitFor();
    await shoot(page, 'e-viewer-composer', { widths: WIDTHS });
  });
  await step('f: viewer, project manager mode: the thread of another member', async () => {
    const page = await open({ as: viewer, path: `/p/AC/messages/with/${worker.handle}` });
    await page.waitForFunction(() => document.body.innerText.length > 0);
    await shoot(page, 'f-viewer-other-thread', { widths: WIDTHS });
  });
  await step('g: viewer, contacts mode, empty list', async () => {
    await setPolicy('contacts', []);
    await shoot(await open({ as: viewer, path: '/p/AC/messages' }), 'g-viewer-no-contacts', {
      widths: WIDTHS,
    });
  });
  await step('h: viewer, the card thread in project manager mode', async () => {
    await setPolicy('project_manager', []);
    const page = await open({ as: viewer, path: '/p/AC/tasks/AC-1/thread' });
    await page.getByText(ui.task.thread.default.managerOnly).first().waitFor();
    await shoot(page, 'h-viewer-card-thread', { widths: WIDTHS });
  });
  await step('i: the team list, as a full member, with the contact label', async () => {
    await setPolicy('contacts', [worker.handle]);
    const page = await open({ path: '/p/AC/team' });
    await page.waitForFunction(() => document.body.innerText.length > 0);
    await shoot(page, 'i-team-contact-label', { widths: WIDTHS });
  });
};
