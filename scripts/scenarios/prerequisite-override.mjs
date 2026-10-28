/**
 * Screenshots for PM-1099 (docs/SCREENSHOTS.md): Settings → Team → "Nyitott előfeltétel felülbírálása", whether
 * the project manager may start a card despite an open prerequisite. The real UI on the real demo project; the
 * setting changes through the configuration API.
 *
 *   a. the default: unticked, the humans-only sentence shows   1512
 *   b. ticked                                                  1512
 *   c. ticked                                                  390
 *   d. read only, as a member who may not manage the team      1512, 390
 *
 * The team without a project manager cannot be built on the demo project (a project always has one); the
 * `noProjectManager` line is the only difference and is covered by the web tests.
 *
 *   npm run shots -- scripts/scenarios/prerequisite-override.mjs --widths 1512,390
 */

async function overrideGroup(page) {
  await page.waitForSelector('#settings-prerequisite-override-title');
  await page.evaluate(() =>
    document.getElementById('settings-prerequisite-override-title')?.scrollIntoView(),
  );
}

export default async ({ instance, open, shoot, step }) => {
  const patch = async (body) => {
    const view = await instance.api('/api/projects/AC/config');
    return instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: view.version, ...body },
    });
  };

  await step('a: the default', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await overrideGroup(page);
    await shoot(page, 'a-default', {
      widths: [1512],
      highlight: '#settings-prerequisite-override-title',
    });
  });

  await step('b, c: ticked', async () => {
    await patch({ prerequisiteOverride: 'people_and_project_manager' });
    const page = await open({ path: '/p/AC/settings/team' });
    await overrideGroup(page);
    await shoot(page, 'b-ticked', {
      widths: [1512, 390],
      highlight: '#settings-prerequisite-override-title',
    });
  });

  await step('d: read only', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    const page = await open({ as: colleague, path: '/p/AC/settings/team' });
    await overrideGroup(page);
    await shoot(page, 'd-read-only', {
      widths: [1512, 390],
      highlight: '#settings-prerequisite-override-title',
    });
  });
};
