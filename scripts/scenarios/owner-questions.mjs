/**
 * Screenshots for PM-1192 (docs/SCREENSHOTS.md): the weekly question measure in the Operator panel: its entry,
 * a week with questions opened, a zero week opened, and the empty state.
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

export default async ({ open, shoot, step }) => {
  let answer = BUSY;
  const openPanel = async () => {
    const page = await open({ path: '/p/AC', width: 1512 });
    await page.route(
      (url) => url.pathname === '/api/projects/AC/operator/owner-questions',
      (route) =>
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) }),
    );
    await page.waitForSelector('[data-operator-button]');
    await page.click('[data-operator-button]');
    await page.waitForSelector('#operator-panel textarea');
    return page;
  };
  const openWeekly = async (page) => {
    await page.getByRole('button', { name: /^Heti/ }).click();
    await page.locator('#operator-panel details').first().waitFor();
  };

  await step('a. the entry in the Operator panel', async () => {
    const page = await openPanel();
    await page.getByRole('button', { name: /^Heti/ }).waitFor();
    await shoot(page, 'a-entry', { widths: WIDTHS });
  });

  await step('b. the current week opened', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await shoot(page, 'b-weeks', { widths: WIDTHS });
    await page.locator('#operator-panel details > summary').first().click();
    await shoot(page, 'c-week-open', { widths: WIDTHS });
  });

  await step('d. a zero week opened', async () => {
    const page = await openPanel();
    await openWeekly(page);
    await page.locator('#operator-panel details > summary').nth(1).click();
    await shoot(page, 'd-zero-week', { widths: WIDTHS });
  });

  await step('e. nothing reached the owner', async () => {
    answer = EMPTY;
    const page = await openPanel();
    await openWeekly(page);
    await shoot(page, 'e-empty', { widths: WIDTHS });
  });
};
