/**
 * Screenshots for PM-1392 (docs/SCREENSHOTS.md): Settings → Team → "Tag bevonása a kártyára", whether the project
 * manager may bring a member in on a card, and its line in How we work. The real UI on the real demo project; the
 * setting changes through the configuration API.
 *
 *   a. the default: unticked, the humans-only sentence shows   1512, 390
 *   b. ticked                                                  1512, 390
 *   c. read only, as a member who may not manage the team      1512, 390
 *   d. How we work, the project manager's rights panel, both values   1512
 *
 *   npm run shots -- scripts/scenarios/member-involvement.mjs --widths 1512,390
 */

async function involvementGroup(page) {
  await page.waitForSelector('#settings-member-involvement-title');
  await page.evaluate(() => document.getElementById('settings-member-involvement-title')?.scrollIntoView());
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
    await involvementGroup(page);
    await shoot(page, 'a-default', {
      widths: [1512, 390],
      highlight: '#settings-member-involvement-title',
    });
    const rules = await open({ path: '/p/AC/how-we-work?show=rule:project_manager_rights' });
    await rules.getByRole('heading', { name: 'A projektmenedzser jogai' }).waitFor();
    await shoot(rules, 'd-rules-people', { widths: [1512] });
  });

  await step('b: ticked', async () => {
    await patch({ memberInvolvement: 'people_and_project_manager' });
    const page = await open({ path: '/p/AC/settings/team' });
    await involvementGroup(page);
    await shoot(page, 'b-ticked', {
      widths: [1512, 390],
      highlight: '#settings-member-involvement-title',
    });
    const rules = await open({ path: '/p/AC/how-we-work?show=rule:project_manager_rights' });
    await rules.getByRole('heading', { name: 'A projektmenedzser jogai' }).waitFor();
    await shoot(rules, 'd-rules-project-manager', { widths: [1512] });
  });

  await step('c: read only', async () => {
    const colleague = await instance.invite({
      project: 'AC',
      email: 'dana@acme.test',
      name: 'Dana Dev',
      access: 'developer',
    });
    const page = await open({ as: colleague, path: '/p/AC/settings/team' });
    await involvementGroup(page);
    await shoot(page, 'c-read-only', {
      widths: [1512, 390],
      highlight: '#settings-member-involvement-title',
    });
  });
};
