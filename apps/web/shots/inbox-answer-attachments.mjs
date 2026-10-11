/** PM-521: attachment states in an inbox answer, using controlled HTTP responses. */
export default async ({ instance, open, shoot, step }) => {
  const owner = (await instance.api('/api/me')).handles.AC;
  const peer = (await instance.api('/api/projects/AC/members')).find(
    (member) => member.kind === 'ai' && member.role === 'developer',
  );
  const question = {
    id: 'inb_answerattachments',
    projectKey: 'AC',
    kind: 'question',
    source: peer.handle,
    assignees: [owner],
    taskKey: null,
    sessionId: null,
    state: 'open',
    resolution: null,
    title: 'Which layout should we use?',
    body: null,
    payload: {},
    createdAt: new Date().toISOString(),
    options: [
      { id: 'option_1', label: 'Layout A', style: 'primary' },
      { id: 'answer', label: 'answer', style: 'secondary' },
    ],
  };
  let count = 0;
  let mode = 'uploading';
  let finish;
  const files = [];
  const attachment = (name) => ({
    id: `msa_answer${String(++count).padStart(8, '0')}`,
    projectKey: 'AC',
    fileName: name,
    size: 124500,
    mediaType: name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
    preview: name.endsWith('.pdf') ? 'pdf' : 'image',
    uploadedBy: { kind: 'human', handle: owner },
    createdAt: new Date().toISOString(),
  });
  const page = await open({ path: '/p/AC', width: 1512 });
  await page.getByRole('heading', { name: 'Folyamat', exact: true }).waitFor();
  const PNG = await page.screenshot({ clip: { x: 100, y: 150, width: 640, height: 400 } });
  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/projects/AC/inbox**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.items) return json(route, { ...body, items: [question] });
    return json(route, body);
  });
  await page.route('**/api/projects/AC/message-attachments**', async (route) => {
    if (route.request().method() === 'DELETE')
      return json(route, { deleted: true, id: route.request().url().split('/').at(-1) });
    if (route.request().method() !== 'POST')
      return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    const name = route
      .request()
      .postDataBuffer()
      .toString()
      .match(/filename="([^"]+)"/)[1];
    if (mode === 'failed')
      return json(route, { error: { code: 'attachment_storage_failed', message: 'Upload failed' } }, 500);
    if (mode === 'uploading')
      await new Promise((resolve) => {
        finish = resolve;
      });
    const file = attachment(name);
    files.push(file);
    return json(route, { attachment: file }, 201);
  });
  await page.goto(`${instance.webUrl}/p/AC/inbox`);
  await page.locator(`#inbox-item-${question.id}`).waitFor();
  await page.getByRole('button', { name: 'Saját válasz' }).click();
  const pick = (names) =>
    page.locator('[data-message-composer] input[type=file]').setInputFiles(
      names.map((name) => ({
        name,
        mimeType: name.endsWith('.pdf') ? 'application/pdf' : 'image/png',
        buffer: PNG,
      })),
    );
  await step('Upload in progress', async () => {
    await pick(['screen.png']);
    await page.getByText('Várd meg, amíg a fájl feltöltődik.').waitFor();
    await shoot(page, 'answer-uploading', { widths: [1512, 390] });
    mode = 'ready';
    finish();
  });
  await step('Ready files and option buttons', async () => {
    await pick(['second.png', 'report.pdf']);
    await page.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('button')).find((button) =>
          button.textContent.includes('Válasz küldése'),
        )?.disabled,
    );
    await shoot(page, 'answer-ready', { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'answer-ready-dark', { widths: [1512, 390] });
    await page.emulateMedia({ colorScheme: 'light' });
  });
  await step('Failed upload and drop target', async () => {
    mode = 'failed';
    await pick(['failed.png']);
    await page.getByText('Egy fájl nem töltődött fel: próbáld újra, vagy vedd ki.').waitFor();
    await shoot(page, 'answer-failed', { widths: [1512] });
    await page.locator('[data-message-composer]').evaluate((element) => {
      const data = new DataTransfer();
      data.items.add(new File(['image'], 'drop.png', { type: 'image/png' }));
      element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: data }));
    });
    await shoot(page, 'answer-drop', { widths: [1512] });
  });
  await step('Answer in the asker conversation', async () => {
    question.state = 'resolved';
    question.resolution = {
      optionId: 'answer',
      note: 'See the attached layout.',
      by: owner,
      at: new Date().toISOString(),
    };
    const message = {
      id: 'msg_answerattachments',
      projectKey: 'AC',
      from: owner,
      to: [peer.handle],
      taskKey: null,
      body: 'See the attached layout.',
      answer: { inboxItemId: question.id, question: question.title, answer: 'See the attached layout.' },
      attachments: files,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
    };
    await page.route('**/api/projects/AC/messages?*', async (route) => {
      const response = await route.fetch();
      return json(route, { ...(await response.json()), messages: [message] });
    });
    await page.goto(`${instance.webUrl}/p/AC/messages/with/${peer.handle}`);
    await page.getByText('See the attached layout.', { exact: true }).waitFor();
    await shoot(page, 'answer-conversation', { widths: [1512] });
  });
};
