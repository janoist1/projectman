/**
 * Screenshots for PM-1390 (docs/SCREENSHOTS.md): Settings → Team → "Beolvasztó", the merge-after-approval
 * switch (team.mergeAfterReview, PM-1379).
 *
 *   a. owner, code reviewer merges, the switch off                              1512, 390
 *   b. owner, the switch on after the click and the save                        1512, 390
 *   c. owner, the card's developer merges: the "no effect now" line is shown    1512, 390
 *   d. developer (may not manage the team), read only, with the switch's value  1512, 390
 *
 *   npm run shots -- scripts/scenarios/merge-after-review.mjs --widths 1512,390
 */

export default async ({ instance, open, shoot, step }) => {
  const patch = async (body) => {
    const { version } = await instance.api('/api/projects/AC/config');
    await instance.api('/api/projects/AC/config', {
      method: 'PATCH',
      body: { baseVersion: version, ...body },
    });
  };
  // Load the actual locale through Vite; UI wording stays in the hu locale.
  const first = await open({});
  const ui = await first.evaluate(async () => (await import('/src/i18n/hu/index.ts')).hu);
  const copy = ui.settings.team.mergeAfterReview;
  const group = async (page) => {
    await page.waitForSelector('#settings-merger-title');
    await page.evaluate(() => document.getElementById('settings-merger-title')?.scrollIntoView());
  };
  const settled = (page) => page.waitForFunction(() => !document.querySelector('fieldset[aria-busy="true"]'));
  const admin = await instance.invite({
    project: 'AC',
    email: 'dani-developer@example.test',
    name: 'Dani Fejlesztő',
    access: 'developer',
  });

  await step('a: owner, the switch off', async () => {
    await patch({ merger: { kind: 'code_reviewer' }, mergeAfterReview: false });
    const page = await open({ path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'a-off', { highlight: '#settings-merger-title' });
  });

  await step('b: owner turns the switch on', async () => {
    const page = await open({ path: '/p/AC/settings/team' });
    await group(page);
    await page.getByRole('checkbox', { name: new RegExp(copy.question) }).check();
    await settled(page);
    await shoot(page, 'b-on', { highlight: '#settings-merger-title' });
  });

  await step('c: the developer merges, no effect now', async () => {
    await patch({ merger: { kind: 'developer' } });
    const page = await open({ path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'c-no-effect', { highlight: '#settings-merger-title' });
  });

  await step('d: developer, read only', async () => {
    await patch({ merger: { kind: 'code_reviewer' } });
    const page = await open({ as: admin, path: '/p/AC/settings/team' });
    await group(page);
    await shoot(page, 'd-read-only', { highlight: '#settings-merger-title' });
  });
};
