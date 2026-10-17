import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isSuperOperatorActor, operatorOf, routes, SuperAuditPage, superActorOf } from '@projectman/shared';
import type { Actor, SuperActor } from '@projectman/shared';
import type { FastifyRequest } from 'fastify';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { actorOf, authorOf, currentUser } from '../src/api/context';
import { runGit } from '../src/config/git';
import { bindSuperPrincipal } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import type { IntegratorPrincipal } from '../src/contracts';
import { DomainError } from '../src/kernel';

const CREDENTIAL = { id: 'ikey_test_1', prefix: 'pmi_aaaaaaaa' };
const OTHER_CREDENTIAL = { id: 'ikey_test_2', prefix: 'pmi_bbbbbbbb' };
// A marker that must never reach the audit: it stands for free-form request data.
const MARKER = 'FREE-FORM-MARKER-7431';

const SUPER: SuperActor = {
  kind: 'ai',
  handle: 'operator',
  via: 'integrator',
  operatorMode: 'super',
  credential: CREDENTIAL,
};

function superAuthor(requestId = 'req-1') {
  return {
    ...OWNER,
    via: 'integrator' as const,
    superActor: SUPER,
    authorizedBy: 'owner',
    superRequestId: requestId,
  };
}

function principal(mode: IntegratorPrincipal['mode'], credential = CREDENTIAL): IntegratorPrincipal {
  return { kind: 'integrator', userId: 'user-1', keyId: credential.id, prefix: credential.prefix, mode };
}

