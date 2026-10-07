/**
 * Scenario for PM-355 (docs/SCREENSHOTS.md): the outbound network setting of an AI member.
 *
 *   a. the profile as the owner, network on (the default)
 *   b. the profile after the owner switched it off (Claude: refused, not asked)
 *   c. the profile as a developer who is not the owner (text only, no checkbox)
 *   d. the hire dialog as the owner with "Részletek" open, and as a non-owner
 *
 *   npm run shots -- scripts/scenarios/outbound-network.mjs [--widths 1512,390]
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts: permissionLevel, hire).
const TEXT = {
  network: 'Kimenő hálózat',
  settings: 'Beállítások',
  hire: 'AI-tag felvétele',
  details: 'Részletek',
};
const WIDTHS = [1512, 390];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  if (!developer) throw new Error('The demo project needs an AI developer.');
  const profilePath = `/p/AC/team/${developer.handle}`;
  const colleague = await instance.invite({
    project: 'AC',
    email: 'dana@acme.test',
    name: 'Dana Dev',
    access: 'developer',
  });

  // The permission settings sit in the collapsed "Beállítások" section of the profile.
  const openSettings = async (page) => {
    await page.getByText(TEXT.settings, { exact: true }).first().click();
  };

  await step('a. the profile as the owner, network on', async () => {
    const page = await open({ path: profilePath });
    await openSettings(page);
    await page.getByLabel(TEXT.network).waitFor();
    await shoot(page, 'a-profile-on', { widths: WIDTHS, highlight: `label:has-text("${TEXT.network}")` });
  });

  await step('b. the owner switches it off', async () => {
    const page = await open({ path: profilePath });
    await openSettings(page);
    // The box changes when the server has answered, so click it instead of `uncheck` (which expects it at once).
    await page.getByLabel(TEXT.network).click();
    await page.getByText('kimenő hálózata: ki', { exact: false }).first().waitFor();
    const saved = (await instance.api('/api/projects/AC/members')).find((m) => m.handle === developer.handle);
    log(`outboundNetwork after the click: ${saved.outboundNetwork}`);
    await shoot(page, 'b-profile-off', { widths: WIDTHS, highlight: `label:has-text("${TEXT.network}")` });
  });

  await step('b2. a Codex member with a human approver asks for other addresses', async () => {
    const codexMember = members.find((m) => m.kind === 'ai' && m.handle !== developer.handle);
    if (!codexMember) throw new Error('The demo project needs a second AI member.');
    await instance.api(`/api/projects/AC/members/${codexMember.handle}`, {
      method: 'PATCH',
      body: { provider: 'codex', model: 'gpt-5.5', approver: 'human', outboundNetwork: false },
    });
    const page = await open({ path: `/p/AC/team/${codexMember.handle}` });
    await openSettings(page);
    await page.getByLabel(TEXT.network).waitFor();
    await shoot(page, 'b2-profile-codex-off-asks', {
      widths: WIDTHS,
      highlight: `label:has-text("${TEXT.network}")`,
    });
  });

  await step('c. the profile as a developer who is not the owner', async () => {
    const page = await open({ as: colleague, path: profilePath });
    await openSettings(page);
    await page.getByText(`${TEXT.network}: ki`, { exact: false }).first().waitFor();
    await shoot(page, 'c-profile-non-owner', {
      widths: WIDTHS,
      highlight: `text=${TEXT.network}: ki >> visible=true`,
    });
  });

  await step('d. the hire dialog', async () => {
    const page = await open({ path: '/p/AC/team' });
    await page.getByRole('button', { name: TEXT.hire }).first().click();
    await page.getByRole('dialog').getByText(TEXT.details, { exact: true }).first().click();
    await page.getByLabel(TEXT.network).waitFor();
    // The dialog scrolls inside: the highlight brings the row into view at each width.
    await shoot(page, 'd-hire-owner', { widths: WIDTHS, highlight: `label:has-text("${TEXT.network}")` });
  });

  await step('d1. the hire dialog as the owner with the network off', async () => {
    const page = await open({ path: '/p/AC/team' });
    await page.getByRole('button', { name: TEXT.hire }).first().click();
    await page.getByRole('dialog').getByText(TEXT.details, { exact: true }).first().click();
    await page.getByLabel(TEXT.network).click();
    await shoot(page, 'd-hire-owner-off', { widths: WIDTHS, highlight: `label:has-text("${TEXT.network}")` });
  });

  await step('d2. the hire dialog as a non-owner', async () => {
    // A team admin may hire but not set the permission fields: the network is a read-only fact.
    const admin = await instance.invite({
      project: 'AC',
      email: 'ada@acme.test',
      name: 'Ada Admin',
      access: 'admin',
    });
    const page = await open({ as: admin, path: '/p/AC/team' });
    await page.getByRole('button', { name: TEXT.hire }).first().click();
    await page.getByRole('dialog').getByText(TEXT.details, { exact: true }).first().click();
    await page.getByText(TEXT.network, { exact: false }).first().waitFor();
    await shoot(page, 'd-hire-non-owner', {
      widths: WIDTHS,
      highlight: `text=${TEXT.network} >> visible=true`,
    });
  });
};
