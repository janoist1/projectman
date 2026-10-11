/**
 * Scenario for PM-502 (docs/SCREENSHOTS.md): the files a question names, as tiles on the question (PM-498).
 * Files go onto a card and its parent, a developer's session asks `ask_human` naming them, and one file is
 * deleted afterwards. It shoots, at 1512 and 390 px:
 *
 *   a. the question in "Rád vár": an image, a long-named HTML, a PDF, the parent card's PDF and the deleted file
 *   b. the same in the dark theme
 *   c. the card's drawer, where the same question shows as the compact card
 *   d. the image in the large view, and e. the large view when the image does not load
 *
 * The drawer over "Rád vár" (PM-501) is not on every checkout; the card's own drawer shows the same compact card.
 *
 *   npm run shots -- scripts/scenarios/inbox-attachments.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const QUESTION = 'Melyik hibaoldal legyen a kosárban: a régi vagy az új?';
const LONG_NAME = 'forgalmi-riport-2026-oktober-vegleges-javitott-valtozat-harmadik-kor.html';
const GROUP = 'Csatolmányok a válaszhoz';

const PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
].join('\n');

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const owner = members.find((member) => member.kind === 'human').handle;
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer').handle;

  const parent = (
    await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Rework the basket error pages', repo: 'webshop', labels: [] },
    })
  ).key;
  const child = (
    await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: {
        title: 'Show the new error page in the basket',
        repo: 'webshop',
        labels: [],
        parentKey: parent,
      },
    })
  ).key;
  log(`parent ${parent}, child ${child}`);

  const page = await open({ path: '/' });
  // The files go up from the page itself (multipart, the owner's login cookie).
  const upload = (taskKey, name, type, text) =>
    page.evaluate(
      async ({ taskKey: key, name: fileName, type: mediaType, text: content }) => {
        let blob;
        if (mediaType === 'image/png') {
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 400;
          const context = canvas.getContext('2d');
          context.fillStyle = '#eef1fb';
          context.fillRect(0, 0, 640, 400);
          context.fillStyle = '#3b5bdb';
          context.fillRect(40, 40, 560, 56);
          context.fillStyle = '#c92a2a';
          context.fillRect(40, 140, 360, 24);
          context.fillStyle = '#868e96';
          for (let line = 0; line < 4; line++) context.fillRect(40, 200 + line * 36, 520 - line * 60, 12);
          blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        } else blob = new Blob([content], { type: mediaType });
        const body = new FormData();
        body.append('file', new File([blob], fileName, { type: mediaType }));
        const response = await fetch(`/api/projects/AC/tasks/${key}/attachments`, { method: 'POST', body });
        if (!response.ok) throw new Error(`upload ${fileName}: ${response.status} ${await response.text()}`);
        return (await response.json()).attachment;
      },
      { taskKey, name, type, text },
    );

  const image = await upload(child, 'kosar-hiba.png', 'image/png', '');
  const html = await upload(
    child,
    LONG_NAME,
    'text/html',
    '<!doctype html><title>riport</title><p>Riport</p>',
  );
  const pdf = await upload(child, 'merespecifikacio.pdf', 'application/pdf', PDF);
  const parentPdf = await upload(parent, 'szerzodes-vazlat.pdf', 'application/pdf', PDF);
  const old = await upload(child, 'regi-terv.png', 'image/png', '');
  log(`files: ${[image, html, pdf, parentPdf, old].map((file) => `${file.id} ${file.preview}`).join(', ')}`);

  const sessionId = await instance.startSession('AC', child, developer);
  await instance.waitIdle('AC', sessionId);
  await instance.setFakeCalls([
    {
      tool: 'ask_human',
      arguments: {
        question: QUESTION,
        to: [owner],
        attachments: [image.id, html.id, pdf.id, parentPdf.id, old.id],
      },
    },
  ]);
  await instance.say('AC', sessionId, 'CALLS please');
  await instance.waitIdle('AC', sessionId);
  // The file is deleted after the question: its tile reads "már nem elérhető".
  await instance.api(`/api/projects/AC/tasks/${child}/attachments/${old.id}`, { method: 'DELETE' });

  const group = (target) => target.getByRole('group', { name: GROUP }).first();

  await step('a. the question in Rád vár', async () => {
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await group(page).waitFor();
    await page.getByText('már nem elérhető').first().waitFor();
    await shoot(page, 'a-inbox', { widths: WIDTHS, highlight: `[role=group][aria-labelledby]` });
  });

  await step('b. the dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'b-inbox-dark', { widths: WIDTHS });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('c. the compact card in the drawer', async () => {
    await page.goto(new URL(`/p/AC/tasks/${child}`, page.url()).href);
    await group(page).waitFor();
    await shoot(page, 'c-drawer', { widths: WIDTHS, highlight: `[role=group][aria-labelledby]` });
  });

  await step('d. the image in the large view', async () => {
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await group(page)
      .getByRole('button', { name: /kosar-hiba\.png/ })
      .click();
    await page.getByRole('dialog').getByRole('img').waitFor();
    await shoot(page, 'd-image', { widths: WIDTHS });
    await page.keyboard.press('Escape');
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
    log(`focus after closing: ${focused}`);
  });

  await step('e. the image does not load', async () => {
    // A route answering 404 (like a file deleted behind the page's back); intercepting also turns the cache off.
    await page.route(/\/attachments\/[^/]+\/content$/, (route) =>
      route.fulfill({ status: 404, body: 'gone' }),
    );
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await group(page)
      .getByRole('button', { name: /kosar-hiba\.png/ })
      .click();
    await page.getByRole('dialog').getByRole('status').waitFor();
    await shoot(page, 'e-image-failed', { widths: WIDTHS });
  });
};
