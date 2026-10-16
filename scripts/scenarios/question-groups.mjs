/** PM-695: the seven designed states, using only a disposable instance and its fixture database. */
import { join } from 'node:path';
import Database from 'better-sqlite3';

const WIDTHS = [1512, 390];
const PRIMARY = 'inb_group_primary';
const IDS = [PRIMARY, 'inb_group_linked', 'inb_group_third'];
const QUESTION = 'How should both forms show an invalid email address?';
const NOTE = 'The checkout and account forms need the same presentation decision.';

export default async ({ instance, open, shoot, step }) => {
  const members = await instance.api('/api/projects/AC/members');
  const owner = members.find((member) => member.kind === 'human').handle;
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  const manager =
    members.find((member) => member.kind === 'ai' && member.role === 'project_manager')?.handle ??
    developers[0].handle;
  const tasks = [];
  for (const title of ['Checkout email field', 'Account email field', 'Shared error presentation']) {
    tasks.push(
      (
        await instance.api('/api/projects/AC/tasks', {
          method: 'POST',
          body: { title, repo: 'webshop', labels: [] },
        })
      ).key,
    );
  }
  const db = new Database(join(instance.dir, 'home', 'db.sqlite'));
  const at = new Date().toISOString();
  const options = [
    {
      id: 'option_1',
      label: 'Below the field',
      consequence: 'The error remains next to the address.',
      style: 'primary',
    },
    {
      id: 'option_2',
      label: 'Toast notification',
      consequence: 'The error disappears after a few seconds.',
      style: 'secondary',
    },
    { id: 'answer', label: 'answer', style: 'secondary' },
  ];
  const insert =
    db.prepare(`INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key,
    title, body, payload, options, state, resolution, created_at, updated_at)
    VALUES (?, 'AC', 'question', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`);
  for (const [index, id] of IDS.entries()) {
    const question = `Which error presentation should ${tasks[index]} use for an invalid email address?`;
    insert.run(
      id,
      JSON.stringify([owner]),
      developers[index % developers.length].handle,
      tasks[index],
      question,
      JSON.stringify({
        question,
        recommended: 'option_1',
        recommendationReason: 'It stays visible while the user corrects the address.',
        screening: { by: manager, until: new Date(Date.now() + 600_000).toISOString(), deliveredAt: at },
      }),
      JSON.stringify(options),
      index === 0 ? 'open' : 'screening',
      new Date(Date.now() - (3 - index) * 60_000).toISOString(),
      at,
    );
  }
  db.prepare(
    'INSERT INTO question_groups (primary_item_id, project_key, question, created_at, by_handle, note) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(PRIMARY, 'AC', QUESTION, at, manager, NOTE);
  for (const id of IDS)
    db.prepare('INSERT INTO question_group_items (item_id, primary_item_id) VALUES (?, ?)').run(id, PRIMARY);
  const event =
    db.prepare(`INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at)
    VALUES (?, 'AC', ?, NULL, ?, ?, ?, ?, ?)`);
  for (const [index, task] of tasks.entries())
    event.run(
      `evt_group_${index}`,
      task,
      'ai',
      manager,
      'question_grouped',
      JSON.stringify({ primaryItemId: PRIMARY, itemIds: IDS, by: manager }),
      at,
    );

  const page = await open({ path: '/p/AC/inbox', width: 1512 });
  const groupCard = () => page.locator(`#inbox-item-${PRIMARY}`);
  const expand = async () => {
    const summary = groupCard().locator('summary').filter({ hasText: 'Honnan jött' });
    if ((await summary.getAttribute('aria-expanded')) !== 'true') await summary.click();
  };
  const resetPage = async () => {
    await page.reload();
    await groupCard().waitFor();
  };
  try {
    await step('Shared question, folded and expanded', async () => {
      await groupCard().waitFor();
      await shoot(page, '01-shared-question', { widths: WIDTHS });
      await expand();
      await shoot(page, '02-question-sources', { widths: WIDTHS });
    });
    await step('Linked card points to the shared question', async () => {
      await page.goto(new URL(`/p/AC/tasks/${tasks[1]}`, page.url()).href);
      await page
        .getByText(/kérdése egy közös kérdés része/)
        .first()
        .waitFor();
      await shoot(page, '07-linked-pointer', { widths: WIDTHS });
      await page.goto(new URL('/p/AC/inbox', page.url()).href);
      await groupCard().waitFor();
    });
    await step('A withdrawn asker stays in the source list', async () => {
      db.prepare("UPDATE inbox_items SET state = 'cancelled', resolution = ? WHERE id = ?").run(
        JSON.stringify({
          optionId: 'closed',
          by: developers[1 % developers.length].handle,
          at,
          note: 'No longer needed',
          rule: 'withdrawn',
        }),
        IDS[1],
      );
      await resetPage();
      await expand();
      await shoot(page, '03-withdrawn-source', { widths: WIDTHS });
    });
    await step('Hidden and deleted source projections', async () => {
      // These are already-redacted server payload fixtures; no hidden content is placed in the DOM.
      await page.route('**/api/projects/AC/inbox?state=all', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        const primary = body.items.find((item) => item.id === PRIMARY);
        primary.payload.group.sources = primary.payload.group.sources.map((source, index) =>
          index === 0
            ? source
            : {
                ...source,
                taskKey: null,
                taskTitle: null,
                question: null,
                state: index === 1 ? 'live' : 'deleted',
              },
        );
        await route.fulfill({ response, json: body });
      });
      await resetPage();
      await expand();
      await shoot(page, '04-hidden-deleted-sources', { widths: WIDTHS });
      await page.unroute('**/api/projects/AC/inbox?state=all');
    });
    await step('History keeps the answer count and the sources', async () => {
      await instance.api(`/api/projects/AC/inbox/${PRIMARY}/resolve`, {
        method: 'POST',
        body: { optionId: 'option_1' },
      });
      await page.reload();
      await page.getByText(/2 kérdésre ment el/).waitFor();
      await page.getByText('Honnan jött (3 kérdés)').click();
      await shoot(page, '06-answer-history', { widths: WIDTHS });
      await page.goto(new URL(`/p/AC/tasks/${tasks[2]}/timeline`, page.url()).href);
      await page
        .getByText(/Válasz a közös kérdésre/)
        .first()
        .waitFor();
      await shoot(page, '07-linked-timeline', {
        widths: WIDTHS,
        highlight: 'text=Válasz a közös kérdésre >> visible=true',
      });
    });
    await step('Every asker withdrew while an answer was being written', async () => {
      for (const [index, id] of IDS.entries())
        db.prepare('UPDATE inbox_items SET state = ?, resolution = NULL WHERE id = ?').run(
          index === 0 ? 'open' : 'screening',
          id,
        );
      await page.goto(new URL('/p/AC/inbox', page.url()).href);
      await groupCard().waitFor();
      await groupCard().getByRole('button', { name: 'Saját válasz' }).click();
      await groupCard().locator('textarea').fill('A draft answer');
      const resolution = JSON.stringify({
        optionId: 'closed',
        by: owner,
        at,
        note: null,
        rule: 'group_withdrawn',
      });
      for (const id of IDS)
        db.prepare("UPDATE inbox_items SET state = 'cancelled', resolution = ? WHERE id = ?").run(
          resolution,
          id,
        );
      await groupCard().getByRole('button', { name: 'Válasz küldése', exact: true }).click();
      await page.getByText(/minden kérdező visszavonta/).waitFor();
      await shoot(page, '05-everyone-withdrew', { widths: WIDTHS });
    });
  } finally {
    db.close();
  }
};
