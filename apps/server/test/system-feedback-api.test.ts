import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import type {
  ServerEvent,
  SystemFeedbackForwardingView,
  SystemFeedbackItem,
  SystemFeedbackList,
  SystemFeedbackPrepared,
  SystemFeedbackPreview,
} from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { OWNER } from './helpers/domain-harness';

const INPUT = {
  title: 'A tool refused a plain read',
  what: 'The Operator could not read a card and got a refusal without a reason.',
  workaround: 'Asked the owner.',
  fix: 'Say why a read is refused.',
};

describe('system feedback API (PM-479)', () => {
  let h: AppHarness;
  const cookies: Record<string, string> = {};
  let bearer: { authorization: string };
  let arItem: SystemFeedbackItem;
  let brItem: string;

  const feedback = () => h.app.projectman.domain.systemFeedback;
  const get = (cookie: string, url: string) => inject(h.app, 'GET', url, cookie);
  const send = (cookie: string, method: 'POST' | 'PUT', url: string, payload: unknown = {}) =>
    inject(h.app, method, url, cookie, payload);
  const errorCode = (response: { json: () => unknown }) =>
    (response.json() as { error: { code: string } }).error.code;

  beforeEach(async () => {
    h = await createAppHarness();
    cookies.owner = await setupOwner(h.app);
    await createProject(h, cookies.owner);
    await h.app.projectman.domain.projects.create(
      { key: 'BR', name: 'Second', workspacePath: h.workspace, templateId: 'test' },
      OWNER,
    );
    // Owner of AR only: the owner of one project is not the owner of the instance.
    cookies.projectOwner = await addHumanAndLogin(h.app, { handle: 'pat', access: 'owner' });
    cookies.developer = await addHumanAndLogin(h.app, { handle: 'robin', access: 'developer' });
    cookies.client = await addHumanAndLogin(h.app, { handle: 'cleo', access: 'client' });
    const key = await send(cookies.owner, 'POST', routes.integratorKey(), { expiresInDays: 30 });
    bearer = { authorization: `Bearer ${key.json().secret}` };
    arItem = await feedback().record('AR', 'operator', 'ses_1', INPUT);
    brItem = 'fb_other_project';
    h.app.projectman.repos.systemFeedback.insert({
      id: brItem,
      projectKey: 'BR',
      title: 'Other',
      what: 'w',
      workaround: 'w',
      fix: 'f',
      createdAt: new Date().toISOString(),
      version: 'dev',
      sessionId: null,
    });
  });
  afterEach(async () => h.close());

  describe('who may read', () => {
    it('gives the instance owner every item and the forwarding setting', async () => {
      const response = await get(cookies.owner!, routes.systemFeedback());
      expect(response.statusCode, response.body).toBe(200);
      const list = response.json() as SystemFeedbackList;
      expect(list.access).toBe('manage');
      expect(list.items.map((item) => item.id).sort()).toEqual([arItem.id, brItem].sort());
      expect(list.forwarding).toMatchObject({ mode: 'manual' });
      expect((await get(cookies.owner!, routes.systemFeedbackSummary())).json()).toEqual({ newCount: 2 });
    });

    it('gives a project owner only the items of their own project, to read', async () => {
      const own = await get(cookies.projectOwner!, `${routes.systemFeedback()}?project=AR`);
      expect(own.statusCode, own.body).toBe(200);
      const list = own.json() as SystemFeedbackList;
      expect(list).toMatchObject({ access: 'read', forwarding: null });
      expect(list.items.map((item) => item.id)).toEqual([arItem.id]);
      for (const url of [`${routes.systemFeedback()}?project=BR`, routes.systemFeedback()]) {
        const other = await get(cookies.projectOwner!, url);
        expect(other.statusCode, url).toBe(403);
      }
      expect((await get(cookies.projectOwner!, routes.systemFeedbackSummary())).statusCode).toBe(403);
    });

    it.each(['developer', 'client'])('refuses a %s everything', async (who) => {
      for (const url of [
        routes.systemFeedback(),
        `${routes.systemFeedback()}?project=AR`,
        routes.systemFeedbackSummary(),
        routes.systemFeedbackPreview(arItem.id),
      ])
        expect((await get(cookies[who]!, url)).statusCode, url).toBe(403);
    });

    it('refuses an unknown project and an anonymous caller', async () => {
      expect((await get(cookies.owner!, `${routes.systemFeedback()}?project=ZZ`)).statusCode).toBe(404);
      expect((await inject(h.app, 'GET', routes.systemFeedback())).statusCode).toBe(401);
    });
  });

  describe('who may change', () => {
    const writes: Array<[string, 'POST' | 'PUT', () => string, unknown]> = [
      ['forwarding', 'PUT', () => routes.systemFeedbackForwarding(), { mode: 'off' }],
      ['card', 'POST', () => routes.systemFeedbackCard(arItem.id), {}],
      ['prepare', 'POST', () => routes.systemFeedbackPrepare(arItem.id), { title: 'a', body: 'b' }],
      ['forwarded', 'POST', () => routes.systemFeedbackForwarded(arItem.id), {}],
      ['dismiss', 'POST', () => routes.systemFeedbackDismiss(arItem.id), { reason: 'no' }],
      ['restore', 'POST', () => routes.systemFeedbackRestore(arItem.id), {}],
    ];

    it.each(writes)(
      'refuses a project owner, a developer and a client on %s',
      async (_name, method, url, body) => {
        for (const who of ['projectOwner', 'developer', 'client'])
          expect((await send(cookies[who]!, method, url(), body)).statusCode, who).toBe(403);
        expect(
          feedback()
            .list({ access: 'manage' })
            .items.find((i) => i.id === arItem.id),
        ).toMatchObject({
          state: 'new',
        });
      },
    );

    it.each(writes)(
      'refuses the integrator key on %s, whatever its mode',
      async (_name, method, url, body) => {
        const response = await h.app.inject({ method, url: url(), headers: bearer, payload: body as object });
        expect(response.statusCode, response.body).toBe(403);
        expect(errorCode(response)).toBe('owner_login_required');
        expect(response.json().error.details).toEqual({ category: 'system_feedback' });
        expect(feedback().forwardingView().history).toEqual([]);
        expect(h.app.projectman.repos.systemFeedback.get(arItem.id)?.state).toBe('new');
      },
    );
  });

  describe('the owner’s way through an item', () => {
    it('forwards by hand: preview, prepare, mark with an address, and then nothing more', async () => {
      const preview = (
        await get(cookies.owner!, routes.systemFeedbackPreview(arItem.id))
      ).json() as SystemFeedbackPreview;
      expect(preview.repository).toBe('janoist1/projectman');
      const prepared = await send(cookies.owner!, 'POST', routes.systemFeedbackPrepare(arItem.id), {
        title: preview.title,
        body: preview.body,
      });
      expect((prepared.json() as SystemFeedbackPrepared).result).toBe('ready');
      const bad = await send(cookies.owner!, 'POST', routes.systemFeedbackForwarded(arItem.id), {
        issueUrl: 'https://example.com/janoist1/projectman/issues/4',
      });
      expect(bad.statusCode).toBe(400);
      expect(errorCode(bad)).toBe('system_feedback_issue_url');
      const done = await send(cookies.owner!, 'POST', routes.systemFeedbackForwarded(arItem.id), {
        issueUrl: 'https://github.com/janoist1/projectman/issues/4',
      });
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toMatchObject({ state: 'forwarded', forwarded: { kind: 'issue' } });
      const again = await send(cookies.owner!, 'POST', routes.systemFeedbackDismiss(arItem.id), {
        reason: 'late',
      });
      expect(again.statusCode).toBe(409);
      expect(errorCode(again)).toBe('system_feedback_wrong_state');
    });

    it('sets the card mode, opens the card as the owner and dismisses and restores', async () => {
      const set = await send(cookies.owner!, 'PUT', routes.systemFeedbackForwarding(), {
        mode: 'card',
        projectKey: 'BR',
      });
      expect(set.statusCode, set.body).toBe(200);
      expect((set.json() as SystemFeedbackForwardingView).history[0]).toMatchObject({ mode: 'card' });
      const card = await send(cookies.owner!, 'POST', routes.systemFeedbackCard(arItem.id));
      expect(card.statusCode, card.body).toBe(200);
      expect(card.json()).toMatchObject({ state: 'forwarded', forwarded: { kind: 'card', taskKey: 'BR-1' } });
      expect(h.app.projectman.domain.tasks.list('BR')).toHaveLength(1);
      expect((await send(cookies.owner!, 'POST', routes.systemFeedbackCard(arItem.id))).statusCode).toBe(409);
      const dismissed = await send(cookies.owner!, 'POST', routes.systemFeedbackDismiss(brItem), {
        reason: 'Not a gap',
      });
      expect(dismissed.json()).toMatchObject({ state: 'dismissed' });
      expect((await send(cookies.owner!, 'POST', routes.systemFeedbackRestore(brItem))).json()).toMatchObject(
        {
          state: 'new',
        },
      );
    });

    it('refuses a card mode without a project, with an unknown one, and an unknown item', async () => {
      for (const body of [{ mode: 'card' }, { mode: 'manual', projectKey: 'AR' }])
        expect((await send(cookies.owner!, 'PUT', routes.systemFeedbackForwarding(), body)).statusCode).toBe(
          400,
        );
      expect(
        (
          await send(cookies.owner!, 'PUT', routes.systemFeedbackForwarding(), {
            mode: 'card',
            projectKey: 'ZZ',
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await send(cookies.owner!, 'POST', routes.systemFeedbackRestore('fb_missing'))).statusCode,
      ).toBe(404);
    });
  });

  describe('the live event', () => {
    interface Socket {
      terminate(): void;
      on(event: 'message', listener: (data: Buffer) => void): void;
    }
    const sockets: Socket[] = [];
    afterEach(() => {
      for (const socket of sockets.splice(0)) socket.terminate();
    });
    const connect = async (cookie: string) => {
      const events: ServerEvent[] = [];
      const ws = (await h.app.injectWS(
        '/ws',
        { headers: { cookie } },
        {
          onInit: (socket) =>
            (socket as unknown as Socket).on('message', (data) =>
              events.push(JSON.parse(data.toString()) as ServerEvent),
            ),
        },
      )) as unknown as Socket;
      sockets.push(ws);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return events;
    };
    const changes = (events: ServerEvent[]) =>
      events.filter((event) => event.type === 'system_feedback_changed').map((event) => event.projectKey);

    it('reaches the instance owner for any item, a project owner for their own and no one else', async () => {
      const [owner, projectOwner, developer, client] = await Promise.all(
        ['owner', 'projectOwner', 'developer', 'client'].map((who) => connect(cookies[who]!)),
      );
      await feedback().record('AR', 'operator', 'ses_2', { ...INPUT, title: 'Second gap' });
      feedback().dismiss(brItem, 'no', { id: 'usr_owner' });
      // The forwarding setting belongs to no project: only the instance owner is told.
      feedback().setForwarding({ mode: 'off' }, { id: 'usr_owner' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(changes(owner!)).toEqual(['AR', 'BR', null]);
      expect(changes(projectOwner!)).toEqual(['AR']);
      expect(changes(developer!)).toEqual([]);
      expect(changes(client!)).toEqual([]);
    });
  });
});
