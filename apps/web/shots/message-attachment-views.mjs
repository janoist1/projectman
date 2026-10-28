/** PM-519: the card thread, conversation, dialog and list previews. */
export default async ({ instance, open, shoot, step }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const members = await instance.api('/api/projects/AC/members');
  const peer = members.find((m) => m.kind === 'ai');
  const other = members.find((m) => m.handle !== peer.handle && m.kind === 'ai');
  const board = await instance.api('/api/projects/AC/board');
  const task = board.tasks.find((t) => t.kind !== 'theme');
  let count = 0;
  const file = (fileName, preview = 'image', gone = false) => ({
    id: `msa_views${String(++count).padStart(8, '0')}`,
    projectKey: 'AC',
    fileName,
    size: 124500,
    mediaType: preview === 'image' ? 'image/png' : 'application/pdf',
    preview,
    uploadedBy: { kind: 'human', handle: owner },
    createdAt: new Date().toISOString(),
    ...(gone ? { goneAt: new Date().toISOString() } : {}),
  });
  const message = (from, to, attachments, taskKey = null) => ({
    id: `msg_views${String(++count).padStart(8, '0')}`,
    projectKey: 'AC',
    from,
    to,
    body: '',
    attachments,
    taskKey,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  });
  const image = file('screen.png');
  const messages = [
    message(peer.handle, [owner], [image]),
    message(owner, [other.handle], [file('one.png'), file('two.png'), file('three.pdf', 'pdf')]),
  ];
  const cardMessages = [message(peer.handle, [owner], [image, file('removed.png', 'image', true)], task.key)];
  const page = await open({ path: '/p/AC', width: 1512 });
  await page.getByRole('heading', { name: 'Folyamat', exact: true }).waitFor();
  const PNG = await page.screenshot({ clip: { x: 100, y: 150, width: 640, height: 400 } });
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/projects/AC/messages?*', async (route) => {
    const response = await route.fetch();
    const params = new URL(route.request().url()).searchParams;
    const threadWith = params.get('threadWith');
    const items =
      params.get('task') || params.get('taskKey')
        ? cardMessages
        : messages.filter((m) => !threadWith || m.from === threadWith || m.to.includes(threadWith));
    await json(route, { ...(await response.json()), messages: items });
  });
  await page.route('**/api/projects/AC/messages/threads', async (route) => {
    const response = await route.fetch();
    await json(route, {
      ...(await response.json()),
      threads: messages.map((m) => ({
        peer: m.from === owner ? m.to[0] : m.from,
        lastMessage: m,
        lastAt: m.createdAt,
        unreadCount: 0,
      })),
    });
  });
  await page.route('**/api/projects/AC/message-attachments**', async (route) => {
    if (route.request().method() === 'DELETE')
      return json(route, { id: new URL(route.request().url()).pathname.split('/').at(-1), deleted: true });
    if (route.request().method() === 'POST') {
      const name =
        route
          .request()
          .postDataBuffer()
          ?.toString()
          .match(/filename="([^"]+)"/)?.[1] ?? 'screen.png';
      return json(route, { attachment: file(name, name.endsWith('.pdf') ? 'pdf' : 'image') }, 201);
    }
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  const pick = async (names) => {
    await page.locator('[data-message-composer] input[type=file]').setInputFiles(
      names.map((name) => ({
        name,
        mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        buffer: PNG,
      })),
    );
    await page.getByRole('button', { name: 'Küldés', exact: true }).waitFor({ state: 'visible' });
    await page.waitForFunction(
      () => !document.querySelector('[data-message-composer] button[type=submit]')?.disabled,
    );
  };
  const both = async (name) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await shoot(page, name, { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, `${name}-dark`, { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await step('Card tray and attachment bubble', async () => {
    await page.goto(`${instance.webUrl}/p/AC/tasks/${task.key}/thread`);
    await page.locator('[data-message-composer] textarea').waitFor();
    await pick(['screen.png', 'report.pdf']);
    await both('card-tray');
    for (const button of await page
      .getByRole('list', { name: 'Az üzenethez csatolt fájlok' })
      .getByRole('button', { name: /eltávolítása$/ })
      .all())
      await button.click();
    await shoot(page, 'card-bubble', { widths: [1512, 390] });
  });
  await step('Conversation', async () => {
    await page.goto(`${instance.webUrl}/p/AC/messages/with/${peer.handle}`);
    await page.locator('[data-message-composer] textarea').waitFor();
    await pick(['screen.png']);
    await shoot(page, 'conversation', { widths: [1512, 390] });
  });
  await step('New message dialog', async () => {
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.getByRole('button', { name: 'Új üzenet', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox').first().check();
    await dialog
      .locator('input[type=file]')
      .setInputFiles({ name: 'screen.png', mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction(() => !document.querySelector('dialog button[type=submit]')?.disabled);
    await dialog.getByRole('textbox').scrollIntoViewIfNeeded();
    await shoot(page, 'new-message', { widths: [1512] });
    await page.setViewportSize({ width: 390, height: 844 });
    await dialog.getByRole('textbox').scrollIntoViewIfNeeded();
    await shoot(page, 'new-message', { widths: [390] });
  });
  await step('Conversation list previews', async () => {
    await page.goto(`${instance.webUrl}/p/AC/messages`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${instance.webUrl}/p/AC/messages`);
    await page.getByRole('navigation', { name: 'Beszélgetések' }).waitFor();
    await shoot(page, 'list-previews', { widths: [390] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'list-previews-dark', { widths: [390] });
    await page.setViewportSize({ width: 1512, height: 982 });
    await shoot(page, 'list-previews-dark', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'light' });
    await shoot(page, 'list-previews', { widths: [1512] });
  });
};