describe('super-mode origin and audit (PM-757)', () => {
  let h: DomainHarness;
  afterEach(() => h?.cleanup());

  const auditRows = (prefix?: string) =>
    h.repos.superAudit.list('AR', { limit: 100, ...(prefix ? { prefix } : {}) }).entries;

  it('stores the super origin next to the old actor columns and leaves old rows alone', async () => {
    h = await createDomainHarness();
    const plain = await h.domain.messaging.send('AR', 'owner', {
      to: ['operator'],
      text: 'Fictional old note',
    });
    const sent = await h.domain.messaging.send(
      'AR',
      'operator',
      { to: ['owner'], text: 'Fictional super note' },
      { actor: SUPER },
    );
    expect(sent.actor).toEqual(SUPER);
    expect(plain.actor).toBeUndefined();

    const stored = h.repos.messages.list('AR');
    expect(stored.find((m) => m.id === sent.id)?.actor).toEqual(SUPER);
    expect(stored.find((m) => m.id === plain.id)?.actor).toBeUndefined();

    // The old columns still say what they said; the new column holds only the origin.
    const rows = h.repos.db
      .prepare('SELECT id, from_handle, via, actor_meta FROM team_messages WHERE id IN (?, ?)')
      .all(sent.id, plain.id) as {
      id: string;
      from_handle: string;
      via: string | null;
      actor_meta: string | null;
    }[];
    const superRow = rows.find((r) => r.id === sent.id)!;
    expect(superRow).toMatchObject({ from_handle: 'operator', via: 'integrator' });
    expect(JSON.parse(superRow.actor_meta!)).toEqual({ operatorMode: 'super', credential: CREDENTIAL });
    expect(rows.find((r) => r.id === plain.id)).toMatchObject({ via: null, actor_meta: null });

    // The timeline event of the same step reads back with the origin; an older event has none.
    const events = h.repos.timeline.list('AR');
    const sentEvent = events.find((e) => e.actor.operatorMode === 'super');
    expect(sentEvent?.actor).toEqual(SUPER);
    const oldEvent = events.find((e) => e.actor.handle === 'owner');
    expect(oldEvent?.actor.operatorMode).toBeUndefined();
    const raw = h.repos.db
      .prepare(
        'SELECT actor_kind, actor_handle, actor_via, actor_meta FROM timeline_events WHERE actor_meta IS NOT NULL',
      )
      .all() as { actor_kind: string; actor_handle: string; actor_via: string; actor_meta: string }[];
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0]).toMatchObject({ actor_kind: 'ai', actor_handle: 'operator', actor_via: 'integrator' });
  });

  it('reads an unreadable or disagreeing meta column as the old actor', async () => {
    h = await createDomainHarness();
    const message = await h.domain.messaging.send(
      'AR',
      'operator',
      { to: ['owner'], text: 'Fictional super note' },
      { actor: SUPER },
    );
    h.repos.db.prepare('UPDATE team_messages SET actor_meta = ? WHERE id = ?').run('{not json', message.id);
    expect(h.repos.messages.list('AR').find((m) => m.id === message.id)?.actor).toBeUndefined();
    h.repos.db
      .prepare('UPDATE team_messages SET actor_meta = ?, via = NULL WHERE id = ?')
      .run(JSON.stringify({ operatorMode: 'super', credential: CREDENTIAL }), message.id);
    expect(h.repos.messages.list('AR').find((m) => m.id === message.id)?.actor).toBeUndefined();
  });

  it('records the super actor on the resolution of an inbox item, with the owner as the resolver', async () => {
    h = await createDomainHarness();
    const create = () =>
      h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'alert',
        assignees: ['owner'],
        source: 'cr',
        sessionId: null,
        title: 'Fictional alert',
        payload: {
          alert: 'session_tokens',
          countedTokens: 2,
          limitTokens: 1,
          workItem: { type: 'general' },
          sessionStartedAt: '2026-10-01T12:00:00.000Z',
        },
        options: [{ id: 'seen', label: 'seen', style: 'primary' }],
      });
    const viaSuper = create();
    const plain = create();
    const resolved = await h.domain.inbox.resolve(
      'AR',
      viaSuper.id,
      { optionId: 'seen' },
      { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER },
    );
    expect(resolved.resolution).toMatchObject({ by: 'owner', via: 'integrator', actor: SUPER });
    expect(h.domain.inbox.get('AR', viaSuper.id).resolution?.actor).toEqual(SUPER);

    const other = await h.domain.inbox.resolve(
      'AR',
      plain.id,
      { optionId: 'seen' },
      { handle: 'owner', access: 'owner' },
    );
    expect(other.resolution?.actor).toBeUndefined();
    await flush();
  });

  it('commits a configuration change in the super mode with trailers, history and an audit', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    const patched = await h.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, project: { name: 'Fictional renamed project' } },
      { actor: SUPER, author: superAuthor() },
    );
    const history = await h.configStore.history('AR', 5);
    const entry = history[0]!;
    expect(entry.version).toBe(patched.version);
    expect(entry.actor).toEqual(SUPER);
    expect(entry.via).toBe('integrator');
    expect(entry.superAuditId).toMatch(/^saud_/);
    // The trailers are not part of the message the history shows.
    expect(entry.message).not.toMatch(/Projectman-/);

    const rows = auditRows(CREDENTIAL.prefix);
    expect(rows.map((r) => [r.operation, r.outcome]).sort()).toEqual([
      ['config_commit', 'started'],
      ['config_commit', 'succeeded'],
    ]);
    expect(rows.every((r) => r.requestId === 'req-1' && r.prefix === CREDENTIAL.prefix)).toBe(true);
    const changed = h.repos.timeline.list('AR').filter((e) => e.type === 'config_changed');
    expect(changed.at(-1)?.actor).toEqual(SUPER);
  });

  it('writes the credential, never a secret, into the commit trailers', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    await h.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, project: { name: 'Fictional trailers project' } },
      { actor: SUPER, author: superAuthor() },
    );
    const { stdout } = await runGit(join(h.dir, 'customization'), ['log', '-1', '--format=%B']);
    expect(stdout).toContain('Projectman-Operator-Mode: super');
    expect(stdout).toContain(`Projectman-Credential-Id: ${CREDENTIAL.id}`);
    expect(stdout).toContain(`Projectman-Credential-Prefix: ${CREDENTIAL.prefix}`);
    // Only the credential's id and prefix: the audit's request data and any secret stay out of the commit.
    expect(stdout).not.toContain('pmi_aaaaaaaa_');
  });

  it('refuses a super actor that no bound owner backs, and audits the refusal', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    const patch = { baseVersion: loaded.version, project: { name: 'Fictional refused project' } };
    // The actor alone, with a plain author, grants nothing.
    await expect(
      h.domain.projects.patch('AR', patch, { actor: SUPER, author: { ...OWNER, via: 'integrator' } }),
    ).rejects.toMatchObject({ status: 403 });
    // The token's owner is not an owner (a made-up handle).
    await expect(
      h.domain.projects.patch('AR', patch, {
        actor: SUPER,
        author: { ...superAuthor(), authorizedBy: 'nobody' },
      }),
    ).rejects.toMatchObject({ status: 403 });
    // A different credential in the author than in the actor.
    await expect(
      h.domain.projects.patch('AR', patch, {
        actor: SUPER,
        author: { ...superAuthor(), superActor: { ...SUPER, credential: OTHER_CREDENTIAL } },
      }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await h.configStore.history('AR', 1))[0]?.actor).toBeUndefined();
    expect(auditRows()).toEqual([]);
  });

  it('settles a commit whose response was lost by the commit itself', async () => {
    // The save lands, then the response is lost: the trailer decides, so the audit says succeeded.
    h = await createDomainHarness({
      configStore: (inner) => ({
        ...inner,
        save: async (...args: Parameters<typeof inner.save>) => {
          const done = await inner.save(...args);
          if (args[2].author.superActor) throw new Error(`lost response ${MARKER}`);
          return done;
        },
      }),
    });
    const loaded = await h.domain.projects.load('AR');
    await expect(
      h.domain.projects.patch(
        'AR',
        { baseVersion: loaded.version, project: { name: 'Fictional lost response' } },
        { actor: SUPER, author: superAuthor('req-lost') },
      ),
    ).rejects.toThrow();
    const rows = auditRows();
    expect(rows.map((r) => r.outcome).sort()).toEqual(['started', 'succeeded']);
  });

  it('audits a commit that never landed as failed and one that cannot be told as unknown', async () => {
    let mode: 'before' | 'blind' = 'before';
    h = await createDomainHarness({
      configStore: (inner) => ({
        ...inner,
        save: async (...args: Parameters<typeof inner.save>) => {
          if (args[2].author.superActor) {
            if (mode === 'blind') await inner.save(...args);
            throw new Error(`transport failure ${MARKER}`);
          }
          return inner.save(...args);
        },
        history: async (...args: Parameters<typeof inner.history>) => {
          if (mode === 'blind') throw new Error(`cannot read ${MARKER}`);
          return inner.history(...args);
        },
      }),
    });
    let loaded = await h.domain.projects.load('AR');
    await expect(
      h.domain.projects.patch(
        'AR',
        { baseVersion: loaded.version, project: { name: 'Fictional never landed' } },
        { actor: SUPER, author: superAuthor('req-before') },
      ),
    ).rejects.toThrow();
    mode = 'blind';
    loaded = await h.domain.projects.load('AR');
    await expect(
      h.domain.projects.patch(
        'AR',
        { baseVersion: loaded.version, project: { name: 'Fictional blind outcome' } },
        { actor: SUPER, author: superAuthor('req-blind') },
      ),
    ).rejects.toThrow();
    const byRequest = (id: string) =>
      auditRows()
        .filter((r) => r.requestId === id)
        .map((r) => [r.outcome, r.errorCode])
        .sort();
    expect(byRequest('req-before')).toEqual([
      ['failed', 'internal_error'],
      ['started', null],
    ]);
    expect(byRequest('req-blind')).toEqual([
      ['started', null],
      ['unknown', 'internal_error'],
    ]);
  });

  it('settles a started entry a crash left, from the commit trailer', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    await h.domain.projects.patch(
      'AR',
      { baseVersion: loaded.version, project: { name: 'Fictional crash survivor' } },
      { actor: SUPER, author: superAuthor('req-ok') },
    );
    // A leftover that never landed: a `started` entry with no commit and no result.
    h.repos.superAudit.insert({
      id: 'saud_orphan',
      projectKey: 'AR',
      taskKey: null,
      keyId: CREDENTIAL.id,
      prefix: CREDENTIAL.prefix,
      operatorMode: 'super',
      requestId: 'req-orphan',
      handoffId: null,
      operation: 'config_commit',
      outcome: 'started',
      errorCode: null,
      settlesId: null,
      createdAt: '2026-10-17T08:00:00.000Z',
    });
    const history = await h.configStore.history('AR', 20);
    const committed = async (auditId: string) => history.some((entry) => entry.superAuditId === auditId);
    expect(await h.domain.superAudit.settleOpen('AR', committed)).toBe(1);
    const orphan = auditRows().filter((r) => r.requestId === 'req-orphan');
    expect(orphan.map((r) => [r.outcome, r.errorCode]).sort()).toEqual([
      ['failed', 'operation_lost'],
      ['started', null],
    ]);
    // Settling again changes nothing.
    expect(await h.domain.superAudit.settleOpen('AR', committed)).toBe(0);
  });

  it('commits a domain change and its audit entry together, or neither', async () => {
    h = await createDomainHarness();
    const exec = { projectKey: 'AR', actor: SUPER, requestId: 'req-tx' };
    const value = h.domain.superAudit.run(exec, 'note_card', () => 42);
    expect(value).toBe(42);
    expect(auditRows().map((r) => [r.operation, r.outcome])).toEqual([['note_card', 'succeeded']]);

    expect(() =>
      h.domain.superAudit.run({ ...exec, requestId: 'req-fail' }, 'note_card', () => {
        h.repos.db
          .prepare(
            "INSERT INTO timeline_events (id, project_key, task_key, session_id, actor_kind, actor_handle, type, data, created_at) VALUES ('evt_tx', 'AR', NULL, NULL, 'system', NULL, 'x', '{}', 'now')",
          )
          .run();
        throw new DomainError('config_conflict', `a refusal ${MARKER}`, { status: 409 });
      }),
    ).toThrow();
    // The change rolled back; the refusal is audited after it, by its code only.
    expect(h.repos.db.prepare("SELECT COUNT(*) AS n FROM timeline_events WHERE id = 'evt_tx'").get()).toEqual(
      { n: 0 },
    );
    const refused = auditRows().find((r) => r.requestId === 'req-fail')!;
    expect(refused).toMatchObject({ outcome: 'refused', errorCode: 'config_conflict' });

    expect(() =>
      h.domain.superAudit.run({ ...exec, requestId: 'req-crash' }, 'note_card', () => {
        throw new Error(`disk on fire ${MARKER}`);
      }),
    ).toThrow();
    expect(auditRows().find((r) => r.requestId === 'req-crash')).toMatchObject({
      outcome: 'failed',
      errorCode: 'internal_error',
    });
  });

  it('keeps the audit to a closed vocabulary and stores no free-form data', async () => {
    h = await createDomainHarness();
    const exec = { projectKey: 'AR', actor: SUPER, requestId: 'req-vocab' };
    expect(() => h.domain.superAudit.run(exec, `Free text ${MARKER}`, () => 1)).toThrow();
    expect(() =>
      h.domain.superAudit.run({ ...exec, requestId: `a b ${MARKER}` }, 'note_card', () => 1),
    ).toThrow();
    // A refusal's code outside the vocabulary is recorded as an internal error, never as text.
    expect(() =>
      h.domain.superAudit.run(exec, 'note_card', () => {
        throw new DomainError('Not A Code' as never, `leaks ${MARKER}`, { status: 400 });
      }),
    ).toThrow();
    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]).toMatchObject({ outcome: 'refused', errorCode: 'internal_error' });
    expect(JSON.stringify(auditRows())).not.toContain(MARKER);
  });

  it('never writes request, config or error text into any audit column', async () => {
    h = await createDomainHarness();
    const exec = { projectKey: 'AR', actor: SUPER, requestId: 'req-clean' };
    expect(() =>
      h.domain.superAudit.run(exec, 'note_card', () => {
        throw new DomainError('config_conflict', `refusal text ${MARKER}`, { status: 409 });
      }),
    ).toThrow();
    expect(() =>
      h.domain.superAudit.run({ ...exec, requestId: 'req-clean-2' }, 'note_card', () => {
        throw new Error(`raw error ${MARKER}`);
      }),
    ).toThrow();
    const dump = JSON.stringify(h.repos.db.prepare('SELECT * FROM super_operation_audit').all());
    expect(dump).not.toContain(MARKER);
    expect(dump).not.toContain('refusal text');
    expect(dump).not.toContain('raw error');
    const columns = (
      h.repos.db.prepare('PRAGMA table_info(super_operation_audit)').all() as { name: string }[]
    )
      .map((c) => c.name)
      .sort();
    expect(columns).toEqual(
      [
        'seq',
        'id',
        'project_key',
        'task_key',
        'key_id',
        'prefix',
        'request_id',
        'handoff_id',
        'operation',
        'outcome',
        'error_code',
        'settles_id',
        'created_at',
      ].sort(),
    );
  });

  it('lists the audit by token prefix, newest first, with a cursor', async () => {
    h = await createDomainHarness();
    for (let i = 0; i < 5; i += 1) {
      h.domain.superAudit.run(
        { projectKey: 'AR', actor: SUPER, requestId: `req-a${i}` },
        'note_card',
        () => i,
      );
    }
    const second = { ...SUPER, credential: OTHER_CREDENTIAL };
    h.domain.superAudit.run({ projectKey: 'AR', actor: second, requestId: 'req-b0' }, 'note_card', () => 0);

    const all = h.domain.superAudit.list('AR', { limit: 50 });
    expect(all.entries).toHaveLength(6);
    expect(all.entries[0]?.requestId).toBe('req-b0');
    expect(all.nextBefore).toBeNull();
    // The audit shows a token by its prefix: the key's id never leaves.
    expect(JSON.stringify(all)).not.toContain(CREDENTIAL.id);

    const mine = h.domain.superAudit.list('AR', { limit: 50, prefix: CREDENTIAL.prefix });
    expect(mine.entries.map((e) => e.requestId)).toEqual(['req-a4', 'req-a3', 'req-a2', 'req-a1', 'req-a0']);

    const first = h.domain.superAudit.list('AR', { limit: 2, prefix: CREDENTIAL.prefix });
    expect(first.entries.map((e) => e.requestId)).toEqual(['req-a4', 'req-a3']);
    expect(first.nextBefore).not.toBeNull();
    const next = h.domain.superAudit.list('AR', {
      limit: 2,
      prefix: CREDENTIAL.prefix,
      before: first.nextBefore!,
    });
    expect(next.entries.map((e) => e.requestId)).toEqual(['req-a2', 'req-a1']);

    expect(() => h.domain.superAudit.list('AR', { limit: 5, before: 'saud_unknown' })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
    // Another project's entries never show here.
    expect(h.domain.superAudit.list('ZZ', { limit: 5 }).entries).toEqual([]);
  });

  it('records a pause and a resume made in the super mode as the Operator with the credential', async () => {
    h = await createDomainHarness();
    h.repos.users.insert({
      id: 'usr_owner',
      name: 'Owner',
      email: 'owner@example.com',
      passwordHash: 'unused-test-hash',
      createdAt: new Date().toISOString(),
    });
    const scope = { scope: 'project', projectKey: 'AR' } as const;
    const typed = (type: string) => h.repos.timeline.list('AR').filter((e) => e.type === type);
    const by = { userId: 'usr_owner', source: 'app', via: 'integrator', credential: CREDENTIAL } as const;
    await h.domain.pauses.pause(scope, by);
    await h.domain.pauses.resume(scope, by);
    expect(typed('team_paused').at(-1)?.actor).toEqual(SUPER);
    expect(typed('team_resumed').at(-1)?.actor).toEqual(SUPER);

    // Without a credential the same request is the owner through the integrator, as before.
    await h.domain.pauses.pause(scope, { userId: 'usr_owner', source: 'app', via: 'integrator' });
    expect(typed('team_paused').at(-1)?.actor).toEqual({ kind: 'human', handle: 'owner', via: 'integrator' });
  });

  it('stops a session as the super actor and records it on the stop event', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    await h.domain.sessions.stop('AR', session.id, { kind: 'manual', by: SUPER });
    const ended = h.repos.timeline.list('AR').find((e) => e.type === 'session_ended');
    expect(ended).toBeDefined();
    expect(JSON.stringify(ended?.data)).toContain('operatorMode');
    expect(JSON.stringify(ended?.data)).toContain(CREDENTIAL.prefix);
  });

  it('starts a card as the super actor and keeps the origin on the start events', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional super start' }, OWNER_ACTOR);
    await h.domain.taskStarts.start('AR', task.key, {
      assignee: 'dev-1',
      actor: SUPER,
      author: superAuthor('req-start'),
    });
    const withOrigin = h.repos.timeline.list('AR').filter((e) => e.actor.operatorMode === 'super');
    expect(withOrigin.length).toBeGreaterThan(0);
    expect(withOrigin.every((e) => e.actor.credential?.prefix === CREDENTIAL.prefix)).toBe(true);
  });

  describe('binding a principal', () => {
    const config = async () => h.domain.projects.config('AR');
    const access = (overrides: Partial<ProjectAccess> = {}): ProjectAccess =>
      ({ projectKey: 'AR', handle: 'owner', access: 'owner', member: {}, ...overrides }) as ProjectAccess;

    it('builds the super actor from the authenticated credential and the server-side Operator', async () => {
      h = await createDomainHarness();
      const bound = bindSuperPrincipal(await config(), access(), principal('super'));
      expect(bound.superActor).toEqual(superActorOf(await config(), CREDENTIAL));
      expect(bound.superActor?.handle).toBe(operatorOf(await config())?.handle);
      expect(bound.via).toBe('integrator');
      expect(isSuperOperatorActor(await config(), bound.superActor as Actor)).toBe(true);
      expect(actorOf(bound)).toEqual(bound.superActor);
    });

    it.each([
      ['a legacy key', () => principal('legacy'), () => access()],
      ['a read key', () => principal('read'), () => access()],
      [
        'a token owner who is no longer an owner',
        () => principal('super'),
        () => access({ access: 'admin' }),
      ],
      ['another project', () => principal('super'), () => access({ projectKey: 'ZZ' })],
    ])('refuses %s', async (_name, makePrincipal, makeAccess) => {
      h = await createDomainHarness();
      const loaded = await config();
      expect(() => bindSuperPrincipal(loaded, makeAccess(), makePrincipal())).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    });

    it('refuses a project without an Operator', async () => {
      h = await createDomainHarness();
      const loaded = await config();
      const noOperator = {
        ...loaded,
        team: { ...loaded.team, members: loaded.team.members.filter((m) => m.handle !== 'operator') },
      };
      expect(() => bindSuperPrincipal(noOperator, access(), principal('super'))).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    });
  });

  describe('request helpers fail closed', () => {
    const fakeRequest = (mode: IntegratorPrincipal['mode'] | null, extra: Record<string, unknown> = {}) =>
      ({
        user: { id: 'user-1', email: 'owner@example.com', name: 'Owner' },
        id: 'req-fake',
        method: 'POST',
        ...(mode ? { principal: principal(mode), via: 'integrator' } : {}),
        ...extra,
      }) as unknown as FastifyRequest;

    it('serves a legacy key and a login as before', () => {
      expect(currentUser(fakeRequest(null)).email).toBe('owner@example.com');
      expect(currentUser(fakeRequest('legacy')).email).toBe('owner@example.com');
      expect(authorOf(fakeRequest('legacy'))).toEqual({
        name: 'Owner',
        email: 'owner@example.com',
        via: 'integrator',
      });
    });

    it.each(['super', 'read'] as const)('refuses a %s key outside a bound project route', (mode) => {
      expect(() => currentUser(fakeRequest(mode))).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => authorOf(fakeRequest(mode))).toThrow(expect.objectContaining({ status: 403 }));
    });

    it('carries the super actor and the request id into the commit author of a bound access', async () => {
      h = await createDomainHarness();
      const bound = bindSuperPrincipal(
        await h.domain.projects.config('AR'),
        { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess,
        principal('super'),
      );
      const author = authorOf(fakeRequest('super'), bound);
      expect(author).toMatchObject({
        via: 'integrator',
        superActor: SUPER,
        authorizedBy: 'owner',
        superRequestId: 'req-fake',
      });
    });

    it('refuses a bound read or legacy principal as a commit author with no super actor', async () => {
      h = await createDomainHarness();
      const bare = { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess;
      expect(() => authorOf(fakeRequest('super'), bare)).toThrow(expect.objectContaining({ status: 403 }));
      expect(() => authorOf(fakeRequest('read'), bare)).toThrow(expect.objectContaining({ status: 403 }));
    });
  });
});

