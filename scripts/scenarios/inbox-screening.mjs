/**
 * Scenario for PM-561 (docs/SCREENSHOTS.md): "Rád vár" with the questions the Operator screened (PM-556).
 * Real screening needs an Operator session, so the scenario writes the items straight into the disposable
 * instance's database (the screening outcomes are stored in `inbox_items.payload`). It shoots, at 1512 and
 * 390 px (the dark theme at 1512 only):
 *
 *   a. the page with both groups: "Döntés kell" and "Teendő" (a todo the Operator made out of a question)
 *   b. a todo answered "Nem tudom megcsinálni" with no reason
 *   c. a card that closed while it was open: the "közben lezárult" box
 *   d. "Mostanában döntöttél": the close reasons, and an answer waiting for the asking member
 *   e. "Az Operátor intézte" folded, and f. opened
 *   g. the page in the dark theme
 *
 *   npm run shots -- scripts/scenarios/inbox-screening.mjs [--widths 1512,390]
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const WIDTHS = [1512, 390];

const TODO_OPTIONS = [
  { id: 'todo_done', label: 'Done', style: 'primary' },
  { id: 'todo_cannot', label: 'Cannot do it', style: 'secondary' },
];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const owner = members.find((member) => member.kind === 'human').handle;
  const developer = members.find((member) => member.kind === 'ai' && member.role === 'developer').handle;
  const operator =
    members.find((member) => member.kind === 'ai' && member.role === 'operator')?.handle ?? developer;
  const taskKey = (
    await instance.api('/api/projects/AC/tasks', {
      method: 'POST',
      body: { title: 'Rework the basket error pages', repo: 'webshop', labels: [] },
    })
  ).key;

  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const db = new Database(join(instance.dir, 'home', 'db.sqlite'));
  const insert = db.prepare(
    `INSERT INTO inbox_items (id, project_key, kind, assignees, source, session_id, task_key, title, body,
       payload, options, state, resolution, created_at, updated_at)
     VALUES (?, 'AC', 'question', ?, ?, NULL, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  );
  const put = ({ title, payload = {}, options = [], state = 'open', resolution = null, minutes = 30 }) => {
    const id = randomUUID();
    insert.run(
      id,
      JSON.stringify([owner]),
      developer,
      taskKey,
      title,
      JSON.stringify({ question: title, ...payload }),
      JSON.stringify(options),
      state,
      resolution ? JSON.stringify(resolution) : null,
      ago(minutes),
      ago(Math.max(minutes - 5, 1)),
    );
    return id;
  };
  const screening = (outcome, extra = {}) => ({
    until: ago(-5),
    deliveredAt: ago(40),
    outcome,
    by: operator,
    at: ago(35),
    ...extra,
  });
  const todo = (what, where, expected, note) => ({
    screening: screening('todo', { note, todo: { what, where, expected } }),
  });
  const choice = (id, label) => ({ id, label, style: 'secondary' });

  // Open: an ordinary question and two todos.
  put({
    title: 'Melyik hibaoldal legyen a kosárban: a régi vagy az új?',
    payload: {
      options: ['A régi', 'Az új'],
      recommended: 'option_2',
      recommendationReason: 'Az új már mobilon is jó.',
    },
    options: [choice('option_1', 'A régi'), choice('option_2', 'Az új')],
    minutes: 50,
  });
  put({
    title: 'Ki kell próbálni a kosár hibaoldalt egy valódi telefonon',
    payload: todo(
      'Nyisd meg a kosarat egy telefonon, és hagyd ki a kötelező mezőt.',
      'A stage környezet kosár oldala',
      'Látszik a hibaüzenet, és nem takarja ki a gomb.',
      'Ezt gép nem tudja megnézni, csak ember.',
    ),
    options: TODO_OPTIONS,
    minutes: 45,
  });
  const closing = put({
    title: 'Küldd el a kosár hibaoldal képét a megrendelőnek',
    payload: todo(
      'Küldd át a képernyőképet a megrendelőnek jóváhagyásra.',
      'E-mail',
      'A megrendelő válaszolt, vagy tudjuk, hogy látta.',
      'A megrendelővel csak ember tarthatja a kapcsolatot.',
    ),
    options: TODO_OPTIONS,
    minutes: 40,
  });

  // Decided recently: the close reasons, and an answer waiting for the asking member.
  const resolution = (optionId, by, rule, note = null) => ({
    optionId,
    by,
    at: ago(20),
    note,
    ...(rule ? { rule } : {}),
  });
  put({
    title: 'Hány tesztfelhasználót hozzunk létre?',
    state: 'cancelled',
    resolution: resolution('closed', 'system', 'task_done'),
    minutes: 90,
  });
  put({
    title: 'Legyen külön fájl a hibaüzeneteknek?',
    state: 'cancelled',
    resolution: resolution('closed', 'system', 'withdrawn'),
    minutes: 95,
  });
  put({
    title: 'Mehet a kosár oldal az új tárolóba?',
    payload: { answerDelivery: { state: 'waiting', reason: 'member_on_leave', since: ago(15) } },
    options: [choice('option_1', 'Igen'), choice('option_2', 'Nem')],
    state: 'resolved',
    resolution: resolution('option_1', owner),
    minutes: 100,
  });
  put({
    title: 'Megcsinálható a hibaoldal a szokásos sablonnal?',
    payload: { answerDelivery: { state: 'delivered', at: ago(10) } },
    options: [choice('option_1', 'Igen'), choice('option_2', 'Nem')],
    state: 'resolved',
    resolution: resolution('option_2', owner, undefined, 'Külön kell tervezni.'),
    minutes: 110,
  });
  put({
    title: 'Ki kell próbálni a fizetési oldalt is?',
    payload: todo('Próbáld ki a fizetést.', 'Stage', 'Átmegy a fizetés.', 'Ezt csak ember tudja.'),
    options: TODO_OPTIONS,
    state: 'resolved',
    resolution: resolution('todo_done', owner, undefined, 'Kipróbáltam, működik.'),
    minutes: 120,
  });

  // The Operator settled these with no person involved (and one is with the Operator now).
  put({
    title: 'Melyik parancsot futtassam a build-hez?',
    payload: {
      screening: screening('answered', { note: 'A docs/ARCHITECTURE.md megmondja: npm run build.' }),
    },
    state: 'resolved',
    resolution: resolution('operator_answered', operator, 'operator_answered', 'npm run build'),
    minutes: 60,
  });
  put({
    title: 'Ki hagyja jóvá a címkét?',
    payload: {
      screening: screening('forwarded', { forwardedTo: 'claude', note: 'Ez a vezető fejlesztőre tartozik.' }),
    },
    state: 'resolved',
    resolution: resolution('operator_forwarded', operator, 'operator_forwarded'),
    minutes: 70,
  });
  put({
    title: 'Még mindig szükséges az a régi migráció?',
    payload: { screening: screening('moot', { note: 'A kártya közben elkészült.' }) },
    state: 'resolved',
    resolution: resolution('closed', operator, 'operator_moot'),
    minutes: 80,
  });
  put({
    title: 'Mit tegyek, ha a teszt kétszer is elbukik?',
    payload: { screening: { until: ago(-8), deliveredAt: ago(1) } },
    state: 'screening',
    minutes: 2,
  });

  const page = await open({ path: '/p/AC/inbox' });
  const goToInbox = async () => {
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await page.getByText('Küldd el a kosár hibaoldal képét a megrendelőnek').first().waitFor();
  };

  await step('a. both groups', async () => {
    await goToInbox();
    await shoot(page, 'a-groups', { widths: WIDTHS, fullPage: true });
  });

  await step('b. a todo with no reason for "cannot"', async () => {
    const card = page
      .locator('article, section')
      .filter({ hasText: 'Ki kell próbálni a kosár hibaoldalt' })
      .last();
    await card.getByRole('button', { name: 'Nem tudom megcsinálni' }).click();
    await page.getByText('Írd meg röviden, miért nem.').first().waitFor();
    await shoot(page, 'b-todo-reason', {
      widths: WIDTHS,
      highlight: 'text=Írd meg röviden, miért nem. >> visible=true',
    });
  });

  await step('c. a question that closed while it was open', async () => {
    db.prepare(`UPDATE inbox_items SET state = 'cancelled', resolution = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(resolution('closed', 'system', 'task_done')),
      new Date().toISOString(),
      closing,
    );
    const card = page.locator(`#inbox-item-${closing}`);
    await card.getByRole('button', { name: 'Megcsináltam' }).click();
    await page.getByRole('button', { name: 'Rendben' }).first().waitFor();
    await shoot(page, 'c-closed-meanwhile', { widths: WIDTHS, highlight: `#inbox-item-${closing}` });
  });

  await step('d. the recent decisions', async () => {
    await goToInbox().catch(() => page.goto(new URL('/p/AC/inbox', page.url()).href));
    await page.getByText('Mehet a kosár oldal az új tárolóba?').first().waitFor();
    await shoot(page, 'd-history', {
      widths: WIDTHS,
      fullPage: true,
      highlight: 'text=Mehet a kosár oldal az új tárolóba? >> visible=true',
    });
  });

  await step('e. the Operator trail, folded', async () => {
    await page
      .getByText(/Az Operátor intézte/)
      .first()
      .waitFor();
    await shoot(page, 'e-trail-folded', {
      widths: WIDTHS,
      highlight: 'text=/Az Operátor intézte/ >> visible=true',
    });
  });

  await step('f. the Operator trail, opened', async () => {
    await page
      .getByText(/Az Operátor intézte/)
      .first()
      .click();
    await page.getByText('Megválaszolta').first().waitFor();
    await shoot(page, 'f-trail-open', { widths: WIDTHS, fullPage: true });
  });

  await step('g. the dark theme', async () => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'g-dark', { widths: [1512], fullPage: true });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  db.close();
  log('done');
};
