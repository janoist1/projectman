/**
 * PM-1450 (docs/SCREENSHOTS.md): the device pairing page `/pair`, state by state. The instance has no machine that asks
 * for a code, so the browser's answers of `/api/pairings/*` are replaced (`context.route`); the page, its focus and the
 * styles are the real ones.
 *
 *   classic-light   every state: enter, wrong code, too many tries, approve (with and without a key to replace),
 *                   approve error, done, denied, expired, no right; Settings → Your machines (the button and a paired
 *                   row) and → Connected Claude (a paired key and its log), their lists faked the same way
 *   the other three style/scheme pairs (classic-dark, win311-light, win311-dark): wrong code, approve with a key, done
 *
 * Each at 1512 and 390 px. `npm run shots -- apps/web/shots/device-pairing.mjs --widths 1512,390 --timeout 480`
 */

const STYLES = ['classic', 'win311'];
const SCHEMES = ['light', 'dark'];
const CODE = 'WDJB-MJHT';

const json = (route, status, body) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const failure = (code, details) => ({ error: { code, message: code, ...(details ? { details } : {}) } });

export default async ({ open, shoot, step, instance }) => {
  /** What the machine's pairing answers: the lookup and the decisions. */
  const mode = { lookup: 'ok', decision: 'ok', replaces: null };
  const pending = () => ({
    state: 'pending',
    code: CODE,
    machineName: 'Mac mini',
    requestedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 8 * 60_000).toISOString(),
    replacesKeyPrefix: mode.replaces,
  });
  const decided = (state) => ({
    state,
    code: CODE,
    machineName: 'Mac mini',
    ...(state === 'approved' ? { engineId: 'eng_shot' } : {}),
    decidedAt: new Date().toISOString(),
  });

  const page0 = await open({ path: '/', width: 1512 });
  const context = page0.context();
  await context.route('**/api/pairings/*', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').at(-1);
    if (action === 'lookup') {
      if (mode.lookup === 'invalid') return json(route, 404, failure('pairing_code_invalid'));
      if (mode.lookup === 'limit')
        return json(route, 429, failure('too_many_attempts', { retryAfterSeconds: 540 }));
      if (mode.lookup === 'noRight') return json(route, 403, failure('owner_only'));
      return json(route, 200, pending());
    }
    if (mode.decision === 'fail') return json(route, 500, failure('internal_error'));
    if (mode.decision === 'invalid') return json(route, 404, failure('pairing_code_invalid'));
    return json(route, 200, decided(action === 'approve' ? 'approved' : 'denied'));
  });

  /** The settings pages that show a paired machine and key: the instance is a single machine, so cloud mode and the lists are faked. */
  const pairedEngine = {
    id: 'eng_abcdefghij12',
    name: 'Mac mini',
    isDefault: false,
    online: true,
    lastSeenAt: new Date().toISOString(),
    keyPrefix: 'pme_a1b2c3d4',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    createdBy: 'Owner',
    revokedAt: null,
    lastSeenIp: null,
    hostname: 'mac-mini.local',
    platform: 'darwin',
    version: null,
    versionMismatch: false,
    providers: [],
    runningSessions: 0,
    waitingStarts: 0,
    waitingMessages: 0,
    ownedByMe: true,
    paired: true,
  };
  const pairedKey = {
    id: 'ink_shot',
    prefix: 'pmi_a1b2c3d4',
    state: 'active',
    mode: 'super',
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    expiresAt: new Date(Date.now() + 365 * 86_400_000).toISOString(),
    lastUsedAt: null,
    lastUsedChannel: null,
    revokedAt: null,
    paired: true,
  };
  await context.route('**/api/engines/status', (route) =>
    json(route, 200, {
      mode: 'cloud',
      engines: [{ ...pairedEngine, keyPrefix: undefined }],
      projectEngines: { AC: pairedEngine.id },
    }),
  );
  await context.route(/\/api\/engines$/, (route) =>
    route.request().method() === 'GET' ? json(route, 200, [pairedEngine]) : route.fallback(),
  );
  await context.route('**/api/auth/integrator-keys', (route) =>
    route.request().method() === 'GET' ? json(route, 200, { keys: [pairedKey] }) : route.fallback(),
  );
  await context.route('**/api/auth/integrator-keys/audit*', (route) =>
    json(route, 200, {
      entries: [
        {
          seq: 1,
          keyId: pairedKey.id,
          action: 'created',
          prefix: pairedKey.prefix,
          mode: 'super',
          at: pairedKey.createdAt,
          paired: true,
        },
      ],
      nextBefore: null,
    }),
  );

  const openPair = async (scheme, width) => {
    const page = await open({ path: '/pair', width });
    await page.emulateMedia({ colorScheme: scheme });
    return page;
  };
  const enter = async (page) => {
    await page.getByLabel('Kód').fill(CODE);
    await page.getByRole('button', { name: 'Tovább' }).click();
  };
  const widths = [1512, 390];

  for (const style of STYLES) {
    await instance.api('/api/me/ui-style', { method: 'PUT', body: { style } });
    for (const scheme of SCHEMES) {
      const prefix = `${style}-${scheme}`;
      const full = prefix === 'classic-light';
      Object.assign(mode, { lookup: 'ok', decision: 'ok', replaces: 'pmi_a1b2c3d4' });

      if (full) {
        await step(`${prefix}: Your machines, with the pairing button and a paired row`, async () => {
          const page = await open({ path: '/p/AC/settings/engines', width: 1512 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.getByRole('link', { name: 'Párosítás kóddal' }).waitFor();
          await shoot(page, `${prefix}-12-engines`, { widths });
        });
        await step(`${prefix}: the connected Claude, a paired key and its log`, async () => {
          const page = await open({ path: '/p/AC/settings/integrator', width: 1512 });
          await page.emulateMedia({ colorScheme: scheme });
          await page.getByText('párosítással').first().waitFor();
          await shoot(page, `${prefix}-13-integrator`, { widths });
        });
      }

      if (full)
        await step(`${prefix}: the empty code step`, async () => {
          const page = await openPair(scheme, 1512);
          await page.getByLabel('Kód').waitFor();
          await shoot(page, `${prefix}-1-enter`, { widths });
        });

      await step(`${prefix}: a wrong code`, async () => {
        mode.lookup = 'invalid';
        const page = await openPair(scheme, 1512);
        await enter(page);
        await page.getByText('Ez a kód nem érvényes', { exact: false }).waitFor();
        await shoot(page, `${prefix}-2-wrong`, { widths });
        mode.lookup = 'ok';
      });

      if (full)
        await step(`${prefix}: too many tries`, async () => {
          mode.lookup = 'limit';
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('button', { name: /Próbáld újra/ }).waitFor();
          await shoot(page, `${prefix}-3-too-many`, { widths });
          mode.lookup = 'ok';
        });

      await step(`${prefix}: approve, with a key to replace`, async () => {
        const page = await openPair(scheme, 1512);
        await enter(page);
        await page.getByRole('button', { name: 'Jóváhagyom' }).waitFor();
        await shoot(page, `${prefix}-5-approve-key`, { widths });
      });

      if (full) {
        await step(`${prefix}: approve, without a key`, async () => {
          mode.replaces = null;
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('button', { name: 'Jóváhagyom' }).waitFor();
          await shoot(page, `${prefix}-5-approve-new`, { widths });
          mode.replaces = 'pmi_a1b2c3d4';
        });

        await step(`${prefix}: an approval that failed`, async () => {
          mode.decision = 'fail';
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('button', { name: 'Jóváhagyom' }).click();
          await page.getByRole('alert').waitFor();
          await shoot(page, `${prefix}-7-approve-error`, { widths });
          mode.decision = 'ok';
        });
      }

      await step(`${prefix}: done`, async () => {
        const page = await openPair(scheme, 1512);
        await enter(page);
        await page.getByRole('button', { name: 'Jóváhagyom' }).click();
        await page.getByRole('heading', { name: 'A gép párosítva' }).waitFor();
        await shoot(page, `${prefix}-8-done`, { widths });
      });

      if (full) {
        await step(`${prefix}: denied`, async () => {
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('button', { name: 'Elutasítom' }).click();
          await page.getByRole('heading', { name: 'Elutasítva' }).waitFor();
          await shoot(page, `${prefix}-9-denied`, { widths });
        });

        await step(`${prefix}: expired`, async () => {
          mode.decision = 'invalid';
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('button', { name: 'Jóváhagyom' }).click();
          await page.getByRole('heading', { name: 'A kód lejárt' }).waitFor();
          await shoot(page, `${prefix}-10-expired`, { widths });
          mode.decision = 'ok';
        });

        await step(`${prefix}: no right`, async () => {
          mode.lookup = 'noRight';
          const page = await openPair(scheme, 1512);
          await enter(page);
          await page.getByRole('heading', { name: /nem hagyhatod jóvá/ }).waitFor();
          await shoot(page, `${prefix}-11-no-right`, { widths });
          mode.lookup = 'ok';
        });
      }
    }
  }
};
