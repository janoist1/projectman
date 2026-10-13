/**
 * Scenario for PM-561 (docs/SCREENSHOTS.md): "Rád vár" with the questions the Operator screened (PM-556).
 * Real screening needs an Operator session, so the scenario writes the items and the timeline rows straight
 * into the disposable instance's database (the screening outcomes are stored in `inbox_items.payload`, as the
 * server stores them). One member is put on leave through the API, so the server itself computes the wait for
 * its start. It shoots, at 1512 and 390 px (marked "1512" at 1512 only):
 *
 *   a. the page with both groups: "Döntés kell" and "Teendő" (a todo the Operator made out of a question)
 *   b. a todo answered "Nem tudom megcsinálni" with no reason
 *   c. a card that closed while it was open: the "közben lezárult" box
 *   d. a question released after the Operator did not look at it, and one asked again without screening
 *   e. a question of a member on leave: the answer waits for the member
 *   f. "Mostanában döntöttél": the close reasons, and an answer waiting for the asking member
 *   g. "Az Operátor intézte" folded, and h. opened (opened again at each width)
 *   i. the card's drawer over "Rád vár" with a todo, and j. the card's timeline with the new rows
 *   k. the "Teendő" filter (1512), and l. the page in the dark theme (1512)
 *
 *   npm run shots -- scripts/scenarios/inbox-screening.mjs [--widths 1512,390]
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';

const SIZES = [
  [1512, 982],
  [390, 844],
];
const WIDTHS = SIZES.map(([width]) => width);

const TODO_OPTIONS = [
  { id: 'todo_done', label: 'Done', style: 'primary' },
  { id: 'todo_cannot', label: 'Cannot do it', style: 'secondary' },
];

export default async ({ instance, open, shoot, step, log }) => {
  const members = await instance.api('/api/projects/AC/members');
  const owner = members.find((member) => member.kind === 'human').handle;
  const developers = members.filter((member) => member.kind === 'ai' && member.role === 'developer');
  const developer = developers[0].handle;
  const operator =
    members.find((member) => member.kind === 'ai' && member.role === 'operator')?.handle ?? developer;
  const leaver = (
    developers[1] ??
    members.find((member) => member.kind === 'ai' && ![developer, operator].includes(member.handle))
  ).handle;
  const lead =
    members.find((member) => member.kind === 'ai' && ![developer, leaver, operator].includes(member.handle))
      ?.handle ?? developer;
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
  const put = ({
    title,
    source = developer,
    payload = {},
    options = [],
    state = 'open',
    resolution = null,
    minutes = 30,
  }) => {
    const id = randomUUID();
    insert.run(
      id,
      JSON.stringify([owner]),
      source,
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
  const event = db.prepare(
    `INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at)
     VALUES (?, 'AC', ?, NULL, ?, ?, ?, ?, ?)`,
  );
  const record = (minutes, actor, type, data) =>
    event.run(
      randomUUID(),
      taskKey,
      actor === 'system' ? 'system' : 'ai',
      actor === 'system' ? null : actor,
      type,
      JSON.stringify(data),
      ago(minutes),
    );

  const screening = (outcome, extra = {}) => ({
    until: ago(-5),
    deliveredAt: ago(40),
    outcome,
    by: operator,
    at: ago(35),
    ...extra,
  });
  const todo = (what, where, expected, note) => ({
    what,
    where,
    expected,
    note,
  });
  const todoPayload = ({ what, where, expected, note }, outcome = 'todo', extra = {}) => ({
    screening: screening(outcome, { note, todo: { what, where, expected }, ...extra }),
  });
  const choice = (id, label) => ({ id, label, style: 'secondary' });
  const resolution = (optionId, by, rule, note = null, minutes = 20) => ({
    optionId,
    by,
    at: ago(minutes),
    note,
    ...(rule ? { rule } : {}),
  });

  // Open: three questions (a member on leave, released after the Operator's silence, asked again), another
  // ordinary one, and two todos.
  const yesNo = [choice('option_1', 'Igen'), choice('option_2', 'Nem')];
  put({
    title: 'Beállíthatom a kosár oldalt az új tárolóba?',
    source: leaver,
    payload: { options: ['Igen', 'Nem'] },
    options: yesNo,
    minutes: 3,
  });
  const fallback = put({
    title: 'Milyen színű legyen a hibaüzenet kerete?',
    payload: {
      options: ['Piros', 'Narancs'],
      screening: { until: ago(-1), deliveredAt: ago(15), fallback: 'timeout' },
    },
    options: [choice('option_1', 'Piros'), choice('option_2', 'Narancs')],
    minutes: 12,
  });
  put({
    title: 'Mehet a hibaoldal a megosztott komponensek közé?',
    payload: {
      options: ['Igen', 'Nem'],
      unscreened: {
        reason: 'A döntés a megrendelő szerződését érinti, ezt az Operátor nem tudja eldönteni.',
        previousItemId: randomUUID(),
      },
    },
    options: yesNo,
    minutes: 14,
  });
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
  const phone = put({
    title: 'Ki kell próbálni a kosár hibaoldalt egy valódi telefonon',
    payload: todoPayload(
      todo(
        'Nyisd meg a kosarat egy telefonon, és hagyd ki a kötelező mezőt.',
        'A stage környezet kosár oldala',
        'Látszik a hibaüzenet, és nem takarja ki a gomb.',
        'Ezt gép nem tudja megnézni, csak ember.',
      ),
    ),
    options: TODO_OPTIONS,
    minutes: 45,
  });
  const closing = put({
    title: 'Küldd el a kosár hibaoldal képét a megrendelőnek',
    payload: todoPayload(
      todo(
        'Küldd át a képernyőképet a megrendelőnek jóváhagyásra.',
        'E-mail',
        'A megrendelő válaszolt, vagy tudjuk, hogy látta.',
        'A megrendelővel csak ember tarthatja a kapcsolatot.',
      ),
    ),
    options: TODO_OPTIONS,
    minutes: 40,
  });

  // Decided recently: the close reasons (as the server writes them), and an answer waiting for the asking member.
  put({
    title: 'Hány tesztfelhasználót hozzunk létre?',
    state: 'cancelled',
    resolution: resolution('closed', 'system', 'task_done', null, 20),
    minutes: 90,
  });
  put({
    title: 'Legyen külön fájl a hibaüzeneteknek?',
    state: 'cancelled',
    resolution: resolution('closed', developer, 'withdrawn', 'Közben kiderült, hogy a meglévő fájl jó.', 22),
    minutes: 95,
  });
  put({
    title: 'Ki hagyja jóvá a hibaoldal szövegét?',
    state: 'cancelled',
    resolution: resolution('closed', developer, 'handed_off', 'A kártyát átadtam a vezető fejlesztőnek.', 24),
    minutes: 96,
  });
  put({
    title: 'Mehet a kosár oldal az új tárolóba?',
    source: leaver,
    payload: { answerDelivery: { state: 'waiting', reason: 'member_on_leave', since: ago(15) } },
    options: yesNo,
    state: 'resolved',
    resolution: resolution('option_1', owner, undefined, null, 18),
    minutes: 100,
  });
  put({
    title: 'Megcsinálható a hibaoldal a szokásos sablonnal?',
    payload: { answerDelivery: { state: 'delivered', at: ago(10) } },
    options: yesNo,
    state: 'resolved',
    resolution: resolution('option_2', owner, undefined, 'Külön kell tervezni.', 26),
    minutes: 110,
  });
  put({
    title: 'Ki kell próbálni a fizetési oldalt is?',
    payload: todoPayload(
      todo('Próbáld ki a fizetést.', 'Stage', 'Átmegy a fizetés.', 'Ezt csak ember tudja.'),
    ),
    options: TODO_OPTIONS,
    state: 'resolved',
    resolution: resolution('todo_done', owner, undefined, 'Kipróbáltam, működik.', 28),
    minutes: 120,
  });
  // A todo the Operator found moot afterwards: it went to the person, so it stays in the list.
  put({
    title: 'Küldd át a hibaoldal tervét a megrendelőnek',
    payload: todoPayload(
      todo(
        'Küldd át a tervet.',
        'E-mail',
        'A megrendelő megkapta.',
        'A megrendelővel csak ember tarthatja a kapcsolatot.',
      ),
      'moot',
      { note: 'A megrendelő közben megkapta a tervet a vezetőtől.', at: ago(30) },
    ),
    options: TODO_OPTIONS,
    state: 'cancelled',
    resolution: resolution('closed', operator, 'operator_moot', 'A megrendelő közben megkapta a tervet.', 30),
    minutes: 130,
  });

  // The Operator settled these with no person involved (and one is with the Operator now).
  put({
    title: 'Melyik parancsot futtassam a build-hez?',
    payload: {
      screening: screening('answered', { note: 'A docs/ARCHITECTURE.md megmondja: npm run build.' }),
    },
    state: 'resolved',
    resolution: resolution('answer', operator, 'operator_answered', 'npm run build'),
    minutes: 60,
  });
  put({
    title: 'Ki hagyja jóvá a címkét?',
    payload: {
      screening: screening('forwarded', { forwardedTo: lead, note: 'Ez a vezető fejlesztőre tartozik.' }),
    },
    state: 'resolved',
    resolution: resolution('forward', operator, 'operator_forwarded', 'Ez a vezető fejlesztőre tartozik.'),
    minutes: 70,
  });
  put({
    title: 'Még mindig szükséges az a régi migráció?',
    payload: { screening: screening('moot', { note: 'A kártya közben elkészült.' }) },
    state: 'cancelled',
    resolution: resolution('closed', operator, 'operator_moot', 'A kártya közben elkészült.'),
    minutes: 80,
  });
  put({
    title: 'Mit tegyek, ha a teszt kétszer is elbukik?',
    payload: { screening: { until: ago(-8), deliveredAt: ago(1) } },
    state: 'screening',
    minutes: 2,
  });

  // The card's timeline: the rows the screening adds.
  const asked = randomUUID();
  record(130, developer, 'question_asked', {
    inboxItemId: asked,
    question: 'Ki kell próbálni a kosár hibaoldalt?',
    screening: true,
  });
  record(125, operator, 'question_screened', {
    inboxItemId: asked,
    asker: developer,
    outcome: 'todo',
    note: 'Ezt gép nem tudja megnézni, csak ember.',
    todo: { what: 'Nyisd meg a kosarat egy telefonon.', where: 'Stage', expected: 'Látszik a hibaüzenet.' },
    feedbackId: 'fb-fictional',
  });
  record(110, developer, 'question_asked', {
    inboxItemId: randomUUID(),
    question: 'Milyen színű legyen a keret?',
    screening: true,
  });
  record(100, 'system', 'question_screening_skipped', {
    inboxItemId: randomUUID(),
    asker: developer,
    reason: 'timeout',
  });
  record(90, developer, 'question_asked', {
    inboxItemId: randomUUID(),
    question: 'Mehet a hibaoldal a megosztott komponensek közé?',
    unscreened: { reason: 'A döntés a szerződést érinti.', previousItemId: randomUUID() },
  });
  record(80, operator, 'question_screened', {
    inboxItemId: randomUUID(),
    asker: developer,
    outcome: 'forwarded',
    note: 'Ez a vezető fejlesztőre tartozik.',
    forwardedTo: lead,
  });
  record(70, 'system', 'question_closed', {
    inboxItemId: randomUUID(),
    asker: developer,
    rule: 'task_done',
    note: null,
  });
  record(60, developer, 'question_closed', {
    inboxItemId: randomUUID(),
    asker: developer,
    rule: 'withdrawn',
    note: 'Közben kiderült, hogy a meglévő fájl jó.',
  });

  // The member on leave: the server works out the wait for its start when the page asks for the list.
  await instance.api(`/api/projects/AC/members/${leaver}`, { method: 'PATCH', body: { onLeave: true } });

  const page = await open({ path: '/p/AC/inbox' });
  const goToInbox = async () => {
    await page.goto(new URL('/p/AC/inbox', page.url()).href);
    await page.getByText('Küldd el a kosár hibaoldal képét a megrendelőnek').first().waitFor();
  };
  const card = (id) => page.locator(`#inbox-item-${id}`);

  await step('a. both groups', async () => {
    await goToInbox();
    await shoot(page, 'a-groups', { widths: WIDTHS, highlight: 'h2:has-text("Teendő")' });
  });

  await step('b. a todo with no reason for "cannot"', async () => {
    await card(phone).getByRole('button', { name: 'Nem tudom megcsinálni' }).click();
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
    await card(closing).getByRole('button', { name: 'Megcsináltam' }).click();
    await page.getByRole('button', { name: 'Rendben' }).first().waitFor();
    await shoot(page, 'c-closed-meanwhile', { widths: WIDTHS, highlight: `#inbox-item-${closing}` });
  });

  await step('d. released after the Operator did not look, and asked again', async () => {
    await goToInbox().catch(() => page.goto(new URL('/p/AC/inbox', page.url()).href));
    await page.getByText('Az Operátor nem nézte át').first().waitFor();
    await shoot(page, 'd-fallback-rerouted', { widths: WIDTHS, highlight: `#inbox-item-${fallback}` });
  });

  await step('e. the answer waits for the member on leave', async () => {
    await page
      .getByText(/szabadságon van: a válaszod megvárja/)
      .first()
      .waitFor();
    await shoot(page, 'e-asker-leave', {
      widths: WIDTHS,
      highlight: 'text=/szabadságon van: a válaszod megvárja/ >> visible=true',
    });
  });

  await step('f. the recent decisions', async () => {
    await page.getByText('Mehet a kosár oldal az új tárolóba?').first().waitFor();
    await shoot(page, 'f-history', {
      widths: WIDTHS,
      highlight: 'text=Mehet a kosár oldal az új tárolóba? >> visible=true',
    });
  });

  await step('g. the Operator trail, folded', async () => {
    await page
      .getByText(/Az Operátor intézte/)
      .first()
      .waitFor();
    await shoot(page, 'g-trail-folded', {
      widths: WIDTHS,
      highlight: 'text=/Az Operátor intézte/ >> visible=true',
    });
  });

  // A change of the width builds the trail again, closed: open it at each width.
  await step('h. the Operator trail, opened', async () => {
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await page
        .getByText(/Az Operátor intézte/)
        .first()
        .waitFor();
      const summary = page.getByText(/Az Operátor intézte/).first();
      await summary.click();
      await page.getByText('Operátornál').first().waitFor();
      await shoot(page, 'h-trail-open', { widths: [width], highlight: 'text=Operátornál >> visible=true' });
    }
  });

  await step('i. the todo in the drawer of its card', async () => {
    await goToInbox().catch(() => page.goto(new URL('/p/AC/inbox', page.url()).href));
    await card(phone).locator('[data-inbox-card-link]').click();
    const drawer = page.getByRole('complementary', { name: 'Feladat részletei' });
    await drawer.getByText('A LÉPÉS', { exact: false }).first().waitFor();
    await shoot(page, 'i-drawer-todo', { widths: WIDTHS });
  });

  await step('j. the timeline rows of the screening', async () => {
    await page.goto(new URL(`/p/AC/tasks/${taskKey}/timeline`, page.url()).href);
    await page
      .getByText(/Teendőként továbbengedte neked/)
      .first()
      .waitFor();
    await shoot(page, 'j-timeline', {
      widths: WIDTHS,
      highlight: 'text=/Teendőként továbbengedte neked/ >> visible=true',
    });
  });

  await step('k. the Teendő filter', async () => {
    await goToInbox().catch(() => page.goto(new URL('/p/AC/inbox', page.url()).href));
    await page.setViewportSize({ width: 1512, height: 982 });
    await page
      .getByRole('button', { name: /^Teendő/ })
      .first()
      .click();
    await shoot(page, 'k-todo-filter', { widths: [1512] });
  });

  await step('l. the dark theme', async () => {
    await page.getByRole('button', { name: /^Mind/ }).first().click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await shoot(page, 'l-dark', { widths: [1512], highlight: 'h2:has-text("Teendő")' });
    await page.emulateMedia({ colorScheme: 'light' });
  });

  db.close();
  log('done');
};
