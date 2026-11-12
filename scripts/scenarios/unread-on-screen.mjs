/**
 * Screenshots for PM-1386 (docs/SCREENSHOTS.md): a message counts as read once its "Olvasatlan" label has been on
 * the screen, not when the conversation opens. The label sits at the start of the content, also on a long message.
 * Classic and Win 3.11, light and dark, 1512 and 390 px (docs/design/style.md).
 *
 * The server and the fake CLIs are real, but a member's unread message needs a running turn, so the messages are
 * added to the thread answers in the browser (as `pm-places.mjs` does) and the read call is answered there too.
 *
 *   npm run shots -- scripts/scenarios/unread-on-screen.mjs --widths 1512,390 --timeout 600
 */

const WIDTHS = [1512, 390];
const STYLES = ['classic', 'win311'];
const SCHEMES = ['light', 'dark'];
const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const paragraphs = (count) =>
  Array.from(
    { length: count },
    (_, index) => `Paragraph ${index + 1}: the summary goes on with details about the card and what is left.`,
  ).join('\n\n');

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  const worker = members.find(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  if (!pm || !worker) throw new Error('the demo project has no project manager or worker');
  const owner = (await instance.api('/api/me')).handles.AC;
  log(`pm: ${pm.handle}, worker: ${worker.handle}, owner: ${owner}`);

  const json = (route, body, status = 200) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const unread = (id, from, body, createdAt) => ({
    id,
    projectKey: 'AC',
    from,
    to: [owner],
    taskKey: null,
    body,
    createdAt,
    deliveredAt: createdAt,
    receipts: [{ handle: owner, kind: 'human', deliveredAt: createdAt, readAt: null }],
  });

  const state = { messages: [], reads: [] };
  const attach = async (page, peer) => {
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages' && url.search.includes(`threadWith=${peer}`),
      async (route) => {
        if (route.request().method() !== 'GET') return route.fallback();
        const response = await route.fetch();
        const body = await response.json();
        json(route, { ...body, messages: [...body.messages, ...state.messages] }, response.status());
      },
    );
    await page.route(
      (url) => url.pathname === '/api/projects/AC/messages/read',
      (route) => {
        state.reads.push(route.request().postDataJSON().ids);
        json(route, { messages: [], unreadCount: 0 });
      },
    );
  };

  for (const style of STYLES) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of SCHEMES) {
      const name = `${style}-${scheme}`;

      await step(`${name}: a conversation opens with a long unread message, nothing read yet`, async () => {
        state.reads = [];
        state.messages = [
          unread('msg_unread_1', worker.handle, 'A short one first.', minutesAgo(30)),
          unread('msg_unread_2', worker.handle, paragraphs(14), minutesAgo(3)),
        ];
        const page = await open({ path: '/p/AC' });
        await page.emulateMedia({ colorScheme: scheme });
        await attach(page, worker.handle);
        await page.goto(new URL(`/p/AC/messages/with/${worker.handle}`, page.url()).href);
        await page.getByRole('log').waitFor();
        await page.waitForTimeout(400);
        await shoot(page, `${name}-thread`, { widths: WIDTHS });
        log(`${name}: reads right after opening: ${state.reads.length}`);
      });

      await step(`${name}: the manager panel shows the label at the start of the message`, async () => {
        state.reads = [];
        state.messages = [unread('msg_unread_pm', pm.handle, paragraphs(3), minutesAgo(2))];
        const page = await open({ path: '/p/AC' });
        await page.emulateMedia({ colorScheme: scheme });
        await attach(page, pm.handle);
        await page.goto(new URL('/p/AC', page.url()).href);
        await page.waitForSelector('[data-operator-button]');
        await page.click('[data-operator-button]');
        await page.waitForSelector('#operator-panel textarea');
        await page.waitForTimeout(300);
        await shoot(page, `${name}-panel`, { widths: WIDTHS });
      });
    }
  }
};
