/**
 * Screenshots for PM-1192 (docs/SCREENSHOTS.md): the weekly question measure in the Operator panel: its entry,
 * an opened week and an opened zero week, loading, empty, the failures, no access, the method, the focus after
 * going back, and the dark theme.
 *
 * The demo project has no owner questions over weeks, so the browser is told the weekly report
 * (`/operator/owner-questions`); everything else is the real UI on the real demo project.
 *
 *   npm run shots -- scripts/scenarios/owner-questions.mjs --widths 1512,390
 */

const WIDTHS = [1512, 390];
const DAY_MS = 24 * 60 * 60 * 1000;
const ROUTES = [
  'decision',
  'owner_todo',
  'integrator_fallback',
  'integrator_escalated',
  'screening_fallback',
  'project_manager',
  'reask',
  'unscreened',
];

/** ISO week number of a UTC date. */
function isoWeek(date) {
  const thursday = new Date(date.getTime() + (4 - (date.getUTCDay() || 7)) * DAY_MS);
  const yearStart = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  return Math.ceil(((thursday.getTime() - yearStart) / DAY_MS + 1) / 7);
}

/** Eight weeks, newest first, with the given counts (zero where not given). */
function report(samples) {
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  const day = (date) => date.toISOString().slice(0, 10);
  return {
    timezone: 'Europe/Budapest',
    weeks: Array.from({ length: 8 }, (_, index) => {
      const start = new Date(monday.getTime() - index * 7 * DAY_MS);
      const sample = samples[index] ?? {};
      const byRoute = Object.fromEntries(ROUTES.map((route) => [route, sample.byRoute?.[route] ?? 0]));
      const total = Object.values(byRoute).reduce((sum, count) => sum + count, 0);
      return {
        weekStart: day(start),
        weekEnd: day(new Date(start.getTime() + 6 * DAY_MS)),
        isoWeek: isoWeek(start),
        total,
        byRoute,
        byTopic: sample.byTopic ?? {},
        answeredByOwner: sample.answeredByOwner ?? 0,
        answeredByIntegrator: sample.answeredByIntegrator ?? 0,
        integratorTodos: sample.integratorTodos ?? 0,
        open: total - (sample.answeredByOwner ?? 0) - (sample.answeredByIntegrator ?? 0),
      };
    }),
  };
}

const BUSY = report([
  {
    byRoute: { decision: 2, integrator_fallback: 1, project_manager: 1, unscreened: 1 },
    byTopic: { cost: 2, product_direction: 1, approval: 1, unknown: 1 },
    answeredByOwner: 2,
    answeredByIntegrator: 2,
    integratorTodos: 3,
  },
  { integratorTodos: 1 },
  {
    byRoute: { decision: 3, owner_todo: 1, reask: 1 },
    byTopic: { risk_acceptance: 2, external_party: 1, approval: 2 },
    answeredByOwner: 4,
    answeredByIntegrator: 1,
    integratorTodos: 2,
  },
  { byRoute: { unscreened: 4 }, byTopic: { unknown: 4 }, answeredByOwner: 3, answeredByIntegrator: 1 },
  { byRoute: { unscreened: 2 }, byTopic: { unknown: 2 }, answeredByOwner: 2 },
]);
const EMPTY = report([]);

const failure = (code) => ({ error: { code, message: code } });

export default async ({ open, shoot, step }) => {
  // What the browser is told: the answer, its status, and a hold that keeps it loading until released.
  const state = { body: BUSY, status: 200, hold: null };
  const openPanel = async () => {
    const page = await open({ path: '/p/AC', width: 1512 });
    await page.route(
      (url) => url.pathname === '/api/projects/AC/operator/owner-questions',
      async (route) => {
        if (state.hold) await state.hold;
        const body =
          state.status === 200 ? state.body : failure(state.status === 403 ? 'forbidden' : 'internal');
        await route.fulfill({
          status: state.status,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      },
    );
    await page.waitForSelector('[data-operator-button]');
    await page.click('[data-operator-button]');
    await page.waitForSelector('#operator-panel textarea');
    return page;
  };
  const entry = (page) => page.getByRole('button', { name: /^Heti/ });
  const panel = (page) => page.locator('#operator-panel');
  const openWeekly = async (page, waitFor = '#operator-panel details > summary') => {
    await entry(page).click();
    await page.locator(waitFor).first().waitFor({ timeout: 20_000 });
  };
  const week = (page, index) => panel(page).locator('details > summary').nth(index);

  await step('a. the entry in the Operator panel', async () => {
    const page = await openPanel();
    await entry(page).waitFor();
    await shoot(page, 'a-entry', { widths: WIDTHS });
  });

  await step('b. the current week opened: routes, then topics and integrator todos', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await week(page, 0).click();
    await shoot(page, 'b-week-open', { widths: WIDTHS });
    await panel(page).getByText('Integrátori teendők').first().scrollIntoViewIfNeeded();
    await shoot(page, 'b-week-topics', { widths: WIDTHS });
  });

  await step('c. a zero week with an integrator todo opened', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await week(page, 1).click();
    await shoot(page, 'c-zero-week', { widths: WIDTHS });
  });

  await step('d. loading', async () => {
    let release;
    state.hold = new Promise((done) => (release = done));
    const page = await openPanel();
    await openWeekly(page, '#operator-panel [role="status"]:has-text("betöltése")');
    await shoot(page, 'd-loading', { widths: WIDTHS });
    state.hold = null;
    release();
  });

  await step('e. nothing reached the owner in eight weeks', async () => {
    state.body = EMPTY;
    const page = await openPanel();
    await openWeekly(page);
    await shoot(page, 'e-empty', { widths: WIDTHS });
    state.body = BUSY;
  });

  await step('f. the first load fails', async () => {
    state.status = 500;
    const page = await openPanel();
    await openWeekly(page, 'text=A heti mérés most nem tölthető be.');
    await shoot(page, 'f-failed', { widths: WIDTHS });
    state.status = 200;
  });

  await step('g. a refresh fails and the data stays', async () => {
    const page = await openPanel();
    await openWeekly(page);
    state.status = 500;
    await panel(page).getByRole('button', { name: 'Frissítés' }).click();
    await panel(page).getByText('A frissítés nem sikerült', { exact: false }).waitFor({ timeout: 20_000 });
    await shoot(page, 'g-stale', { widths: WIDTHS });
    state.status = 200;
  });

  await step('h. no access', async () => {
    state.status = 403;
    const page = await openPanel();
    await openWeekly(page, 'text=A heti mérést csak a projekt tulajdonosa láthatja');
    await shoot(page, 'h-denied', { widths: WIDTHS });
    state.status = 200;
  });

  await step('i. how it is counted, opened', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await panel(page).getByText('Hogyan számoljuk?').click();
    // The highlight scrolls the method into view at each width.
    await shoot(page, 'i-method', { widths: WIDTHS, highlight: 'text=Hogyan számoljuk? >> visible=true' });
  });

  await step('j. back to the conversation by keyboard: the focus is on the entry', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await panel(page).getByRole('button', { name: 'Vissza a beszélgetéshez' }).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith('Heti'));
    await shoot(page, 'j-focus-back', { widths: WIDTHS });
  });

  await step('k. the data, dark theme', async () => {
    const page = await openPanel();
    await page.emulateMedia({ colorScheme: 'dark' });
    await openWeekly(page);
    await week(page, 0).click();
    await shoot(page, 'k-dark', { widths: [390] });
  });
};