describe('super-mode audit route (PM-757)', () => {
  let app: AppHarness;
  afterEach(async () => app?.close());

  it('serves the owner their own login, paged and filtered by prefix; never a key or a non-owner', async () => {
    app = await createAppHarness();
    const cookie = await setupOwner(app.app);
    await createProject(app, cookie);
    const domain = app.app.projectman.domain;
    for (let i = 0; i < 3; i += 1)
      domain.superAudit.run({ projectKey: 'AR', actor: SUPER, requestId: `req-r${i}` }, 'note_card', () => i);
    domain.superAudit.run(
      { projectKey: 'AR', actor: { ...SUPER, credential: OTHER_CREDENTIAL }, requestId: 'req-other' },
      'note_card',
      () => 0,
    );

    const url = routes.operatorSuperAudit('AR');
    const first = await inject(app.app, 'GET', `${url}?prefix=${CREDENTIAL.prefix}&limit=2`, cookie);
    expect(first.statusCode).toBe(200);
    const page = SuperAuditPage.parse(first.json());
    expect(page.entries.map((e) => e.requestId)).toEqual(['req-r2', 'req-r1']);
    expect(page.nextBefore).not.toBeNull();
    const second = SuperAuditPage.parse(
      (
        await inject(
          app.app,
          'GET',
          `${url}?prefix=${CREDENTIAL.prefix}&limit=2&before=${page.nextBefore}`,
          cookie,
        )
      ).json(),
    );
    expect(second.entries.map((e) => e.requestId)).toEqual(['req-r0']);
    expect(second.nextBefore).toBeNull();
    expect(JSON.stringify(page)).not.toContain(CREDENTIAL.id);

    // A cursor of nowhere, an out-of-range limit and a stray parameter are 400s.
    expect((await inject(app.app, 'GET', `${url}?before=saud_nowhere`, cookie)).statusCode).toBe(400);
    expect((await inject(app.app, 'GET', `${url}?limit=1000`, cookie)).statusCode).toBe(400);
    expect((await inject(app.app, 'GET', `${url}?other=1`, cookie)).statusCode).toBe(400);

    const admin = await addHumanAndLogin(app.app, { handle: 'ada', access: 'admin' });
    expect((await inject(app.app, 'GET', url, admin)).statusCode).toBe(403);

    // The legacy integrator key is the owner's actor but not a person: it does not read the audit.
    const key = await inject(app.app, 'POST', routes.integratorKey(), cookie, undefined);
    const via = await app.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${key.json().secret}` },
    });
    expect(via.statusCode).toBe(403);
    expect((await app.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
});
