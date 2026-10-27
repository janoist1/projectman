/**
 * Screenshots for PM-1073 (docs/SCREENSHOTS.md): the machine access switch of an AI member (decision 66) in the
 * member editor and its line on the profile. The disposable server is real; the admin view is a second account
 * invited as an admin, and the switched-on developer is set through the real API.
 *
 *   a. the owner edits the project manager: switched on by role
 *   b. the owner edits another AI member: switched off
 *   c. an admin sees the switch disabled with the owner-only hint
 *   d. a person has no switch
 *   e. the profile settings panel shows the line of a member who has it
 *
 *   npm run shots -- scripts/scenarios/machine-access.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const SWITCH = 'label:has-text("Külső teendőt adhat (MCP)")';

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const pm = members.find((member) => member.kind === 'ai' && member.role === 'project_manager');
  const worker = members.find(
    (member) => member.kind === 'ai' && member.role !== 'ai_operator' && member.role !== 'project_manager',
  );
  const person = members.find((member) => member.kind === 'human' && member.role === 'owner');
  if (!pm || !worker || !person) throw new Error('The demo team needs a PM, another AI member and an owner.');
  log(`pm: ${pm.handle}, worker: ${worker.handle}, person: ${person.handle}`);

  const edit = async (page, member) => {
    await page.goto(new URL('/p/AC/team', page.url()).href);
    await page.getByRole('button', { name: `További műveletek: ${member.displayName}` }).click();
    await page.getByRole('button', { name: `Szerkesztés: ${member.displayName}` }).click();
    await page.waitForSelector('dialog[open]');
  };
  const shot = (page, name, highlight) => shoot(page, name, { widths: WIDTHS, highlight });

  await step('a. the owner edits the project manager', async () => {
    const page = await open({ path: '/p/AC/team' });
    await edit(page, pm);
    await page.locator(SWITCH).waitFor();
    await shot(page, 'machine-access-a-pm', SWITCH);
  });

  await step('b. the owner edits another AI member', async () => {
    const page = await open({ path: '/p/AC/team' });
    await edit(page, worker);
    await page.locator(SWITCH).waitFor();
    await shot(page, 'machine-access-b-worker', SWITCH);
  });

  await step('c. an admin sees the switch disabled', async () => {
    const admin = await instance.invite({
      project: 'AC',
      email: 'admin@acme.test',
      name: 'Demo Admin',
      access: 'admin',
    });
    const page = await open({ as: admin, path: '/p/AC/team' });
    await edit(page, pm);
    await page.locator(SWITCH).waitFor();
    await shot(page, 'machine-access-c-admin', SWITCH);
  });

  await step('d. a person has no switch', async () => {
    const page = await open({ path: '/p/AC/team' });
    await edit(page, person);
    if ((await page.locator(SWITCH).count()) !== 0) throw new Error('A person must not have the switch.');
    await shot(page, 'machine-access-d-person', 'dialog[open]');
  });

  await step('e. the profile line', async () => {
    const page = await open({ path: `/p/AC/team/${pm.handle}` });
    await page.getByRole('heading', { name: 'Beállítások', exact: true }).click();
    await page.getByText('Külső teendőt adhat a tulajdonosoknak (MCP).', { exact: true }).waitFor();
    await shot(page, 'machine-access-e-profile', 'text=Külső teendőt adhat a tulajdonosoknak (MCP).');
  });
};
