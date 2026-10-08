import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '@projectman/shared';
import type { Actor } from '@projectman/shared';
import { addHumanAndLogin, createAppHarness, createProject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

describe('integrator key and involvement audit', () => {
  let h: AppHarness;
  let cookie: string;
  let now: Date;
  beforeEach(async () => {
    now = new Date();
    h = await createAppHarness({ now: () => now });
    cookie = await setupOwner(h.app);
    await createProject(h, cookie);
  });
  afterEach(async () => {
    await h.close();
  });
  const key = async (days: 30 | 90 | 365 | null = 90) => {
    const response = await h.app.inject({
      method: 'POST',
      url: routes.integratorKey(),
      headers: { cookie },
      payload: { expiresInDays: days },
    });
    expect(response.statusCode).toBe(201);
    return response.json() as { secret: string; key: { prefix: string } };
  };

  it('shows a secret once, replaces and revokes it, and never falls back to the cookie', async () => {
    const first = await key();
    const headers = { authorization: `Bearer ${first.secret}`, cookie };
    const me = await h.app.inject({ url: routes.me(), headers });
    expect(me.json()).toMatchObject({ hostOwner: true, via: 'integrator' });
    const stored = await h.app.inject({ url: routes.integratorKey(), headers: { cookie } });
    expect(stored.body).not.toContain(first.secret);
    expect(
      (await h.app.inject({ method: 'POST', url: routes.integratorKey(), headers, payload: {} })).statusCode,
    ).toBe(403);
    const second = await key(null);
    expect((await h.app.inject({ url: routes.me(), headers })).statusCode).toBe(401);
    expect(
      (await h.app.inject({ url: routes.me(), headers: { authorization: `Bearer ${second.secret}` } }))
        .statusCode,
    ).toBe(200);
    expect(
      (await h.app.inject({ method: 'DELETE', url: routes.integratorKey(), headers: { cookie } })).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          url: routes.me(),
          headers: { cookie, authorization: `Bearer ${second.secret}` },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await h.app.inject({ url: routes.me(), headers: { cookie, authorization: 'Bearer pmi_unknown' } })
      ).json().error.code,
    ).toBe('integrator_key_invalid');
    expect(
      (await h.app.inject({ url: routes.me(), headers: { cookie, authorization: 'Bearer malformed' } }))
        .statusCode,
    ).toBe(401);
  });

  it('requires HTTPS for remote bearer requests without cookie fallback or key usage updates', async () => {
    const { secret } = await key();
    const userId = h.app.projectman.repos.users.list()[0]!.id;
    const before = h.app.projectman.auth.integratorKey(userId)?.lastUsedAt;
    for (const extra of [{}, { cookie }]) {
      const response = await h.app.inject({
        url: routes.me(),
        remoteAddress: '100.64.0.7',
        headers: { host: 'projectman.example', authorization: `Bearer ${secret}`, ...extra },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('integrator_https_required');
      expect(h.app.projectman.auth.integratorKey(userId)?.lastUsedAt).toBe(before);
    }
    expect(
      (
        await h.app.inject({
          url: routes.me(),
          remoteAddress: '127.0.0.1',
          headers: { host: 'localhost', authorization: `Bearer ${secret}` },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await h.app.inject({
          url: routes.me(),
          remoteAddress: '127.0.0.1',
          headers: {
            host: 'projectman.example',
            'x-forwarded-for': '100.64.0.7',
            'x-forwarded-proto': 'https',
            authorization: `Bearer ${secret}`,
          },
        })
      ).statusCode,
    ).toBe(200);
  });

  it('expires keys and limits key management to the host owner cookie', async () => {
    const { secret } = await key(30);
    const other = await addHumanAndLogin(h.app, { handle: 'colleague', access: 'owner' });
    for (const method of ['GET', 'POST', 'DELETE'] as const) {
      expect(
        (
          await h.app.inject({
            method,
            url: routes.integratorKey(),
            headers: { cookie: other },
            ...(method === 'POST' ? { payload: {} } : {}),
          })
        ).statusCode,
      ).toBe(403);
    }
    now = new Date(now.getTime() + 30 * 86_400_000);
    expect(
      (await h.app.inject({ url: routes.me(), headers: { authorization: `Bearer ${secret}` } })).statusCode,
    ).toBe(401);
    expect(h.app.projectman.auth.integratorKey(h.app.projectman.repos.users.list()[0]!.id)?.state).toBe(
      'expired',
    );
  });

  it('refuses approvals but accepts a forwarded answer with its integrator attribution', async () => {
    const { secret } = await key();
    const headers = { authorization: `Bearer ${secret}` };
    for (const kind of ['decision', 'permission', 'approval', 'boundary'] as const) {
      const item = h.app.projectman.domain.inbox.create({
        projectKey: 'AR',
        kind,
        assignees: ['owner'],
        source: 'dev-1',
        title: 'Approval',
        payload: {},
        options: [{ id: 'approve', label: 'approve', style: 'primary' }],
      });
      const response = await h.app.inject({
        method: 'POST',
        url: routes.resolveInbox('AR', item.id),
        headers,
        payload: { optionId: 'approve' },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('owner_approval_required');
      expect(h.app.projectman.domain.inbox.get('AR', item.id).state).toBe('open');
      if (kind === 'decision') {
        expect(
          (
            await h.app.inject({
              method: 'POST',
              url: routes.resolveInbox('AR', item.id),
              headers: { cookie },
              payload: { optionId: 'approve' },
            })
          ).statusCode,
        ).toBe(200);
      }
    }
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.decideBoundary('AR', 'bnd_unavailable'),
          headers,
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
    const question = h.app.projectman.domain.inbox.create({
      projectKey: 'AR',
      kind: 'question',
      assignees: ['owner'],
      source: 'dev-1',
      title: 'Which colour?',
      payload: {},
      options: [{ id: 'answer', label: 'answer', style: 'secondary' }],
    });
    const answer = await h.app.inject({
      method: 'POST',
      url: routes.resolveInbox('AR', question.id),
      headers,
      payload: { optionId: 'answer', note: 'Blue' },
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json().resolution).toMatchObject({ by: 'owner', via: 'integrator', note: 'Blue' });
  });

  it('attributes labels, starts, messages and manual stops to the integrator', async () => {
    const { secret } = await key();
    const headers = { authorization: `Bearer ${secret}` };
    const created = await h.app.inject({
      method: 'POST',
      url: routes.tasks('AR'),
      headers,
      payload: { title: 'Audit' },
    });
    expect(created.statusCode).toBe(201);
    const taskKey = created.json().key as string;
    const label = await h.app.inject({
      method: 'POST',
      url: routes.taskLabels('AR', taskKey),
      headers,
      payload: { add: ['plain-tag'] },
    });
    expect(label.statusCode).toBe(200);
    const forbidden = await h.app.inject({
      method: 'POST',
      url: routes.taskLabels('AR', taskKey),
      headers,
      payload: { add: ['merge-ok'] },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json().error.code).toBe('owner_approval_required');
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: routes.taskLabels('AR', taskKey),
          headers: { cookie },
          payload: { add: ['merge-ok'] },
        })
      ).statusCode,
    ).toBe(200);
    const start = await h.app.inject({
      method: 'POST',
      url: routes.startTask('AR', taskKey),
      headers,
      payload: { assignee: 'dev-1' },
    });
    expect(start.statusCode).toBe(200);
    const { domain } = h.app.projectman;
    const session = domain.sessions.list('AR', { taskKey })[0]!;
    expect(session.startCause).toMatchObject({ kind: 'start_button', by: { via: 'integrator' } });
    const sent = await h.app.inject({
      method: 'POST',
      url: routes.sendTeamMessage('AR'),
      headers,
      payload: { to: ['dev-1'], text: 'Check the audit.', taskKey },
    });
    expect(sent.statusCode).toBe(202);
    expect(sent.json().via).toBe('integrator');
    const stopped = await h.app.inject({
      method: 'POST',
      url: routes.stopSession('AR', session.id),
      headers,
      payload: { note: 'Wrong card' },
    });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().lastStop).toMatchObject({
      kind: 'manual',
      note: 'Wrong card',
      by: { via: 'integrator' },
    });
    const events = domain.timeline.list('AR', { taskKey });
    expect(events.find((event) => event.type === 'task_labels_changed')?.actor.via).toBe('integrator');
  });

  it('filters, counts and pages events without restarts', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Involvements' },
      { kind: 'human', handle: 'owner' },
    );
    const by: Actor = { kind: 'human', handle: 'owner', via: 'integrator' };
    for (let n = 0; n < 4; n++)
      domain.timeline.append({
        projectKey: 'AR',
        taskKey: task.key,
        actor: { kind: 'ai', handle: 'dev-1' },
        type: 'session_started',
        data: { member: 'dev-1', resumed: n > 0, ...(n ? { cause: { kind: 'start_button', by } } : {}) },
        createdAt: `2026-10-08T10:00:0${n}.000Z`,
      });
    domain.timeline.append({
      projectKey: 'AR',
      taskKey: task.key,
      actor: { kind: 'ai', handle: 'dev-1' },
      type: 'session_ended',
      data: { member: 'dev-1', exitCode: null, stop: { kind: 'restart' } },
    });
    const get = async (suffix: string) =>
      (await h.app.inject({ url: routes.involvements('AR') + suffix, headers: { cookie } })).json();
    const first = await get(`?member=dev-1&task=${task.key}&limit=2&kind=started`);
    expect(first.counts).toEqual({ started: 4, stopped: 0 });
    expect(first.items).toHaveLength(2);
    const second = await get(
      `?member=dev-1&task=${task.key}&limit=2&kind=started&before=${first.nextBefore}`,
    );
    expect(second.items).toHaveLength(2);
    expect(second.nextBefore).toBeNull();
    expect(second.counts).toEqual(first.counts);
    expect(
      new Set([...first.items, ...second.items].map((item: { event: { id: string } }) => item.event.id)).size,
    ).toBe(4);
    expect((await get('?by=integrator')).counts.started).toBe(3);
    expect((await get('?by=owner')).items).toHaveLength(0);
    expect((await get('?by=system')).items).toHaveLength(0);
    expect((await get('?kind=stopped')).items).toHaveLength(0);
    expect((await get('?since=2026-10-08T10:00:02.000Z')).counts.started).toBe(2);
  });

  it('records a note mention and its linked event as the wake-up cause', async () => {
    const { domain } = h.app.projectman;
    const task = await domain.tasks.create(
      'AR',
      { title: 'Mention audit' },
      { kind: 'human', handle: 'owner' },
    );
    await domain.tasks.addNote('AR', task.key, '@dev-1 Check attribution. Then check the link.', {
      kind: 'human',
      handle: 'owner',
    });
    await vi.waitFor(() => expect(domain.sessions.list('AR', { taskKey: task.key })).toHaveLength(1));
    const cause = domain.sessions.list('AR', { taskKey: task.key })[0]!.startCause;
    expect(cause).toMatchObject({
      kind: 'mention',
      by: { kind: 'human', handle: 'owner' },
      quote: '@dev-1 Check attribution.',
    });
    expect(
      domain.timeline.list('AR', { taskKey: task.key }).find((event) => event.id === cause?.eventId)?.type,
    ).toBe('task_note');
    expect(h.app.projectman.repos.messages.get(cause!.messageId!)?.origin).toEqual({
      kind: 'note',
      eventId: cause!.eventId,
    });
  });

  it('hides private cause quotes in the overview and refuses client access', async () => {
    const developer = await addHumanAndLogin(h.app, { handle: 'colleague' });
    const client = await addHumanAndLogin(h.app, { handle: 'client', access: 'client' });
    const sent = await h.app.projectman.domain.messaging.send('AR', 'owner', {
      to: ['dev-1'],
      text: 'Private audit instructions.',
    });
    await vi.waitFor(() =>
      expect(
        h.app.projectman.domain.timeline.list('AR').some((event) => event.type === 'session_started'),
      ).toBe(true),
    );
    const url = routes.involvements('AR');
    const ownerView = await h.app.inject({ url, headers: { cookie } });
    expect(ownerView.body).toContain('Private audit instructions.');
    const otherView = await h.app.inject({ url, headers: { cookie: developer } });
    expect(otherView.statusCode).toBe(200);
    expect(otherView.body).not.toContain('Private audit instructions.');
    expect(otherView.body).toContain(sent.id);
    expect((await h.app.inject({ url, headers: { cookie: client } })).statusCode).toBe(403);
    expect((await h.app.inject({ url: url + '?before=invalid', headers: { cookie } })).statusCode).toBe(400);
  });
});
