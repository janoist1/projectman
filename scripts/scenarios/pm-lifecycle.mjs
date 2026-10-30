/**
 * Screenshots for PM-1098 (docs/SCREENSHOTS.md): Settings → Team → "Kiosztás, megszakítás, újranyitás", what the
 * project manager may do to a card's life on its own. The real UI on the real demo project; the setting changes
 * through the configuration API.
 *
 *   a. the default: assign and cancel ticked                              1512
 *   b. the same                                                           390
 *   c. nothing ticked ("Most mindhármat csak admin …")                     1512
 *   d. no project manager in the team ("Most nincs Projektmenedzser …")   1512 (the PM is left out in the browser)
 *   e. read only, as a member who may not manage the team, the default    1512
 *   f. read only, nothing ticked ("Egyiket sem")                          390
 *   g. a card's timeline: reopened with a reason                          1512 (the reason is added in the browser:
 *      the REST reopen takes none, only the PM's reopen_task does)
 *
 *   npm run shots -- scripts/scenarios/pm-lifecycle.mjs --widths 1512,390
 */

const GROUP = '#settings-pm-lifecycle-title';
const REASON = 'Mégis kell: a megrendelő újra kérte';

async function lifecycleGroup(page) {
  await page.waitForSelector(GROUP);
  await page.evaluate((id) => document.querySelector(id)?.scrollIntoView(), GROUP);
}

/** Every `reopened` action in a response gets the reason, wherever the timeline sits in it. */
function withReason(value) {
  if (Array.isArray(value)) return value.map(withReason);
  if (value && typeof value === 'object') {
    const copy = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withReason(v)]));
    return copy.action === 'reopened' && !copy.reason ? { ...copy, reason: REASON } : copy;
  }
  return value;
}

export default async ({ instance, open, shoot, step, log }) => {
  const patch = async (body) => {
    const view = await instance.api('/api/projects/AC/config');
    return instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: view.version, ...body },
    });
  };

  await step('a, b: the default', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await lifecycleGroup(page);
    await shoot(page, 'a-default', { widths: [1512], highlight: GROUP });
    await shoot(page, 'b-default', { widths: [390], highlight: GROUP });
  });

  await step('c: nothing ticked', async () => {
    await patch({ projectManagerLifecycle: [] });
    const page = await open({ path: '/p/AC/settings/team' });
    await lifecycleGroup(page);
    await shoot(page, 'c-admins-only', { widths: [1512] });
  });

  await step('d: no project manager', async () => {
    await patch({ projectManagerLifecycle: ['assign', 'cancel'] });
    const page = await open({ path: '/p/AC/settings/team' });
    await page.route('**/api/projects/AC/config', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const view = await response.json();
      view.config.team.members = view.config.team.members.filter(
        (member) => !(member.kind === 'ai' && member.role === 'project_manager'),
      );
      return route.fulfill({ response, json: view });
    });
    await page.reload();
    await lifecycleGroup(page);
    await shoot(page, 'd-no-project-manager', { widths: [1512] });
  });

  await step('e, f: read only', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    const page = await open({ as: colleague, path: '/p/AC/settings/team' });
    await lifecycleGroup(page);
    await shoot(page, 'e-read-only', { widths: [1512], highlight: GROUP });
    await patch({ projectManagerLifecycle: [] });
    const empty = await open({ as: colleague, path: '/p/AC/settings/team' });
    await lifecycleGroup(empty);
    await shoot(empty, 'f-read-only-none', { widths: [390], highlight: GROUP });
    await patch({ projectManagerLifecycle: ['assign', 'cancel'] });
  });

  await step('g: reopened with a reason', async () => {
    const tasks = await instance.api('/api/projects/AC/tasks');
    const card = tasks.find((task) => task.status !== 'cancelled' && task.type !== 'theme') ?? tasks[0];
    log(`card: ${card.key}`);
    await instance.api(`/api/projects/AC/tasks/${card.key}/cancel`, {
      method: 'POST',
      body: { reason: 'Tárgytalan' },
    });
    await instance.api(`/api/projects/AC/tasks/${card.key}/reopen`, { method: 'POST', body: {} });
    // The card opens in a side panel; its story (a reopening is an essence event) sits on the "Folyamat" tab.
    const page = await open({ path: `/p/AC/tasks/${card.key}/steps` });
    await page.route(`**/api/projects/AC/tasks/${card.key}**`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const response = await route.fetch();
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json')) return route.fulfill({ response });
      return route.fulfill({ response, json: withReason(await response.json()) });
    });
    await page.reload();
    await page.getByText(REASON, { exact: false }).first().waitFor();
    await page.getByText(REASON, { exact: false }).first().scrollIntoViewIfNeeded();
    await shoot(page, 'g-timeline-reopened', { widths: [1512] });
  });
};
