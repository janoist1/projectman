/**
 * Scenario for PM-487 (docs/SCREENSHOTS.md): the four views of the open card, Kártya · Beszélgetés ·
 * Csatolmányok · Idővonal. The scenario shoots the states the UI/UX review asks for:
 *
 *   a. the Card view (no attachments and no timeline on it)
 *   b. the Attachments view with a list
 *   c. the Attachments view of a card without files
 *   d. the Timeline view, opened at its end, with the comment box
 *   e. a theme: three views
 *   f. a phone: the Thread count with two digits
 *   g. the large window with two columns on the Timeline view
 *
 *   npm run shots -- scripts/scenarios/card-views.mjs [--widths 1512,390]
 */

const TEXT = {
  card: 'Kártya',
  thread: 'Beszélgetés',
  attachments: 'Csatolmányok',
  timeline: 'Idővonal',
  none: 'Még nincs csatolmány.',
  files: 'Csatolt fájlok',
  views: 'A kártya nézetei',
};
const CARD = 'AC-1';
// A 1x1 PNG, enough for a thumbnail.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

export default async ({ instance, open, shoot, step, log }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const developer = config.team.members.find((member) => member.kind === 'ai' && member.role === 'developer');
  log(`developer ${developer.handle}`);

  await step('the card gets files and twelve messages', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/attachments` });
    await page.getByRole('group', { name: TEXT.views }).waitFor();
    await page.locator('input[type=file]').setInputFiles([
      { name: 'mockup-checkout.png', mimeType: 'image/png', buffer: PNG },
      { name: 'mockup-mobile.png', mimeType: 'image/png', buffer: PNG },
      { name: 'spec.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF\n') },
    ]);
    await page.getByRole('list', { name: TEXT.files }).waitFor();
    await page.getByRole('button', { name: new RegExp(`^${TEXT.attachments}\\s*3`) }).waitFor();
    for (let i = 1; i <= 12; i++) {
      await instance.api('/api/projects/AC/messages', {
        method: 'POST',
        body: { to: [developer.handle], text: `Üzenet ${i} a kártyáról.`, taskKey: CARD },
      });
    }
  });

  await step('a. the Card view', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}` });
    await page.getByRole('button', { name: new RegExp(`^${TEXT.attachments}`) }).waitFor();
    await shoot(page, 'views-card', { widths: [1512, 390] });
  });

  await step('b. the Attachments view', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/attachments` });
    await page.getByRole('list', { name: TEXT.files }).waitFor();
    await shoot(page, 'views-attachments', { widths: [1512, 390] });
  });

  await step('c. the Attachments view without files', async () => {
    const created = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Add gift wrapping', repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
    });
    const page = await open({ path: `/p/AC/tasks/${created.key}/attachments` });
    await page.getByText(TEXT.none, { exact: true }).waitFor();
    await shoot(page, 'views-attachments-empty', { widths: [1512, 390] });
  });

  await step('d. the Timeline view, opened at its end', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/timeline` });
    await page.getByRole('textbox').first().waitFor();
    await shoot(page, 'views-timeline', { widths: [1512, 390] });
  });

  await step('e. a theme: three views', async () => {
    const theme = await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Webshop launch', kind: 'theme' },
    });
    const page = await open({ path: `/p/AC/tasks/${theme.key}` });
    await page.getByRole('button', { name: TEXT.timeline }).waitFor();
    await shoot(page, 'views-theme', { widths: [1512, 390] });
  });

  await step('f. a phone with the two-digit count of the conversation', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/thread`, width: 390 });
    await page.getByRole('button', { name: new RegExp(`^${TEXT.thread}\\s*1[0-9]`) }).waitFor();
    await shoot(page, 'views-phone-counts', { widths: [390, 360] });
  });

  await step('g. the large window, two columns, Timeline view', async () => {
    const page = await open({ path: `/p/AC/tasks/${CARD}/timeline?size=large`, width: 1512 });
    await page.getByRole('textbox').first().waitFor();
    await shoot(page, 'views-large-timeline', { widths: [1512] });
  });
};
