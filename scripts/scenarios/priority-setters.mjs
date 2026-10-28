/**
 * Screenshots for PM-1096 (docs/SCREENSHOTS.md): Settings → Team → "Prioritás állítása", who besides people
 * may set a card's priority. The real UI on the real demo project; the settings change through the UI or the
 * configuration API.
 *
 *   a. the default: the project manager ticked, nobody holds the duty (the link shows)  1512, 390
 *   b. both ticked and a member holds the duty (the names show)                         390
 *   c. nothing ticked ("Most csak ember …")                                              1512
 *   d. read only, as a member who may not manage the team                                1512, 390
 *
 *   npm run shots -- scripts/scenarios/priority-setters.mjs --widths 1512,390
 */

async function priorityGroup(page) {
  await page.waitForSelector('#settings-priority-title');
  await page.evaluate(() => document.getElementById('settings-priority-title')?.scrollIntoView());
}

export default async ({ instance, open, shoot, step, log }) => {
  const patch = async (body) => {
    const view = await instance.api('/api/projects/AC/config');
    return instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: view.version, ...body },
    });
  };

  await step('a: the default', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await priorityGroup(page);
    await shoot(page, 'a-default', { widths: [1512, 390], highlight: '#settings-priority-title' });
  });

  await step('b: both ticked, a member holds the duty', async () => {
    const view = await instance.api('/api/projects/AC/config');
    const worker = view.config.team.members.find((m) => m.kind === 'ai' && m.role === 'developer');
    if (!worker) throw new Error('the demo project has no developer');
    const roles = await instance.api('/api/projects/AC/roles');
    const bundle = roles.roles.find((role) => role.id === worker.role);
    log(`worker: ${worker.handle}, duties: ${JSON.stringify(bundle?.duties)}`);
    await patch({
      roleOverrides: {
        [worker.role]: {
          duties: [...new Set([...(bundle?.duties ?? []), 'prioritization'])],
          instructions: bundle?.instructions ?? '',
        },
      },
      prioritySetters: ['project_manager', 'prioritization_duty'],
    });
    const page = await open({ path: '/p/AC/settings/team' });
    await priorityGroup(page);
    await shoot(page, 'b-both', { widths: [390], highlight: '#settings-priority-title' });
  });

  await step('c: nothing ticked', async () => {
    await patch({ prioritySetters: [] });
    const page = await open({ path: '/p/AC/settings/team' });
    await priorityGroup(page);
    await shoot(page, 'c-humans-only', { widths: [1512] });
  });

  await step('d: read only', async () => {
    await patch({ prioritySetters: ['project_manager', 'prioritization_duty'] });
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    const page = await open({ as: colleague, path: '/p/AC/settings/team' });
    await priorityGroup(page);
    await shoot(page, 'd-read-only', { widths: [1512, 390], highlight: '#settings-priority-title' });
  });
};
