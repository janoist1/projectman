import { hu } from '../../apps/web/src/i18n/hu.ts';

const t = (key, params = {}) =>
  key
    .split('.')
    .reduce((value, part) => value[part], hu)
    .replace(/\{(\w+)\}/g, (_, name) => String(params[name]));

/** PM-1101 design review: a–d. Real API data except the temp profile in d. */
const WIDTHS = [1512, 390];
export default async ({ instance, open, shoot, step }) => {
  const { config, version } = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      limits: {
        ...config.team.limits,
        tempWorkers: { ...config.team.limits.tempWorkers, enabled: true, max: 1, maxPoints: 8 },
      },
    },
  });
  const capture = async (page, name, focus) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 982 });
      if (focus) await focus.evaluate((node) => node.scrollIntoView({ block: 'center' }));
      await shoot(page, `${name}-viewport`, { widths: [width], fullPage: false });
      await shoot(page, name, { widths: [width], fullPage: true });
    }
  };
  await step('a-b. limits editor', async () => {
    const page = await open({ path: '/p/AC/settings/limits' });
    const select = page.getByLabel(hu.settings.edit.tempMaxPoints);
    await select.waitFor();
    await capture(page, 'ab-limits-edit', select);
    await select.selectOption('13');
    await page.waitForTimeout(800);
    await capture(page, 'ab-limits-edit-13', select);
    await select.selectOption('8');
    await page.waitForTimeout(800);
  });
  await step('c. read-only view', async () => {
    const developer = await instance.invite({
      project: 'AC',
      email: 'developer@acme.test',
      name: 'Demo Developer',
      access: 'developer',
    });
    const page = await open({ as: developer, path: '/p/AC/settings/limits' });
    const row = page.getByText(hu.settings.limits.tempWorkers, { exact: true }).first();
    await row.waitFor();
    await capture(page, 'c-limits-read', row);
  });
  await step('d. temp member dialog', async () => {
    const members = await instance.api('/api/projects/AC/members');
    const member = members.find((m) => m.kind === 'ai' && m.role === 'developer');
    if (!member) throw new Error('No developer');
    const page = await open({ path: `/p/AC/team/${member.handle}` });
    await page.route(`**/api/projects/AC/members/${member.handle}/profile`, async (route) => {
      const response = await route.fetch();
      const profile = await response.json();
      await route.fulfill({
        response,
        json: { ...profile, member: { ...profile.member, temp: true, complexityLimit: 8 } },
      });
    });
    await page.reload();
    await page.getByRole('button', { name: t('team.moreFor', { name: member.displayName }) }).click();
    await page.getByRole('button', { name: t('memberEdit.editMember', { name: member.displayName }) }).click();
    await page.getByRole('dialog').waitFor();
    await capture(page, 'd-temp-dialog', page.getByText(t('memberEdit.tempLimit', { points: 8 })));
  });
};
