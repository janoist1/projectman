/**
 * PM-1189: deleting a feedback mark in the web view, for the UI/UX review.
 *
 *   npm run shots -- scripts/scenarios/feedback-delete.mjs --widths 1512,390
 *
 * The owner opens the mark of a client that already has a card. The answers of the feedback routes are
 * given in the browser (`page.route`), so the disposable instance needs no surface and no real mark; the
 * delete request is answered the same way and takes the mark off the list.
 */
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const MARK_ID = 'fbm_del0000000001';

export default async ({ instance, open, shoot, step }) => {
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const owner = (await instance.api('/api/me')).handles.AC;
  const card = { visible: true, key: 'AC-2', title: 'Add a shopping basket', stageName: 'Fejlesztés' };
  const surface = { id: 'shop', name: 'Webshop', origin: 'https://shop.acme.test' };
  const author = { handle: 'kata', name: 'Kata', kind: 'human', color: 2 };
  const mark = {
    id: MARK_ID,
    projectKey: 'AC',
    author,
    surface,
    pageUrl: 'https://shop.acme.test/basket',
    pagePath: '/basket',
    pageTitle: 'Kosár',
    kind: 'point',
    body: 'A végösszeg rossz egy tétel törlése után.',
    anchor: {
      kind: 'point',
      selector: null,
      textSnippet: null,
      elementOffset: null,
      pagePoint: { x: 320, y: 240 },
      rect: null,
    },
    status: 'handled',
    outcome: 'card_created',
    card,
    working: false,
    commentCount: 1,
    unread: false,
    hasScreenshot: false,
    canDelete: true,
    createdAt: minutesAgo(600),
    updatedAt: minutesAgo(300),
    lastActivityAt: minutesAgo(300),
    closedAt: null,
  };
  const detail = {
    ...mark,
    thread: [
      {
        id: 'fbe_1',
        type: 'card_created',
        actor: { handle: owner, name: 'Tulajdonos', kind: 'human', color: 1 },
        body: null,
        card,
        createdAt: minutesAgo(300),
      },
    ],
    environment: null,
    screenshot: null,
    canProcess: true,
    canComment: true,
  };
  const state = { deleted: false };

  const visit = async (width) => {
    const page = await open({ path: '/p/AC', width });
    await page.route('**/api/projects/AC/feedback', (route) =>
      json(route, {
        marks: state.deleted ? [] : [mark],
        surfaces: [surface],
        markers: [{ handle: author.handle, name: author.name, color: author.color }],
        canProcess: true,
        canMark: true,
      }),
    );
    await page.route('**/api/projects/AC/feedback/summary', (route) =>
      json(route, { configured: true, canMark: true, canProcess: true, todo: 0, unreadReplies: 0 }),
    );
    await page.route('**/api/projects/AC/feedback/settings', (route) =>
      json(route, {
        publicBaseUrl: null,
        surfaces: [{ ...surface, lastMarkAt: mark.createdAt }],
        markers: [],
      }),
    );
    await page.route(`**/api/projects/AC/feedback/${MARK_ID}/read`, (route) =>
      route.fulfill({ status: 204 }),
    );
    await page.route(`**/api/projects/AC/feedback/${MARK_ID}`, (route) => {
      if (route.request().method() === 'DELETE') {
        state.deleted = true;
        return route.fulfill({ status: 204 });
      }
      return state.deleted
        ? json(route, { error: { code: 'feedback_mark_not_found', message: 'gone', details: null } }, 404)
        : json(route, detail);
    });
    await page.goto(new URL(`/p/AC/feedback/${MARK_ID}?f=all`, page.url()).href);
    await page.getByRole('region', { name: /jelölés részletei/ }).waitFor();
    return page;
  };

  for (const width of [1512, 390]) {
    state.deleted = false;
    await step(`delete a mark at ${width}`, async () => {
      const page = await visit(width);
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: 'További műveletek' }).click();
      await page.waitForTimeout(300);
      await shoot(page, `feedback-delete-menu-${width}`, { widths: [width] });
      await page.getByRole('button', { name: 'Törlöm a jelölést' }).click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(300);
      await shoot(page, `feedback-delete-dialog-${width}`, { widths: [width] });
      await page.getByRole('dialog').getByRole('button', { name: 'Törlöm' }).click();
      await page.getByText('Törölted a jelölést.').waitFor();
      await page.waitForTimeout(400);
      await shoot(page, `feedback-delete-done-${width}`, { widths: [width] });
      await page.close();
    });
  }
};
