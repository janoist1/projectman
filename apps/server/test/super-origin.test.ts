import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { connectedActorOf, routes, SuperAuditPage } from '@projectman/shared';
import type { ConnectedActor, SuperActor } from '@projectman/shared';
import type { FastifyRequest } from 'fastify';
import { createDomainHarness, OWNER, OWNER_ACTOR } from './helpers/domain-harness';
import type { DomainHarness } from './helpers/domain-harness';
import { flush } from './helpers/fakes';
import { addHumanAndLogin, createAppHarness, createProject, inject, setupOwner } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { actorOf, authorOf, currentUser, senderOf } from '../src/api/context';
import { runGit } from '../src/config/git';
import { bindSuperPrincipal } from '../src/core/members';
import type { ProjectAccess } from '../src/core/members';
import type { IntegratorPrincipal } from '../src/contracts';
import { DomainError } from '../src/kernel';

const CREDENTIAL = { id: 'ikey_test_1', prefix: 'pmi_aaaaaaaa' };
const OTHER_CREDENTIAL = { id: 'ikey_test_2', prefix: 'pmi_bbbbbbbb' };
// A marker that must never reach the audit: it stands for free-form request data.
const MARKER = 'FREE-FORM-MARKER-7431';

// The connected Claude of the owner holding the key (decision 66): the holder in person, with the key behind.
const SUPER: ConnectedActor = connectedActorOf('owner', CREDENTIAL);
// The step the old model recorded under the Operator, still readable.
const LEGACY_SUPER: SuperActor = {
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

  // These origin/audit fixtures simulate the authenticated execution PM-759 now requires at domain entry.
  const authenticated = <T>(run: () => T, requestId = 'req-fixture', issuer?: string): T => {
    let user = h.repos.users.list()[0];
    if (!user) {
      user = {
        id: 'user-1',
        name: OWNER.name,
        email: OWNER.email,
        passwordHash: 'unused-test-hash',
        createdAt: new Date().toISOString(),
      };
      h.repos.users.insert(user);
    }
    const secret = 'pmi_origin_fixture';
    if (!h.repos.integratorKeys.activeById(CREDENTIAL.id, new Date().toISOString()))
      h.repos.integratorKeys.create({
        id: CREDENTIAL.id,
        userId: user.id,
        prefix: CREDENTIAL.prefix,
        hash: createHash('sha256').update(secret).digest('hex'),
        mode: 'super',
        at: new Date().toISOString(),
        expiresAt: null,
      });
    return h.domain.superOperator.run(
      {
        principal: h.auth.resolveIntegratorCredential(secret, 'rest')!,
        email: OWNER.email,
        requestId,
        projectKey: 'AR',
        ...(issuer ? { issuer } : {}),
      },
      run,
    );
  };
  const patch = (...args: Parameters<typeof h.domain.projects.patch>) =>
    args[2].actor.operatorMode === 'super' || args[2].actor.through
      ? authenticated(() => h.domain.projects.patch(...args), args[2].author.superRequestId)
      : h.domain.projects.patch(...args);

  it('stores the super origin next to the old actor columns and leaves old rows alone', async () => {
    h = await createDomainHarness();
    const plain = await h.domain.messaging.send('AR', 'owner', {
      to: ['pm'],
      text: 'Fictional old note',
    });
    const sent = await authenticated(() =>
      h.domain.messaging.send('AR', 'owner', { to: ['pm'], text: 'Fictional super note' }, { actor: SUPER }),
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
    expect(superRow).toMatchObject({ from_handle: 'owner', via: 'integrator' });
    expect(JSON.parse(superRow.actor_meta!)).toEqual({
      through: { holder: 'owner', credential: CREDENTIAL },
    });
    expect(rows.find((r) => r.id === plain.id)).toMatchObject({ via: null, actor_meta: null });

    // The timeline event of the same step reads back with the origin; an older event has none.
    const events = h.repos.timeline.list('AR');
    const sentEvent = events.find((e) => e.actor.through !== undefined);
    expect(sentEvent?.actor).toEqual(SUPER);
    const oldEvent = events.find((e) => e.actor.handle === 'owner' && e.actor.through === undefined);
    expect(oldEvent?.actor.through).toBeUndefined();
    const raw = h.repos.db
      .prepare(
        'SELECT actor_kind, actor_handle, actor_via, actor_meta FROM timeline_events WHERE actor_meta IS NOT NULL',
      )
      .all() as { actor_kind: string; actor_handle: string; actor_via: string; actor_meta: string }[];
    expect(raw.length).toBeGreaterThan(0);
    expect(raw[0]).toMatchObject({ actor_kind: 'human', actor_handle: 'owner', actor_via: 'integrator' });
  });

  it('reads an unreadable or disagreeing meta column as the old actor', async () => {
    h = await createDomainHarness();
    const message = await authenticated(() =>
      h.domain.messaging.send('AR', 'owner', { to: ['pm'], text: 'Fictional super note' }, { actor: SUPER }),
    );
    h.repos.db.prepare('UPDATE team_messages SET actor_meta = ? WHERE id = ?').run('{not json', message.id);
    expect(h.repos.messages.list('AR').find((m) => m.id === message.id)?.actor).toBeUndefined();
    h.repos.db
      .prepare('UPDATE team_messages SET actor_meta = ?, via = NULL WHERE id = ?')
      .run(JSON.stringify({ through: SUPER.through }), message.id);
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
    const resolved = await authenticated(() =>
      h.domain.inbox.resolve(
        'AR',
        viaSuper.id,
        { optionId: 'seen' },
        { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER },
      ),
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

  it('refuses configuration changes by an integrator actor without super origin', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    await expect(
      h.domain.projects.patch(
        'AR',
        { baseVersion: loaded.version, project: { name: 'Unbound integrator change' } },
        { actor: { ...OWNER_ACTOR, via: 'integrator' }, author: { ...OWNER, via: 'integrator' } },
      ),
    ).rejects.toMatchObject({ code: 'insufficient_access', status: 403 });
    expect((await h.domain.projects.load('AR')).version).toBe(loaded.version);
  });

  it('commits a configuration change in the super mode with trailers, history and an audit', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    const patched = await patch(
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
    await patch(
      'AR',
      { baseVersion: loaded.version, project: { name: 'Fictional trailers project' } },
      { actor: SUPER, author: superAuthor() },
    );
    const { stdout } = await runGit(join(h.dir, 'customization'), ['log', '-1', '--format=%B']);
    expect(stdout).toContain('Projectman-Connected-Holder: owner');
    expect(stdout).toContain(`Projectman-Credential-Id: ${CREDENTIAL.id}`);
    expect(stdout).toContain(`Projectman-Credential-Prefix: ${CREDENTIAL.prefix}`);
    // Only the credential's id and prefix: the audit's request data and any secret stay out of the commit.
    expect(stdout).not.toContain('pmi_aaaaaaaa_');
  });

  it('refuses a super actor that no bound owner backs, and audits the refusal', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    const patch = { baseVersion: loaded.version, project: { name: 'Fictional refused project' } };
    // The actor alone, with a plain author, grants nothing; it has no credential to attribute, so no entry.
    await expect(
      authenticated(() =>
        h.domain.projects.patch('AR', patch, { actor: SUPER, author: { ...OWNER, via: 'integrator' } }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(auditRows()).toEqual([]);
    // The token's owner is not an owner (a made-up handle).
    await expect(
      authenticated(() =>
        h.domain.projects.patch('AR', patch, {
          actor: SUPER,
          author: { ...superAuthor('req-nobody'), authorizedBy: 'nobody' },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    // A different credential in the author than in the actor.
    await expect(
      authenticated(() =>
        h.domain.projects.patch('AR', patch, {
          actor: SUPER,
          author: { ...superAuthor('req-other'), superActor: connectedActorOf('owner', OTHER_CREDENTIAL) },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect((await h.configStore.history('AR', 1))[0]?.actor).toBeUndefined();
    // Both refusals are audited with their code only, under the credential the author carries.
    const byRequest = (id: string) =>
      auditRows()
        .filter((r) => r.requestId === id)
        .map((r) => [r.outcome, r.errorCode, r.prefix]);
    expect(byRequest('req-nobody').sort()).toEqual([
      ['refused', 'insufficient_access', CREDENTIAL.prefix],
      ['started', null, CREDENTIAL.prefix],
    ]);
    expect(byRequest('req-other').sort()).toEqual([
      ['refused', 'insufficient_access', OTHER_CREDENTIAL.prefix],
      ['started', null, OTHER_CREDENTIAL.prefix],
    ]);
  });

  it('allows a bound super step to change the fix-round policy', async () => {
    h = await createDomainHarness();
    const loaded = await h.domain.projects.load('AR');
    await expect(
      patch(
        'AR',
        { baseVersion: loaded.version, limits: { maxFixRounds: 9 } },
        { actor: SUPER, author: superAuthor('req-rule') },
      ),
    ).resolves.toHaveProperty('version');
    const rows = auditRows().filter((r) => r.requestId === 'req-rule');
    expect(rows.map((r) => [r.outcome, r.errorCode]).sort()).toEqual([
      ['started', null],
      ['succeeded', null],
    ]);
    expect((await h.configStore.history('AR', 1))[0]?.actor).toEqual(SUPER);
  });

  it('audits an unbounded revert of a version made in the super mode', async () => {
    h = await createDomainHarness();
    const first = await h.domain.projects.load('AR');
    await patch(
      'AR',
      { baseVersion: first.version, project: { name: 'Fictional before revert' } },
      { actor: SUPER, author: superAuthor('req-edit') },
    );
    await authenticated(
      () =>
        h.domain.projects.revert('AR', first.version, { actor: SUPER, author: superAuthor('req-revert') }),
      'req-revert',
    );
    const rows = auditRows().filter((r) => r.requestId === 'req-revert');
    expect(rows.map((r) => r.outcome).sort()).toEqual(['started', 'succeeded']);
    const head = (await h.configStore.history('AR', 1))[0]!;
    expect(head.actor).toEqual(SUPER);
    expect(head.superAuditId).toMatch(/^saud_/);
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
      patch(
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
        hasSuperAuditCommit: async (...args: Parameters<typeof inner.hasSuperAuditCommit>) => {
          if (mode === 'blind') throw new Error(`cannot read ${MARKER}`);
          return inner.hasSuperAuditCommit(...args);
        },
      }),
    });
    let loaded = await h.domain.projects.load('AR');
    await expect(
      patch(
        'AR',
        { baseVersion: loaded.version, project: { name: 'Fictional never landed' } },
        { actor: SUPER, author: superAuthor('req-before') },
      ),
    ).rejects.toThrow();
    mode = 'blind';
    loaded = await h.domain.projects.load('AR');
    await expect(
      patch(
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
    await patch(
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
    // A leftover whose commit did land (a crash after the commit): its id is in a trailer far back in the history.
    const before = await h.domain.projects.load('AR');
    await h.configStore.save(
      'AR',
      { ...before.config, project: { ...before.config.project, name: 'Fictional landed project' } },
      {
        author: { ...superAuthor('req-landed'), superAuditId: 'saud_landed' },
        message: 'Update project',
        previous: before.config,
      },
    );
    await h.domain.projects.syncFromStore();
    h.repos.superAudit.insert({
      id: 'saud_landed',
      projectKey: 'AR',
      taskKey: null,
      keyId: CREDENTIAL.id,
      prefix: CREDENTIAL.prefix,
      operatorMode: 'super',
      requestId: 'req-landed',
      handoffId: null,
      operation: 'config_commit',
      outcome: 'started',
      errorCode: null,
      settlesId: null,
      createdAt: '2026-10-17T08:00:01.000Z',
    });
    for (let i = 0; i < 22; i += 1) {
      const current = await h.domain.projects.load('AR');
      await h.domain.projects.patch(
        'AR',
        { baseVersion: current.version, project: { name: `Fictional later edit ${i}` } },
        { actor: OWNER_ACTOR, author: OWNER },
      );
    }
    // The startup settling of the projects: the landed one is `succeeded`, the lost one `failed`.
    expect(await h.domain.projects.settleSuperAudit()).toBe(2);
    const orphan = auditRows().filter((r) => r.requestId === 'req-orphan');
    expect(orphan.map((r) => [r.outcome, r.errorCode]).sort()).toEqual([
      ['failed', 'operation_lost'],
      ['started', null],
    ]);
    const found = auditRows().filter((r) => r.requestId === 'req-landed');
    expect(found.map((r) => r.outcome).sort()).toEqual(['started', 'succeeded']);
    // Settling again changes nothing.
    expect(await h.domain.projects.settleSuperAudit()).toBe(0);
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
    const second = connectedActorOf('owner', OTHER_CREDENTIAL);
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

  it('records a pause and a resume made with a super key as the holder`s connected Claude', async () => {
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
    await authenticated(() => h.domain.pauses.pause(scope, by));
    await authenticated(() => h.domain.pauses.resume(scope, by));
    expect(typed('team_paused').at(-1)?.actor).toEqual(SUPER);
    expect(typed('team_resumed').at(-1)?.actor).toEqual(SUPER);

    // Without a credential the same request is the owner through the integrator, as before.
    await h.domain.pauses.pause(scope, { userId: 'usr_owner', source: 'app', via: 'integrator' });
    expect(typed('team_paused').at(-1)?.actor).toEqual({ kind: 'human', handle: 'owner', via: 'integrator' });
  });

  it('stops a session as the super actor and records it on the stop event', async () => {
    h = await createDomainHarness();
    const { session } = await h.domain.sessions.ensureSession('AR', 'dev-1', { type: 'general' });
    await authenticated(() => h.domain.sessions.stop('AR', session.id, { kind: 'manual', by: SUPER }));
    const ended = h.repos.timeline.list('AR').find((e) => e.type === 'session_ended');
    expect(ended).toBeDefined();
    expect(JSON.stringify(ended?.data)).toContain('through');
    expect(JSON.stringify(ended?.data)).toContain(CREDENTIAL.prefix);
  });

  it('starts a card as the super actor and keeps the origin on the start events', async () => {
    h = await createDomainHarness();
    const task = await h.domain.tasks.create('AR', { title: 'Fictional super start' }, OWNER_ACTOR);
    await authenticated(() =>
      h.domain.taskStarts.start('AR', task.key, {
        assignee: 'dev-1',
        actor: SUPER,
        author: superAuthor('req-start'),
      }),
    );
    const withOrigin = h.repos.timeline.list('AR').filter((e) => e.actor.through !== undefined);
    expect(withOrigin.length).toBeGreaterThan(0);
    expect(withOrigin.every((e) => e.actor.through?.credential.prefix === CREDENTIAL.prefix)).toBe(true);
  });

  describe('binding a principal', () => {
    const config = async () => h.domain.projects.config('AR');
    const access = (overrides: Partial<ProjectAccess> = {}): ProjectAccess =>
      ({ projectKey: 'AR', handle: 'owner', access: 'owner', member: {}, ...overrides }) as ProjectAccess;

    it('builds the holder in person with the credential behind, from the authenticated principal', async () => {
      h = await createDomainHarness();
      const bound = bindSuperPrincipal(await config(), access(), principal('super'));
      expect(bound.superActor).toEqual(connectedActorOf('owner', CREDENTIAL));
      expect(bound.via).toBe('integrator');
      expect(actorOf(bound)).toEqual(bound.superActor);
    });

    it('builds the queue item issuer with the holder behind it', async () => {
      h = await createDomainHarness();
      const bound = bindSuperPrincipal(await config(), access(), principal('super'), 'pm');
      expect(bound.superActor).toEqual(connectedActorOf('owner', CREDENTIAL, { issuer: 'pm' }));
      expect(senderOf(bound)).toBe('pm');
    });

    it.each([
      ['a read key', () => principal('read'), () => access()],
      ['another project', () => principal('super'), () => access({ projectKey: 'ZZ' })],
    ])('refuses %s', async (_name, makePrincipal, makeAccess) => {
      h = await createDomainHarness();
      const loaded = await config();
      expect(() => bindSuperPrincipal(loaded, makeAccess(), makePrincipal())).toThrow(
        expect.objectContaining({ status: 403 }),
      );
    });

    it('binds in a project without an Operator', async () => {
      h = await createDomainHarness();
      const loaded = await config();
      const noOperator = {
        ...loaded,
        team: { ...loaded.team, members: loaded.team.members.filter((m) => m.handle !== 'operator') },
      };
      expect(bindSuperPrincipal(noOperator, access(), principal('super')).superActor).toEqual(SUPER);
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

    it('serves a login', () => {
      expect(currentUser(fakeRequest(null)).email).toBe('owner@example.com');
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

    it('sends a bound request`s message under the holder`s name, so the sender and the stored actor agree', async () => {
      h = await createDomainHarness();
      const bare = { projectKey: 'AR', handle: 'owner', access: 'owner', member: {} } as ProjectAccess;
      const bound = bindSuperPrincipal(await h.domain.projects.config('AR'), bare, principal('super'));
      expect(senderOf(bound)).toBe('owner');

      const sent = await authenticated(() =>
        h.domain.messaging.send(
          'AR',
          senderOf(bound),
          { to: ['dev-1'], text: 'Fictional super message' },
          { actor: actorOf(bound) },
        ),
      );
      expect(sent).toMatchObject({ from: 'owner', via: 'integrator', actor: SUPER });
      const stored = h.repos.messages.list('AR').find((m) => m.id === sent.id)!;
      expect(stored).toMatchObject({ from: 'owner', actor: SUPER });
      expect(stored.actor?.handle).toBe(stored.from);
      // A connected origin cannot ride on a message from someone else than the actor.
      await expect(
        authenticated(() =>
          h.domain.messaging.send(
            'AR',
            'pm',
            { to: ['dev-1'], text: 'Fictional mismatch' },
            { actor: actorOf(bound) },
          ),
        ),
      ).rejects.toThrow(/super-mode message/);
    });

    it('stores a queue item step under the issuer`s name with the holder behind it', async () => {
      h = await createDomainHarness();
      const issuerStep = connectedActorOf('owner', CREDENTIAL, { issuer: 'pm' });
      const sent = await authenticated(
        () =>
          h.domain.messaging.send(
            'AR',
            'pm',
            { to: ['dev-1'], text: 'Fictional queue item step' },
            { actor: issuerStep },
          ),
        'req-issuer',
        'pm',
      );
      expect(sent).toMatchObject({ from: 'pm', actor: issuerStep });
      const stored = h.repos.messages.list('AR').find((m) => m.id === sent.id)!;
      expect(stored.actor).toEqual(issuerStep);
    });

    it('delivers the answer to an agent`s question under the holder`s name when the resolver is a connected step', async () => {
      h = await createDomainHarness();
      const question = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        title: 'Fictional question',
        payload: { question: 'Which fictional option?', responsePurpose: 'information' },
        options: [{ id: 'answer', label: 'answer', style: 'primary' }],
      });
      const relayed = await authenticated(() =>
        h.domain.inbox.resolve(
          'AR',
          question.id,
          { optionId: 'answer', note: 'The first fictional option.' },
          { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER },
        ),
      );
      expect(relayed.resolution?.ownerAnswerRelayed).toBe(true);
      await flush();
      const answers = h.repos.messages
        .list('AR')
        .filter((m) => m.to.includes('dev-1') && m.body.includes('The first fictional option.'));
      expect(answers).toHaveLength(1);
      expect(answers[0]).toMatchObject({ from: 'owner', actor: SUPER });
    });

    it.each([
      { question: 'Which fictional option?' },
      { question: 'Which fictional option?', responsePurpose: 'owner_decision' as const },
    ])('records an Operator decision for question purpose $responsePurpose', async (payload) => {
      h = await createDomainHarness();
      const question = h.domain.inbox.create({
        projectKey: 'AR',
        kind: 'question',
        assignees: ['owner'],
        source: 'dev-1',
        sessionId: null,
        title: 'Fictional question',
        payload,
        options: [{ id: 'answer', label: 'answer', style: 'primary' }],
      });
      const resolved = await authenticated(() =>
        h.domain.inbox.resolve(
          'AR',
          question.id,
          { optionId: 'answer', note: 'A fictional answer.' },
          { handle: 'owner', access: 'owner', via: 'integrator', superActor: SUPER },
        ),
      );
      expect(resolved.resolution).toMatchObject({ by: 'owner', actor: SUPER, superDecision: true });
      expect(resolved.resolution?.ownerAnswerRelayed).toBeUndefined();
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
      { projectKey: 'AR', actor: connectedActorOf('owner', OTHER_CREDENTIAL), requestId: 'req-other' },
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

    // The super key acts as the Operator: it does not read the audit.
    const key = await inject(app.app, 'POST', routes.integratorKeys(), cookie, { mode: 'super' });
    const via = await app.app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${key.json().secret}` },
    });
    expect(via.statusCode).toBe(403);
    expect((await app.app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });
});
