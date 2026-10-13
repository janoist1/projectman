/**
 * Scenario for PM-297 (docs/SCREENSHOTS.md): what holds the places of a member that a card waits for
 * (`member_at_capacity`). Three members are filled, one after the other, and a card waits for each:
 *
 *   a. a developer with one quiet general conversation (the tip has a time)
 *   b. a developer in the middle of a turn on another card (the card is internal, "most dolgozik")
 *   c. a member with two places: a conversation and a card at work (the mixed tip)
 *   d. the same card as a. when the server sends no holders (an older server): today's texts
 *
 * It shoots, at 1512 and 390 px: the drawer's box of a, b, c, d, the same cards as a client (a conversation
 * without a link, "Egy másik kártya" without a link), the board (card rows and the strip chips), the profile
 * note of a and c, and a dark picture of a.
 *
 *   npm run shots -- scripts/scenarios/capacity-holders.mjs --widths 1512,390
 */

const TEXT = {
  list: /helyét foglalja$/,
  board: 'Most dolgozik',
  full: 'Tele van',
};
const WIDTHS = [1512, 390];

/** What an older server sends: no holders, no capacity. */
function withoutHolders(value, inWaiting = false) {
  if (Array.isArray(value)) return value.map((entry) => withoutHolders(entry, inWaiting));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          key !== 'capacityHolders' &&
          !(inWaiting && ['holders', 'capacity', 'closeAfterMinutes'].includes(key)),
      )
      .map(([key, entry]) => [key, withoutHolders(entry, inWaiting || key === 'startWaiting')]),
  );
}

