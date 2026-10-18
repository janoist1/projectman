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
  const developerMember = members.find((member) => member.kind === 'ai' && member.role === 'developer');
  const developer = developerMember.handle;
  const operator =
    members.find((member) => member.kind === 'ai' && member.role === 'ai_operator')?.handle ?? developer;
  const task = await instance.api('/api/projects/AC/tasks', {
    method: 'POST',
    body: { title: 'Hub latency report', repo: 'webshop' },
  });
  const db = new Database(join(instance.dir, 'home', 'db.sqlite'));
  const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
  // This disposable card predates both the handed-off and the directly completed question.
  db.prepare('UPDATE tasks SET created_at = ? WHERE key = ?').run(ago(30), task.key);
  db.prepare("UPDATE timeline_events SET created_at = ? WHERE task_key = ? AND type = 'task_created'").run(
    ago(30),
    task.key,
  );
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
      for (const width of [1512, 390]) {
        await page.setViewportSize({ width, height: width === 1512 ? 982 : 844 });
        await page.waitForFunction(
          (mobile) =>
            [...document.querySelectorAll('article')].every(
              (node) => node.className.includes('_mobile_') === mobile,
            ),
          width === 390,
        );
        const summary = page.locator('summary').filter({ hasText: 'Az integrátornak' });
        if (await summary.count()) {
          if (expanded || width === 390)
            await summary.evaluate((node) => node.scrollIntoView({ block: 'start' }));
          const bounds = await summary.boundingBox();
          if (!bounds || bounds.y < 55 || bounds.y + bounds.height > (width === 390 ? 780 : 982))
            throw new Error('Integrator summary is outside the visible content area');
          if (expanded) {
            const card = page.locator('article[data-recipient="integrator"]');
            if (await card.count()) {
              const requester = card.getByText(developerMember.displayName, { exact: true });
              if (
                !(await requester.evaluate(
                  (node) =>
                    node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1,
                ))
              )
                throw new Error('Requester name is clipped');
            }
          }
        }
        await shoot(page, `r2-${name}`, { widths: [width] });
      }
      if (name === '02-mixed-expanded') {
        await page
          .locator('article[data-recipient="integrator"]')
          .evaluate((node) => node.scrollIntoView({ block: 'end' }));
        await shoot(page, 'r2-02-mixed-expanded-actions', { widths: [390] });
      }
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
    db.prepare('UPDATE inbox_items SET payload = ?, created_at = ? WHERE id = ?').run(
      JSON.stringify({
        ...payload,
        recipient: 'owner',
        integratorOpenedAt: ago(25),
        integratorEscalatedAt: ago(1),
      }),
      ago(25),
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
    db.prepare(
      "UPDATE inbox_items SET payload = ?, state = 'resolved', resolution = ?, created_at = ? WHERE id = ?",
    ).run(JSON.stringify(payload), JSON.stringify(resolution), ago(3), item);
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
    // Two distinct questions: one is completed by the integrator, the other is handed to the owner.
    db.prepare('UPDATE inbox_items SET resolution = ? WHERE id = ?').run(JSON.stringify(resolution), item);
    const handedOff = put('Collect the engine diagnostics', 'owner', {
      integratorOpenedAt: ago(25),
      integratorEscalatedAt: ago(1),
      screening: {
        until: ago(25),
        outcome: 'todo',
        by: operator,
        todo: {
          what: 'Collect the engine diagnostics',
          where: 'Hub',
          expected: 'Diagnostics',
          recipient: 'integrator',
        },
      },
    });
    db.prepare('UPDATE inbox_items SET created_at = ? WHERE id = ?').run(ago(25), handedOff);
    const event =
      db.prepare(`INSERT INTO timeline_events (id, project_key, task_key, actor_kind, actor_handle, actor_via, actor_meta, type, data, created_at)
      VALUES (?, 'AC', ?, ?, ?, ?, ?, ?, ?, ?)`);
    event.run(
      randomUUID(),
      task.key,
      'ai',
      developer,
      null,
      null,
      'question_asked',
      JSON.stringify({
        inboxItemId: handedOff,
        question: 'Collect the engine diagnostics',
        requestedRecipient: 'integrator',
      }),
      ago(25),
    );
    event.run(
      randomUUID(),
      task.key,
      'ai',
      developer,
      null,
      null,
      'question_asked',
      JSON.stringify({
        inboxItemId: item,
        question: 'Measure the hub latency',
        requestedRecipient: 'integrator',
      }),
      ago(3),
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
        inboxItemId: handedOff,
        asker: developer,
        from: 'integrator',
        to: 'owner',
        openedAt: ago(25),
        reason: 'integrator_timeout',
      }),
      ago(1),
    );
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
    await step('requesting card timeline', async () => {
      const page = await open({ path: `/p/AC/tasks/${task.key}/timeline` });
      await page
        .getByText('Az integrátornak szóló teendő a tulajdonoshoz került:', { exact: false })
        .waitFor();
      await shoot(page, 'r2-07-timeline', { widths: [1512, 390] });
      await page.close();
    });
    await step('integrator key terminology', async () => {
      const page = await open({ path: '/p/AC/settings/integrator' });
      await page.getByRole('heading', { name: 'Operátor super mód', exact: true }).waitFor();
      await shoot(page, 'r2-09-settings', { widths: [1512, 390] });
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
      await shoot(page, 'r2-08-non-owner', { widths: [1512, 390] });
    });
  } finally {
    db.close();
  }
};
