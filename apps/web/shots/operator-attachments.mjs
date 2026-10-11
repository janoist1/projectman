/** PM-517: attachment states in the real Operator UI, with controlled HTTP answers. */
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const member = (await instance.api('/api/projects/AC/members')).find((item) => item.role === 'ai_operator');
  const state = { messages: [], upload: 'ready', sendFails: false, count: 0 };
  const attachment = (name, preview = 'image') => ({
    id: `msa_screenshot${String(++state.count).padStart(4, '0')}`,
    projectKey: 'AC',
    fileName: name,
    size: 124500,
    mediaType: preview === 'image' ? 'image/png' : preview === 'pdf' ? 'application/pdf' : 'text/plain',
    preview,
    uploadedBy: { kind: 'human', handle: owner },
    createdAt: new Date().toISOString(),
  });
  const message = (files, body = '') => ({
    id: `msg_screenshot${state.count}`,
    projectKey: 'AC',
    from: owner,
    to: [member.handle],
    taskKey: null,
    body,
    attachments: files,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
  });
  const uploads = new Map();
  let finishUpload;
  const page = await open({ path: '/p/AC', width: 1512 });
  await page.getByRole('heading', { name: 'Folyamat', exact: true }).waitFor();
  const PNG = await page.screenshot({ clip: { x: 100, y: 150, width: 640, height: 400 } });
  const json = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/projects/AC/messages?*', async (route) => {
    if (!route.request().url().includes('threadWith=')) return route.continue();
    const response = await route.fetch();
    return json(route, response.status(), { ...(await response.json()), messages: state.messages });
  });
  await page.route('**/api/projects/AC/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (state.sendFails)
      return json(route, 500, { error: { code: 'internal_error', message: 'Fixture send failure' } });
    const request = route.request().postDataJSON();
    const sent = message(
      (request.attachmentIds ?? []).map((id) => uploads.get(id)),
      request.text,
    );
    state.messages.push(sent);
    return json(route, 202, sent);
  });
  await page.route('**/api/projects/AC/message-attachments**', async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      if (state.upload === 'uploading')
        await new Promise((resolve) => {
          finishUpload = resolve;
        });
      if (state.upload === 'failed')
        return json(route, 500, { error: { code: 'internal_error', message: 'Fixture upload failure' } });
      const name =
        request
          .postDataBuffer()
          ?.toString()
          .match(/filename="([^"]+)"/)?.[1] ?? 'screen.png';
      const file = attachment(name, name.endsWith('.pdf') ? 'pdf' : 'image');
      uploads.set(file.id, file);
      return json(route, 201, { attachment: file });
    }
    const id = new URL(request.url()).pathname.split('/')[5];
    if (request.method() === 'DELETE') {
      for (const item of state.messages)
        item.attachments = item.attachments.map((file) =>
          file.id === id ? { ...file, goneAt: new Date().toISOString() } : file,
        );
      return json(route, 200, { id, deleted: true });
    }
    const image = [...uploads.values(), ...state.messages.flatMap((item) => item.attachments)].find(
      (file) => file.id === id,
    );
    if (image?.fileName === 'broken.png') return route.fulfill({ status: 404 });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  const showPanel = async () => {
    await page.getByRole('button', { name: /^Beszélgetés az Operátorral/ }).click();
    await page.getByRole('textbox', { name: 'Üzenet az Operátornak' }).waitFor();
  };
  const reset = async () => {
    await page.reload();
    await showPanel();
  };
  const pick = (names) =>
    page.locator('#operator-panel input[type=file]').setInputFiles(
      names.map((name) => ({
        name,
        mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        buffer: PNG,
      })),
    );
  const bothThemes = async (name) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await shoot(page, name, { widths: WIDTHS });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, `${name}-dark`, { widths: WIDTHS });
    await page.emulateMedia({ colorScheme: 'light' });
  };
  await step('Introduction', async () => {
    await showPanel();
    await shoot(page, 'intro', { widths: WIDTHS });
  });
  await step('Uploading tray', async () => {
    state.upload = 'uploading';
    await pick(['screen.png']);
    await bothThemes('tray-uploading');
    state.upload = 'ready';
    finishUpload?.();
  });
  await step('Ready tray', async () => {
    await reset();
    await pick(['screen.png', 'second.png', 'report.pdf']);
    await page.waitForFunction(() => !document.querySelector('#operator-panel button[type=submit]').disabled);
    await bothThemes('tray-ready');
  });
  await step('Upload failure', async () => {
    await reset();
    state.upload = 'failed';
    await pick(['failed.png']);
    await page.getByText('Egy fájl nem töltődött fel: próbáld újra, vagy vedd ki.').waitFor();
    await shoot(page, 'tray-failed', { widths: WIDTHS });
    state.upload = 'ready';
  });
  await step('Client limits', async () => {
    await reset();
    await page.locator('#operator-panel textarea').evaluate((target) => {
      const data = new DataTransfer();
      const file = new File(['x'], 'huge.png', { type: 'image/png' });
      Object.defineProperty(file, 'size', { value: 25000001 });
      data.items.add(file);
      target.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await shoot(page, 'too-large', { widths: WIDTHS });
    await pick(Array.from({ length: 11 }, (_, index) => `image-${index}.png`));
    await shoot(page, 'too-many', { widths: WIDTHS });
  });
  await step('Drop overlay', async () => {
    await reset();
    await page.setViewportSize({ width: 1512, height: 982 });
    await page.locator('#operator-panel').evaluate((target) => {
      const data = new DataTransfer();
      data.items.add(new File(['x'], 'screen.png', { type: 'image/png' }));
      target.dispatchEvent(
        new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }),
      );
    });
    await shoot(page, 'drop', { widths: [1512] });
  });
  await step('History and gallery', async () => {
    const images = Array.from({ length: 5 }, (_, index) => attachment(`image-${index}.png`));
    const gone = { ...attachment('removed.png'), goneAt: new Date().toISOString() };
    state.messages = [message([attachment('single.png')])];
    await reset();
    await bothThemes('history-single');
    state.messages = [
      message(images),
      message([attachment('report.pdf', 'pdf'), attachment('notes.txt', 'none'), gone]),
      message([attachment('broken.png')]),
    ];
    await reset();
    await bothThemes('history');
    await page.getByRole('button', { name: 'image-0.png megnyitása nagy méretben' }).click();
    await page.getByRole('button', { name: 'Következő', exact: true }).click();
    await shoot(page, 'gallery', { widths: WIDTHS });
    await page.getByRole('button', { name: 'Törlés', exact: true }).click();
    await shoot(page, 'delete-confirm', { widths: WIDTHS });
  });
  await step('Failed send', async () => {
    state.messages = [];
    await reset();
    await pick(['screen.png']);
    await page.waitForFunction(() => !document.querySelector('#operator-panel button[type=submit]').disabled);
    state.sendFails = true;
    await page.getByRole('button', { name: 'Küldés' }).click();
    await page.getByText('Nem ment el.').waitFor();
    await shoot(page, 'send-failed', { widths: WIDTHS });
  });
};