export default async ({ instance, open, shoot, step, log }) => {
  const { config } = await instance.api('/api/projects/AC/config');
  const ai = config.team.members.filter((member) => member.kind === 'ai');
  log(
    `roster: ${ai.map((m) => `${m.handle} ${m.role} ${m.provider ?? 'claude'} capacity ${m.capacity}`).join('; ')}`,
  );
  const developers = ai.filter((member) => member.role === 'developer');
  // Only the fake Claude runs the scripted calls ("CALLS"): the member who is in the middle of a turn is on it.
  const working = developers.find((member) => (member.provider ?? 'claude') === 'claude');
  const quiet = developers.find((member) => member !== working);
  const roomy = ai.find(
    // Not a reviewer: whoever carries the work stage cannot approve it.
    (member) =>
      member.capacity === 2 && member.role !== 'code_review' && (member.provider ?? 'claude') === 'claude',
  );
  if (!working || !quiet || !roomy)
    throw new Error('The demo needs two developers (one on Claude) and a Claude member with two places.');

  // The member with two places carries the work stage too, so that a card can wait for it.
  const { config: current, version } = await instance.api('/api/projects/AC/config');
  await instance.api('/api/projects/AC/config', {
    method: 'PATCH',
    body: {
      baseVersion: version,
      pipeline: {
        ...current.pipeline,
        stages: current.pipeline.stages.map((stage) =>
          stage.kind === 'work'
            ? {
                ...stage,
                owners: [...new Set([...(stage.owners ?? developers.map((m) => m.handle)), roomy.handle])],
              }
            : stage,
        ),
      },
    },
  });

  const workStage = current.pipeline.stages.find((stage) => stage.kind === 'work');

  const card = async (title, visibility) =>
    (
      await instance.api('/api/projects/AC/tasks', {
        method: 'POST',
        body: { title, repo: 'webshop', description: 'Fictional Acme webshop demo task.', visibility },
      })
    ).key;
  const wait = async (title, member) => {
    const key = await card(title, 'shared');
    // A message about the card wakes its assignee; the wake-up waits for a full member.
    await instance.api(`/api/projects/AC/tasks/${key}`, {
      method: 'PATCH',
      body: { assignee: member.handle, stageId: workStage.id },
    });
    await instance.api('/api/projects/AC/messages', {
      method: 'POST',
      body: { to: [member.handle], taskKey: key, text: 'Please pick this card up.' },
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const { task } = await instance.api(`/api/projects/AC/tasks/${key}`);
      if (task.startWaiting?.reason === 'member_at_capacity') return key;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`${key} does not wait for the places of ${member.handle}.`);
  };
  const chat = async (member) => {
    const session = await instance.api(`/api/projects/AC/members/${member.handle}/conversation`, {
      method: 'POST',
    });
    await instance.say('AC', session.id, 'Hello, one question about the basket.');
    await instance.waitIdle('AC', session.id);
    return session.id;
  };
  /** The member starts a turn that does not end for a while: a working card holder. */
  const work = async (title, member) => {
    const key = await card(title, 'internal');
    const session = await instance.startSession('AC', key, member.handle);
    await instance.waitIdle('AC', session);
    await instance.setFakeCalls([{ tool: 'get_task', arguments: { task_key: key }, delayMs: 600_000 }]);
    await instance.say('AC', session, 'CALLS please');
    return key;
  };

  // a. a quiet conversation holds the only place of the quiet developer.
  await chat(quiet);
  const a = await wait('Show the order history', quiet);
  // b. the other developer works on an internal card.
  const heldB = await work('Migrate the order history', working);
  const b = await wait('Add tiered shipping rates', working);
  // c. a member with two places: a conversation and a card at work.
  await chat(roomy);
  const heldC = await work('Plan the stock sync', roomy);
  const c = await wait('Sync the stock levels', roomy);
  log(`waiting cards a ${a}, b ${b}, c ${c}; held ${heldB}, ${heldC}`);

  const list = (page) => page.getByRole('list', { name: TEXT.list });
  const drawer = async (name, key, options = {}) => {
    const page = await open({ path: `/p/AC/tasks/${key}`, ...options });
    await list(page).waitFor();
    await shoot(page, name, { widths: WIDTHS });
    return page;
  };

  await step('a, b, c: the box of the drawer', async () => {
    await drawer('a-chat', a);
    await drawer('b-card', b);
    await drawer('c-mixed', c);
  });

  await step('a dark picture of a', async () => {
    const page = await open({ path: `/p/AC/tasks/${a}` });
    await list(page).waitFor();
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'a-chat-dark', { widths: [1512] });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  await step('d. an older server: no holders', async () => {
    const page = await open({ path: '/p/AC' });
    await page.route('**/api/projects/AC/**', async (route) => {
      const response = await route.fetch();
      const type = response.headers()['content-type'] ?? '';
      if (!type.includes('json')) return route.fulfill({ response });
      return route.fulfill({
        status: response.status(),
        contentType: 'application/json',
        body: JSON.stringify(withoutHolders(await response.json())),
      });
    });
    await page.goto(new URL(`/p/AC/tasks/${a}`, page.url()).toString());
    await page.locator('dd', { hasText: 'Semmit: magától sorra kerül.' }).waitFor();
    await shoot(page, 'd-no-holders', { widths: WIDTHS });
  });

  await step('the board: the card rows and the strip', async () => {
    const page = await open({ path: '/p/AC' });
    await page.getByText(TEXT.board).first().waitFor();
    await shoot(page, 'board', { widths: WIDTHS });
  });

  await step('the profile note', async () => {
    for (const [name, member] of [
      ['profile-a', quiet],
      ['profile-c', roomy],
    ]) {
      const page = await open({ path: `/p/AC/team/${member.handle}` });
      await page.getByText(TEXT.full).first().waitFor();
      await shoot(page, name, { widths: WIDTHS });
    }
  });

  await step('a client: no session link, another card', async () => {
    const client = await instance.invite({
      project: 'AC',
      email: 'cleo@acme.test',
      name: 'Cleo Client',
      access: 'client',
    });
    for (const [name, key] of [
      ['client-a-chat', a],
      ['client-b-hidden-card', b],
    ]) {
      const page = await open({ as: client, path: `/p/AC/tasks/${key}` });
      await list(page).waitFor();
      await shoot(page, name, { widths: [1512] });
    }
  });
};
