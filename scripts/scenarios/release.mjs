/**
 * Scenario for PM-492 (docs/SCREENSHOTS.md): the release on the screen. The release items, the alerts and the
 * `release_changed` rows are laid over the real server's answers (the way `merge.mjs` does), so every state is shot
 * without a real deploy. It shoots, at 1512 and 390 px:
 *
 *   a. the inbox: the release with 23 cards (closed and open), with 3 cards, without a previous version
 *   b. the reject box, and the refusal of an integrator's key (owner_approval_required)
 *   c. "Mostanában döntöttél" with the decided release
 *   d. the four alerts of a failed release
 *   e. the timeline of a release card with every state, and of a rejected one
 *   f. the dark theme: the release item and the alert
 *
 *   npm run shots -- scripts/scenarios/release.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: inbox.release, inbox.options).
const TEXT = {
  title: 'Élesre mehet ez a kiadás?',
  summaryMore: 'Teljes összefoglaló',
  cardsMore: 'Még 17 kártya',
  approve: 'Jóváhagyom',
  reject: 'Elutasítom',
  rejectLabel: 'Miért utasítod el?',
  recent: 'Mostanában döntöttél',
  timeline: 'Idővonal',
  alertDown: 'Élesítés közben leállt az élő rendszer',
};
const WIDTHS = [1512, 390];
const hex = (seed) => seed.repeat(40).slice(0, 40);
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

const SUMMARY = [
  '## Highlights',
  '',
  '- Faster board loading: the board no longer waits for the timeline of every card.',
  '- The release is approved in the inbox, with the cards that are in it.',
  '- Fixes the login redirect after a long pause.',
  '',
  '## Fixes',
  '',
  '- The merge request no longer disappears when its proposer is retired.',
  '- A rejected approval keeps its reason on the card.',
  '- The deploy log is trimmed to the last 40 lines.',
  '',
  '## Upgrade notes',
  '',
  'No configuration change is needed. The database is migrated on start.',
].join('\n');

const TITLES = [
  'Add tiered shipping rates',
  'Show delivery estimates',
  'Add a wish list',
  'Save the cart for later',
  'Round the order totals',
  'Validate the postcode',
  'Send the order confirmation e-mail',
  'Show the gift wrap option',
  'Total the gift wrap fee',
  'Show the shipping countdown',
  'Let the shopper change the delivery date after the order has been paid for and confirmed by e-mail',
  'Fix the cart badge on the phone',
  'Remember the last used address',
  'Add a coupon field to the checkout',
  'Show stock levels on the product page',
  'Sort the order history by date',
  'Export the invoices as PDF',
  'Translate the checkout errors',
  'Speed up the product search',
  'Show the carrier logo',
  'Add the VAT line to the invoice',
  'Fix the double click on Pay',
  'Keep the filter after a reload',
];
const cardsOf = (count) =>
  TITLES.slice(0, count).map((title, index) => ({ key: `AC-${200 + index}`, title }));

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const owner = config.team.members.find((member) => member.kind === 'human').handle;
  const devops = config.team.members.find((member) => member.kind === 'ai')?.handle ?? 'system';
  log(`the owner ${owner}, the proposer ${devops}`);

  const theme = async (title) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, kind: 'theme', description: 'Fictional Acme webshop release.' },
      })
    ).key;
  const big = { key: await theme('Release 20446268'), commit: hex('9c1e7a42'), base: hex('20446268') };
  const small = { key: await theme('Release 5d0be3f1'), commit: hex('5d0be3f1'), base: null };
  const rejected = { key: await theme('Release 7a77c0de'), commit: hex('7a77c0de'), base: hex('9c1e7a42') };
  const history = { key: await theme('Release 20446268 history'), commit: hex('9c1e7a42') };

  const releaseItem = (card, tasks, extra = {}) => ({
    id: `inb-${card.key}-release`,
    projectKey: 'AC',
    kind: 'release',
    assignees: [owner],
    source: devops,
    sessionId: null,
    taskKey: card.key,
    title: `Release ${card.commit.slice(0, 8)}`,
    body: SUMMARY,
    payload: {
      release: {
        releaseId: `rel-${card.key}`,
        commit: card.commit,
        baseCommit: card.base,
        tasks,
        summary: SUMMARY,
      },
    },
    options: [
      { id: 'approve', label: 'approve', style: 'primary' },
      { id: 'reject', label: 'reject', style: 'danger' },
    ],
    state: 'open',
    resolution: null,
    createdAt: ago(12),
    ...extra,
  });
  const alertItem = (id, step, rolledBack, minutes) => ({
    id: `inb-alert-${id}`,
    projectKey: 'AC',
    kind: 'alert',
    assignees: [owner],
    source: 'system',
    sessionId: null,
    taskKey: history.key,
    title: `Release failed in ${step}`,
    body: null,
    payload: {
      alert: 'release_failed',
      releaseId: `rel-${id}`,
      taskKey: history.key,
      commit: history.commit,
      step,
      message: `[${step}] exited with code 1\n> npm run build\nerror TS2322: Type 'string' is not assignable to type 'number'.\n  src/cart/totals.ts(41,7)`,
      rolledBack,
    },
    options: [{ id: 'seen', label: 'seen', style: 'primary' }],
    state: 'open',
    resolution: null,
    createdAt: ago(minutes),
  });

  const inbox = [
    releaseItem(big, cardsOf(23)),
    releaseItem(small, cardsOf(3), { createdAt: ago(30) }),
    releaseItem(rejected, cardsOf(2), {
      createdAt: ago(240),
      state: 'resolved',
      resolution: { optionId: 'reject', by: owner, at: ago(200), note: 'Várjuk meg vele a PM-490-et.' },
    }),
    alertItem('early', 'build', false, 50),
    alertItem('rolledback', 'verify', true, 45),
    alertItem('down', 'switch', false, 40),
    alertItem('publish', 'publish', false, 35),
  ];

  const row = (
    card,
    index,
    minutes,
    state,
    previousState,
    data = {},
    actor = { kind: 'system', handle: null },
  ) => ({
    id: `evt-${card.key}-${index}`,
    projectKey: 'AC',
    taskKey: card.key,
    sessionId: null,
    actor,
    type: 'release_changed',
    data: { releaseId: `rel-${card.key}`, state, previousState, commit: card.commit, ...data },
    createdAt: ago(minutes),
  });
  const human = { kind: 'human', handle: owner };
  const proposer = { kind: 'ai', handle: devops };
  const failure = (step, rolledBack) => ({
    step,
    rolledBack,
    message: `[${step}] exited with code 1\nerror TS2322: Type 'string' is not assignable to type 'number'.`,
  });
  const events = {
    [history.key]: [
      row(history, 0, 120, 'proposed', null, {}, proposer),
      row(history, 1, 118, 'approved', 'proposed', {}, human),
      row(history, 2, 117, 'deploying', 'approved'),
      row(history, 3, 115, 'failed', 'deploying', { failure: failure('build', false) }),
      row(history, 4, 90, 'deploying', 'failed'),
      row(history, 5, 88, 'failed', 'deploying', { failure: failure('verify', true) }),
      row(history, 6, 60, 'deploying', 'failed'),
      row(history, 7, 58, 'failed', 'deploying', { failure: failure('switch', false) }),
      row(history, 8, 30, 'deploying', 'failed'),
      row(history, 9, 28, 'live', 'deploying', {
        publishError: 'HTTP 401 from api.github.com: bad credentials',
      }),
      row(history, 10, 5, 'published', 'live', {
        tag: 'v1.4.0',
        url: 'https://github.com/acme/webshop/releases/tag/v1.4.0',
      }),
    ],
    [rejected.key]: [
      row(rejected, 0, 240, 'proposed', null, {}, proposer),
      row(rejected, 1, 200, 'rejected', 'proposed', { note: 'Várjuk meg vele a PM-490-et.' }, human),
    ],
  };

  const state = { refuse: false };
  const page = await open({ path: '/p/AC' });

  await page.route(/\/api\/projects\/AC\/tasks\/AC-\d+(\?.*)?$/, async (route) => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    if (route.request().method() !== 'GET' || !events[key]) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const detail = await response.json();
    await route.fulfill({ response, json: { ...detail, timeline: [...detail.timeline, ...events[key]] } });
  });
  await page.route('**/api/projects/AC/inbox*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const view = await response.json();
    await route.fulfill({ response, json: { ...view, items: [...inbox, ...view.items] } });
  });
  await page.route(/\/api\/projects\/AC\/inbox\/[^/]+\/resolve$/, async (route) => {
    if (state.refuse) {
      await route.fulfill({
        status: 403,
        json: { error: { code: 'owner_approval_required', message: 'Only an owner approves a release' } },
      });
      return;
    }
    await route.continue();
  });

  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
  };
  const releaseCard = (key) =>
    page.locator('article').filter({ has: page.locator(`a[href$="/tasks/${key}"]`) });
  const shot = (name, highlight) => shoot(page, name, { widths: WIDTHS, highlight });

  await step(
    'a. the inbox: 23 cards closed, open, and the item with 3 cards and no previous version',
    async () => {
      await visit('/p/AC/inbox');
      await page.getByRole('heading', { name: TEXT.title }).first().waitFor();
      await shot('inbox');
      const first = releaseCard(big.key);
      await first.getByRole('button', { name: new RegExp(TEXT.summaryMore) }).click();
      await first.getByRole('button', { name: new RegExp(TEXT.cardsMore) }).click();
      await shoot(page, 'inbox-23-open', { widths: WIDTHS, fullPage: true });
    },
  );

  await step('b. the reject box and the refusal of an integrator key', async () => {
    await visit('/p/AC/inbox');
    const target = releaseCard(small.key);
    const frame = `article:has(a[href$="/tasks/${small.key}"])`;
    await target.getByRole('button', { name: TEXT.reject }).click();
    await target.getByLabel(new RegExp(TEXT.rejectLabel)).fill('Várjuk meg vele a PM-490-et.');
    await shoot(page, 'inbox-reject', { widths: WIDTHS, highlight: frame });
    await target.getByRole('button', { name: 'Mégse' }).click();
    state.refuse = true;
    await target.getByRole('button', { name: TEXT.approve }).click();
    await target.getByRole('alert').waitFor();
    await shoot(page, 'inbox-refused', { widths: WIDTHS, highlight: frame });
    state.refuse = false;
  });

  await step('c. the decided release in "Mostanában döntöttél"', async () => {
    await visit('/p/AC/inbox');
    await page.getByText(TEXT.recent).first().waitFor();
    await shoot(page, 'inbox-recent', { widths: WIDTHS });
  });

  await step('d. the four alerts of a failed release', async () => {
    await visit('/p/AC/inbox');
    await page.getByRole('heading', { name: TEXT.alertDown }).first().waitFor();
    for (const id of ['early', 'rolledback', 'down', 'publish'])
      await shoot(page, `alert-${id}`, {
        widths: WIDTHS,
        highlight: `article[data-alert="release_failed"] >> nth=${['early', 'rolledback', 'down', 'publish'].indexOf(id)}`,
      });
  });

  await step('e. the timeline of a release card, and of a rejected one', async () => {
    await visit(`/p/AC/tasks/${history.key}/timeline`);
    await page.getByText('Kiadva: v1.4.0').first().waitFor();
    await shot('timeline-all-states');
    await visit(`/p/AC/tasks/${rejected.key}/timeline`);
    await page.getByText('Elutasította a kiadást.').first().waitFor();
    await shot('timeline-rejected');
  });

  await step('f. the dark theme: the item and the alert', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await visit('/p/AC/inbox');
    await page.getByRole('heading', { name: TEXT.title }).first().waitFor();
    await shoot(page, 'inbox-dark', { widths: WIDTHS });
    await shoot(page, 'alert-down-dark', {
      widths: WIDTHS,
      highlight: 'article[data-severity="down"]',
    });
    await page.emulateMedia({ colorScheme: 'light' });
  });
};
