/**
 * PM-1475 (docs/SCREENSHOTS.md): the follow-ups of the device pairing screens. The instance has no machine that asks
 * for a code and sends no pairing notice, so the browser's answers of `/api/pairings/*`, the engine list and the
 * project's messages are replaced (`context.route`); the pages, their focus and the styles are the real ones.
 *
 *   1  Your machines with no machine: "Új gép" and "Párosítás kóddal" side by side
 *   2  the approval after a 429 on Jóváhagyom: the red bar with the countdown, the focus ring on the pressed button
 *   3  an engine_paired notice in Messages, with a machine name that holds Markdown
 *
 * Classic light and dark, 1512 and 390 px. `npm run shots -- apps/web/shots/device-pairing-followups.mjs --widths 1512,390`
 */

const CODE = 'WDJB-MJHT';
const MACHINE = '[katt](https://example.com) **x** https://example.com';

const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const failure = (code, details) => ({ error: { code, message: code, ...(details ? { details } : {}) } });

export default async ({ open, shoot, step, instance }) => {
  const mode = { decision: 'ok' };
  const page0 = await open({ path: '/', width: 1512 });
  const context = page0.context();

  await context.route('**/api/pairings/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'lookup')
      return json(route, 200, {
        state: 'pending',
        code: CODE,
        machineName: 'Mac mini',
        requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
        replacesKeyPrefix: null,
      });
    if (mode.decision === 'limit')
      return json(route, 429, failure('too_many_attempts', { retryAfterSeconds: 540 }));
    return json(route, 200, { state: 'denied', code: CODE, machineName: 'Mac mini' });
  });
  await context.route('**/api/engines/status', (route) =>
    json(route, 200, { mode: 'cloud', engines: [], projectEngines: {} }),
  );
  await context.route(/\/api\/engines$/, (route) =>
    route.request().method() === 'GET' ? json(route, 200, []) : route.fallback(),
  );
  await context.route(/\/api\/projects\/AC\/messages(\?.*)?$/, (route) =>
    route.request().method() === 'GET'
      ? json(route, 200, {
          messages: [
            {
              id: 'msg_shot_paired',
              projectKey: 'AC',
              from: 'pm',
              to: ['owner'],
              taskKey: null,
              body: 'Stored English text',
              kind: 'info',
              createdAt: new Date().toISOString(),
              deliveredAt: new Date().toISOString(),
              origin: {
                kind: 'system_notice',
                notice: 'engine_paired',
                params: { machine: MACHINE, prefix: 'pmi_a1b2c3d4', approver: 'Owner' },
              },
            },
          ],
          unreadCount: 1,
        })
      : route.fallback(),
  );

  const widths = [1512, 390];
  for (const scheme of ['light', 'dark']) {
    const prefix = `classic-${scheme}`;
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style: 'classic' } });

    await step(`${prefix}: Your machines with no machine`, async () => {
      const page = await open({ path: '/p/AC/settings/engines', width: 1512 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByRole('link', { name: 'Párosítás kóddal' }).waitFor();
      await shoot(page, `${prefix}-1-empty-engines`, { widths });
    });

    await step(`${prefix}: the approval after a 429`, async () => {
      mode.decision = 'limit';
      const page = await open({ path: '/pair', width: 1512 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByLabel('Kód').fill(CODE);
      await page.getByRole('button', { name: 'Tovább' }).click();
      const approve = page.getByRole('button', { name: 'Jóváhagyom' });
      await approve.waitFor();
      await approve.focus();
      await approve.click();
      await page.getByText('Túl sok próba', { exact: false }).first().waitFor();
      await shoot(page, `${prefix}-2-approve-limit`, { widths });
      mode.decision = 'ok';
    });

    await step(`${prefix}: the pairing notice in Messages`, async () => {
      const page = await open({ path: '/p/AC/messages/with/pm', width: 1512 });
      await page.emulateMedia({ colorScheme: scheme });
      await page.getByText('katt', { exact: false }).first().waitFor();
      await shoot(page, `${prefix}-3-notice`, { widths });
    });
  }
};
