/** PM-782: the approved owner inbox states, against a disposable instance only. */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const options = [
  { id: 'todo_done', label: 'Done', style: 'primary' },
  { id: 'todo_cannot', label: 'Cannot do it', style: 'secondary' },
];
export default async ({ instance, open, shoot, step }) => {
  const members = await instance.api('/api/projects/AC/members');
  const owner = members.find((member) => member.kind === 'human').handle;
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer').handle;
  const operator =
    members.find((member) => member.kind === 'ai' && member.role === 'ai_operator')?.handle ?? developer;
  const task = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Hub latency report', repo: 'webshop' },
  });
  const db = new Database(join(instance.dir, 'home', 'db.sqlite'));
  const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const insert =
    db.prepare(`INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body,
    payload, options, state, resolution, created_at, updated_at) VALUES (?, 'AC', 'question', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`);
  const put = (title, recipient, extra = {}) => {
    const id = randomUUID();
    const payload = {
      question: title,
      recipient,
      ...(recipient === 'integrator' ? { integratorOpenedAt: ago(3) } : {}),
      screening: {
        until: ago(3),
        outcome: 'todo',
        by: operator,
        note: 'Technical measurement',
        todo: { what: title, where: 'Hub', expected: 'Latency report', recipient },
      },
      ...extra,
    };
    insert.run(
      id,
      JSON.stringify([owner]),
      developer,
      task.key,
      title,
      JSON.stringify(payload),
      JSON.stringify(options),
      'open',
      null,
      ago(3),
      ago(3),
    );
    return id;
  };
  try {
    const own = put('Renew the project domain', 'owner');
    const item = put('Measure the hub latency', 'integrator');
    const show = async (name, expanded = false, path = '/p/AC/inbox') => {
      const page = await open({ path });
      await page.getByRole('heading', { name: 'Rád vár', exact: true }).waitFor();
      if (expanded) await page.locator('summary').filter({ hasText: 'Az integrátornak' }).click();
      await shoot(page, name, { widths: [1512, 390] });
      await page.close();
    };
    await step('mixed, folded and expanded', async () => {
      await show('01-mixed-folded');
      await show('02-mixed-expanded', true);
    });
    db.prepare("UPDATE inbox_items SET state = 'cancelled' WHERE id = ?").run(own);
    await step('only integrator work', async () => {
      await show('03-only-integrator', true);
    });
    const payload = JSON.parse(db.prepare('SELECT payload FROM inbox_items WHERE id = ?').get(item).payload);
    db.prepare('UPDATE inbox_items SET payload = ? WHERE id = ?').run(
      JSON.stringify({
        ...payload,
        recipient: 'owner',
        integratorOpenedAt: ago(25),
        integratorEscalatedAt: ago(1),
      }),
      item,
    );
    await step('persisted handoff to owner', async () => {
      await show('04-handed-to-owner');
    });
    const superActor = {
      kind: 'ai',
      handle: operator,
      via: 'integrator',
      operatorMode: 'super',
      credential: { id: 'screenshot', prefix: 'example' },
    };
    const resolution = {
      by: owner,
      optionId: 'todo_done',
      at: ago(0.1),
      note: 'p95 = 24 ms',
      via: 'integrator',
      integratorTodo: true,
      actor: superActor,
    };
    db.prepare("UPDATE inbox_items SET payload = ?, state = 'resolved', resolution = ? WHERE id = ?").run(
      JSON.stringify(payload),
      JSON.stringify(resolution),
      item,
    );
    await step('integrator completed work', async () => {
      await show('05-integrator-closed', true);
    });
    db.prepare('UPDATE inbox_items SET resolution = ? WHERE id = ?').run(
      JSON.stringify({ by: owner, optionId: 'todo_done', at: ago(0.1), note: 'p95 = 24 ms' }),
      item,
    );
    await step('owner completed integrator work', async () => {
      await show('06-owner-closed', true);
    });
    const event =
      db.prepare(`INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, actor_via, actor_meta, type, data, created_at)
      VALUES (?, 'AC', ?, ?, ?, ?, ?, ?, ?, ?)`);
    event.run(
      randomUUID(),
      task.key,
      'ai',
      operator,
      'integrator',
      JSON.stringify({ operatorMode: 'super', credential: superActor.credential }),
      'question_answered',
      JSON.stringify({
        inboxItemId: item,
        answer: 'Done',
        integratorTodo: { optionId: 'todo_done', note: 'p95 = 24 ms' },
      }),
      ago(0.1),
    );
    event.run(
      randomUUID(),
      task.key,
      'system',
      null,
      null,
      null,
      'question_recipient_escalated',
      JSON.stringify({
        inboxItemId: item,
        asker: developer,
        from: 'integrator',
        to: 'owner',
        openedAt: ago(25),
        reason: 'integrator_timeout',
      }),
      ago(1),
    );
    await step('requesting card timeline', async () => {
      const page = await open({ path: `/p/AC/tasks/${task.key}/timeline` });
      await page
        .getByText('Az integrátornak szóló teendő a tulajdonoshoz került:', { exact: false })
        .waitFor();
      await shoot(page, '07-timeline', { widths: [1512, 390] });
      await page.close();
    });
    await step('integrator key terminology', async () => {
      const page = await open({ path: '/p/AC/settings/integrator' });
      await page.getByRole('heading', { name: 'Integrátor', exact: true }).waitFor();
      await shoot(page, '09-settings', { widths: [1512, 390] });
      await page.close();
    });
    await step('non-owner inbox', async () => {
      const colleague = await instance.invite({
        project: 'AC',
        email: 'dana@example.test',
        name: 'Dana',
        access: 'developer',
      });
      const page = await open({ as: colleague, path: '/p/AC/inbox' });
      await page.getByRole('heading', { name: 'Rád vár', exact: true }).waitFor();
      if (await page.locator('summary').filter({ hasText: 'Az integrátornak' }).count())
        throw new Error('Integrator group leaked');
      await shoot(page, '08-non-owner', { widths: [1512, 390] });
    });
  } finally {
    db.close();
  }
};
