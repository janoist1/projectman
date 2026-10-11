/**
 * Scenario for PM-488 (docs/SCREENSHOTS.md): the default recipient of the card's conversation. When nobody
 * else is on the card, the project manager gets the message and passes it on.
 *
 *   a. a card nobody works on (no assignee, no session; the owner writes): the project manager's chip and help text
 *   b. the same in the dark theme
 *   c. a card a member works on: the "workers" help text
 *   d. the writer took the project manager out: empty recipients, "Vissza az alaphoz", send disabled
 *
 *   npm run shots -- scripts/scenarios/card-thread-recipient.mjs --widths 1512,390
 */

// The texts of the Hungarian UI the scenario waits for (apps/web/src/i18n/hu.ts, task.thread).
const TEXT = {
  region: 'A kártya beszélgetése',
  projectManager:
    'Most senki nem foglalkozik vele, ezért a projektmenedzser kapja meg, és ő továbbítja a megfelelő tagnak.',
  workers: 'A kártyán épp dolgozók kapják meg.',
  remove: 'Kiveszem a címzettek közül: Projektmenedzser',
  reset: 'Vissza az alaphoz',
};

export default async ({ instance, open, shoot, step, log }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const developer = config.team.members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const manager = config.team.members.find(
    (member) => member.kind === 'ai' && member.role === 'project_manager',
  );
  if (!manager) throw new Error('The demo project has no project manager.');
  log(`developer ${developer.handle}, project manager ${manager.handle}`);

  // A new card waits in the first stage: no assignee, no session, and its only stage owner is the writer.
  const created = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Add gift wrapping', repo: 'webshop', description: 'Fictional Acme webshop demo task.' },
  });
  const idle = created.key;
  const threadPath = (key) => `/p/AC/tasks/${key}/thread`;
  const waitThread = async (page) => {
    await page.getByRole('region', { name: TEXT.region }).waitFor();
  };

  await step('a. a card nobody works on: the project manager is the recipient', async () => {
    const page = await open({ path: threadPath(idle) });
    await waitThread(page);
    await page.getByText(TEXT.projectManager, { exact: true }).waitFor();
    await shoot(page, 'recipient-project-manager', { widths: [1512, 390] });
  });

  await step('b. the same in the dark theme', async () => {
    const page = await open({ path: threadPath(idle) });
    await waitThread(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByText(TEXT.projectManager, { exact: true }).waitFor();
    await shoot(page, 'recipient-project-manager-dark', { widths: [1512, 390] });
  });

  await step('c. a card a member works on', async () => {
    const sessionId = await instance.startSession('AC', 'AC-1', developer.handle);
    await instance.waitIdle('AC', sessionId);
    const page = await open({ path: threadPath('AC-1') });
    await waitThread(page);
    await page.getByText(TEXT.workers, { exact: true }).waitFor();
    await shoot(page, 'recipient-workers', { widths: [1512, 390] });
  });

  await step('d. the writer took the project manager out', async () => {
    const page = await open({ path: threadPath(idle) });
    await waitThread(page);
    await page.getByRole('button', { name: TEXT.remove }).click();
    await page.getByRole('button', { name: TEXT.reset }).waitFor();
    await shoot(page, 'recipient-removed', { widths: [1512, 390] });
  });
};
