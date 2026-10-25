/**
 * Scenario for PM-989 (docs/SCREENSHOTS.md): the e-mail address of an AI member in the web app. The disposable
 * server and browser are real; the instance has no mail sender, so the channel view, the member rename, a mail
 * that came in and a parked mail are told to the browser only (`page.route`):
 *
 *   1. Settings > E-mail: the senders with their addresses, the copy button (copied, refused), the rename form
 *      (open, name taken, bad name, saved), a conflict, and the channel switched off
 *   2. the thread of the Messages page and the short list of the Team page with a mail that came in
 *   3. the parked mail of the inbox with the new reason
 *
 *   npm run shots -- scripts/scenarios/member-email-address.mjs [--widths 1512,390]
 */

const WIDTHS = [1512, 390];
const DOMAIN = 'mail.chopper.example';
const minutes = (n) => new Date(Date.now() + n * 60_000).toISOString();

export default async ({ instance, open, shoot, step, log }) => {
  const config = (await instance.api('/api/projects/AC/config')).config;
  const owner = config.team.members.find((member) => member.kind === 'human' && member.access === 'owner');
  const ai = config.team.members.filter((member) => member.kind === 'ai').slice(0, 3);
  if (!owner || ai.length < 2) throw new Error('The demo team needs an owner and two AI members.');
  log(`owner ${owner.handle}, AI members ${ai.map((member) => member.handle).join(', ')}`);

  const state = {
    channelOn: true,
    mailboxes: Object.fromEntries(ai.map((member) => [member.handle, member.handle])),
    taken: new Set(['kata-desk']),
    conflict: null,
    delay: 0,
  };

  const page = await open({ path: '/p/AC/settings/email' });
  await page
    .context()
    .grantPermissions(['clipboard-read', 'clipboard-write'])
    .catch(() => {});

  await page.route('**/api/projects/AC/email', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const view = await response.json();
    await route.fulfill({
      response,
      json: {
        ...view,
        configured: true,
        enabled: state.channelOn,
        fromAddress: state.channelOn ? `projectman@${DOMAIN}` : null,
        memberDomain: DOMAIN,
        senders: ai.map((member, index) => ({
          handle: member.handle,
          displayName: member.displayName,
          sendWithoutApproval: index === 1,
          mailbox: state.mailboxes[member.handle],
          address:
            state.channelOn && state.conflict !== member.handle
              ? `${state.mailboxes[member.handle]}@${DOMAIN}`
              : null,
          addressConflict: state.conflict === member.handle,
        })),
      },
    });
  });
  await page.route('**/api/projects/AC/members/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    const handle = new URL(route.request().url()).pathname.split('/').pop();
    const mailbox = route.request().postDataJSON()?.email?.mailbox;
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay));
    if (mailbox !== undefined && state.taken.has(mailbox)) {
      await route.fulfill({
        status: 409,
        json: { error: { code: 'email_mailbox_taken', message: 'taken', details: { mailbox } } },
      });
      return;
    }
    if (mailbox !== undefined) state.mailboxes[handle] = mailbox;
    await route.fulfill({ json: {} });
  });

  const sender = ai[0];
  const mail = {
    id: 'msg-email-1',
    projectKey: 'AC',
    from: owner.handle,
    to: [sender.handle],
    taskKey: null,
    body: 'Szia! Kérlek nézd meg a mellékelt ajánlatot, és csütörtökig jelezd, belefér-e a keretbe.\n\nKöszi!',
    email: {
      emailId: 'eml-1',
      subject: 'Ajánlat a webshop új fizetési moduljára, véglegesítés csütörtökig',
      direct: true,
    },
    createdAt: minutes(-30),
    deliveredAt: minutes(-29),
  };
  await page.route('**/api/projects/AC/messages*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, messages: [...(body.messages ?? []), mail] } });
  });
  await page.route('**/api/projects/AC/inbox*', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const parked = {
      id: 'inb-parked-1',
      projectKey: 'AC',
      kind: 'alert',
      assignees: [owner.handle],
      source: 'system',
      sessionId: null,
      taskKey: null,
      title: 'Kérdés a rendelésről',
      body: null,
      payload: {
        alert: 'email_parked',
        emailId: 'eml-2',
        reason: 'sender_not_allowed',
        fromAddress: 'ismeretlen@example.org',
        subject: 'Kérdés a rendelésről',
        excerpt: 'Jó napot! A tegnapi rendelésemmel kapcsolatban szeretnék érdeklődni.',
        attachmentNames: [],
      },
      options: [{ id: 'seen', label: 'seen', style: 'primary' }],
      state: 'open',
      resolution: null,
      createdAt: minutes(-5),
    };
    await route.fulfill({ response, json: { ...body, items: [...(body.items ?? []), parked] } });
  });

  const visit = async (path) => {
    await page.goto(new URL(path, page.url()).href);
  };
  const shot = (name, highlight) => shoot(page, name, { widths: WIDTHS, highlight });
  const firstRow = () => page.locator('li', { hasText: ai[0].displayName }).first();
  const renameButton = () => firstRow().getByRole('button', { name: /postafiókjának átírása/ });
  const field = () => firstRow().getByLabel('Postafiók neve');
  const save = () => firstRow().getByRole('button', { name: 'Mentés', exact: true });

  await step('the senders with their addresses', async () => {
    await visit('/p/AC/settings/email');
    await renameButton().waitFor();
    await shot('a-senders');
  });

  await step('the copy button: copied, then refused', async () => {
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      });
    });
    await firstRow()
      .getByRole('button', { name: /címének másolása/ })
      .click();
    await page.getByText('Másolva').first().waitFor();
    await shot('a-copied');
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      });
    });
    await firstRow()
      .getByRole('button', { name: /címének másolása/ })
      .click();
    await page.getByRole('alert').first().waitFor();
    await shot('a-copy-failed');
  });

  await step('the rename form: open, taken, bad name, saved', async () => {
    await visit('/p/AC/settings/email');
    await renameButton().click();
    await field().waitFor();
    await shot('a-rename-open');
    await field().fill('kata-desk');
    await save().click();
    await page.getByRole('alert').first().waitFor();
    await shot('a-rename-taken');
    await field().fill('R-valasz');
    await save().click();
    await page.getByText('Kisbetűvel vagy számmal kezdődjön').waitFor();
    await shot('a-rename-invalid');
    state.delay = 4000;
    await field().fill('ugyfelszolgalat');
    await save().click();
    await page.getByText('Mentés…').first().waitFor();
    await shot('a-rename-saving');
    state.delay = 0;
    await page.getByText('Mentve.').waitFor();
    await shot('a-saved');
  });

  await step('a name two projects use, and the channel off', async () => {
    state.conflict = ai[1].handle;
    await visit('/p/AC/settings/email');
    await page.getByText('Nincs címe').waitFor();
    await shot('a-conflict');
    state.conflict = null;
    state.channelOn = false;
    await visit('/p/AC/settings/email');
    await page.getByText('Címe a levelezés bekapcsolásakor').first().waitFor();
    await shot('a-channel-off');
  });

  await step('the thread and the list with a mail that came in', async () => {
    await visit(`/p/AC/messages/with/${sender.handle}`);
    await page.getByText('E-mailben érkezett').first().waitFor();
    await shot('b-thread-email');
    // The short list of the Team page (the side column is desktop only).
    await page.setViewportSize({ width: WIDTHS[0], height: 982 });
    await visit('/p/AC/team');
    await page.locator('[title="E-mailben érkezett"]').first().waitFor();
    await shoot(page, 'b-list-email', { widths: [WIDTHS[0]] });
  });

  await step('the parked mail of a sender who may not write', async () => {
    await visit('/p/AC/inbox');
    await page.getByText('Félretettünk egy levelet').first().waitFor();
    await shot('d-park-not-allowed');
  });
};
