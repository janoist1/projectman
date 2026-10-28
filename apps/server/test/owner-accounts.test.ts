import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { routes } from '@projectman/shared';
import { SESSION_COOKIE } from '../src/auth';
import type {
  CreateEngineResponse,
  CreatedOwnerInvitation,
  EngineProvidersView,
  EngineView,
  Me,
  OwnerAccountView,
  OwnerInvitationView,
  ProjectSummary,
} from '@projectman/shared';
import type { EngineRegistry } from '../src/runtime/sessions';
import {
  addHumanAndLogin,
  cookieOf,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
  setupOwner,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { connectRawEngine, rawHello, RawEngineRefusal } from './helpers/cloud-engine';
import { withoutOnboarding } from './helpers/onboarding';

/** Owner accounts (PM-1062) over the whole cloud-mode app: the invitation, the account's own engine and project, the revocation. */
describe('owner accounts', () => {
  let h: AppHarness;
  let host: string;
  let registry: EngineRegistry;
  let hostId: string;
  let now: Date;
  const links: Awaited<ReturnType<typeof connectRawEngine>>[] = [];
  /** An engine of the cloud on the real link: it answers the folder check with `isDirectory`. */
  const connectEngine = async (key: string, isDirectory: (path: string) => boolean = () => true) => {
    links.push(
      await connectRawEngine(h.app, key, rawHello(), (method, params) =>
        method === 'host.is_directory' ? isDirectory((params as { path: string }).path) : null,
      ),
    );
  };
  const guest = { name: 'Guest Owner', email: 'guest@example.test', password: 'a long enough password' };

  const tokenOf = (invite: CreatedOwnerInvitation) => invite.path.split('/').pop()!;
  const invite = async (email = guest.email, who = host) =>
    (await inject(h.app, 'POST', routes.ownerInvitations(), who, { email })).json() as CreatedOwnerInvitation;
  const accept = (created: CreatedOwnerInvitation, who: string | null, body: unknown = guest) =>
    inject(h.app, 'POST', routes.acceptOwnerInvite(tokenOf(created)), who, body);
  /** The guest becomes an owner account; returns their login cookie. */
  const acceptAsGuest = async () => {
    const accepted = await accept(await invite(), null);
    expect(accepted.statusCode, accepted.body).toBe(200);
    return cookieOf(accepted);
  };
  const createEngine = async (who: string, name = 'Guest Mac') =>
    (await inject(h.app, 'POST', routes.engines(), who, { name })).json() as CreateEngineResponse;
  const createGuestProject = (who: string, body: Record<string, unknown> = {}) =>
    withoutOnboarding(h.app.projectman.domain, () =>
      inject(h.app, 'POST', routes.projects(), who, {
        key: 'GU',
        name: 'guest project',
        workspacePath: '/fictional/guest/work',
        templateId: 'test',
        repos: [{ name: 'web', path: '.', github: 'acme/web' }],
        ...body,
      }),
    );
  const errorCode = (res: { json(): unknown }) => (res.json() as { error: { code: string } }).error.code;

  beforeEach(async () => {
    // The host's project is made first (its folder is checked on the host's engine), then the same home starts as a cloud.
    now = new Date('2026-10-27T10:00:00.000Z');
    h = await createAppHarness({ now: () => now });
    host = await setupOwner(h.app);
    await createProject(h, host, 'AR');
    h.app = await h.relaunch({ engineMode: 'cloud', appVersion: 'test', claudeTmpRoots: [] });
    registry = h.app.projectman.engineRegistry!;
    hostId = h.app.projectman.repos.users.findByEmail(OWNER_LOGIN.email)!.id;
  });
  afterEach(async () => {
    for (const link of links.splice(0)) link.close();
    await h.close();
  });

  describe('the invitation', () => {
    it('is made, listed and taken back by the host owner, and the link stops working', async () => {
      const created = await invite();
      expect(created.path).toMatch(/^\/owner-invite\/[\w-]{43}$/);
      const listed = (await inject(h.app, 'GET', routes.ownerInvitations(), host)).json() as {
        invitations: OwnerInvitationView[];
      };
      expect(listed.invitations).toEqual([expect.objectContaining({ id: created.id, email: guest.email })]);
      expect((await inject(h.app, 'GET', routes.ownerInvite(tokenOf(created)))).json()).toMatchObject({
        requiresLogin: false,
      });
      expect((await inject(h.app, 'DELETE', routes.ownerInvitation(created.id), host)).statusCode).toBe(204);
      const gone = await inject(h.app, 'GET', routes.ownerInvite(tokenOf(created)));
      expect([gone.statusCode, errorCode(gone)]).toEqual([404, 'invite_invalid']);
    });

    it('expires after seven days, and a late acceptance is refused', async () => {
      const created = await invite();
      expect(Date.parse(created.expiresAt) - Date.parse(created.createdAt)).toBe(7 * 24 * 60 * 60_000);
      now = new Date(created.expiresAt);
      for (const res of [
        await inject(h.app, 'GET', routes.ownerInvite(tokenOf(created))),
        await accept(created, null),
      ])
        expect([res.statusCode, errorCode(res)]).toEqual([404, 'invite_invalid']);
    });

    it('is refused to everyone but the host owner', async () => {
      const member = await addHumanAndLogin(h.app, { handle: 'pat', access: 'owner' });
      const created = await invite();
      for (const res of [
        await inject(h.app, 'POST', routes.ownerInvitations(), member, { email: 'x@example.test' }),
        await inject(h.app, 'GET', routes.ownerInvitations(), member),
        await inject(h.app, 'DELETE', routes.ownerInvitation(created.id), member),
        await inject(h.app, 'GET', routes.ownerAccounts(), member),
        await inject(h.app, 'POST', routes.revokeOwnerAccount('usr_pat'), member),
      ])
        expect([res.statusCode, errorCode(res)]).toEqual([403, 'owner_only']);
    });

    it('is refused for the host owner’s own address and for one that is an owner account already', async () => {
      const own = await inject(h.app, 'POST', routes.ownerInvitations(), host, { email: OWNER_LOGIN.email });
      expect([own.statusCode, errorCode(own)]).toEqual([409, 'owner_account_exists']);
      await acceptAsGuest();
      const again = await inject(h.app, 'POST', routes.ownerInvitations(), host, { email: guest.email });
      expect([again.statusCode, errorCode(again)]).toEqual([409, 'owner_account_exists']);
    });

    it('creates the account of a new address on acceptance, and spends the link', async () => {
      const created = await invite();
      const accepted = await accept(created, null);
      expect(accepted.json<Me>()).toMatchObject({ email: guest.email, ownerAccount: true, hostOwner: false });
      const again = await accept(created, null);
      expect([again.statusCode, errorCode(again)]).toEqual([404, 'invite_invalid']);
      const accounts = (await inject(h.app, 'GET', routes.ownerAccounts(), host)).json() as {
        accounts: OwnerAccountView[];
      };
      expect(accounts.accounts).toEqual([
        expect.objectContaining({ email: guest.email, name: guest.name, revokedAt: null }),
      ]);
    });

    it('lets an existing account accept only with its own login', async () => {
      const dev = await addHumanAndLogin(h.app, { handle: 'dev1' });
      const created = await invite('dev1@example.test');
      expect((await inject(h.app, 'GET', routes.ownerInvite(tokenOf(created)))).json()).toMatchObject({
        requiresLogin: true,
      });
      const anonymous = await accept(created, null, {});
      expect([anonymous.statusCode, errorCode(anonymous)]).toEqual([409, 'login_required']);
      const accepted = await accept(created, dev, {});
      expect(accepted.json<Me>()).toMatchObject({ userId: 'usr_dev1', ownerAccount: true });
    });

    it('refuses an existing account that has no password', async () => {
      const { repos, auth } = h.app.projectman;
      repos.users.insert({
        id: 'usr_nopw',
        name: 'No Password',
        email: 'nopw@example.test',
        passwordHash: null,
        createdAt: now.toISOString(),
      });
      const cookie = `${SESSION_COOKIE}=${encodeURIComponent(h.app.signCookie(auth.createSession('usr_nopw')))}`;
      const res = await accept(await invite('nopw@example.test'), cookie, {});
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'invite_password_account_required']);
    });

    it('needs a name and a password for a new address', async () => {
      const created = await invite();
      const res = await accept(created, null, {});
      expect([res.statusCode, errorCode(res)]).toEqual([400, 'invalid_request']);
    });
  });

  describe('the owner account’s engine and project', () => {
    let guestCookie: string;
    let guestEngine: CreateEngineResponse;

    beforeEach(async () => {
      guestCookie = await acceptAsGuest();
      guestEngine = await createEngine(guestCookie);
    });

    it('creates an engine of its own, and lists and revokes only that one', async () => {
      expect(guestEngine.engine.id).toBeDefined();
      const hostEngine = registry.create('Host Mac', hostId).engine;
      const listed = (await inject(h.app, 'GET', routes.engines(), guestCookie)).json() as EngineView[];
      expect(listed.map((engine) => engine.id)).toEqual([guestEngine.engine.id]);
      const foreign = await inject(h.app, 'POST', routes.revokeEngine(hostEngine.id), guestCookie);
      expect([foreign.statusCode, errorCode(foreign)]).toEqual([403, 'engine_not_owned']);
      const own = await inject(h.app, 'POST', routes.revokeEngine(guestEngine.engine.id), guestCookie);
      expect(own.json()).toMatchObject({ id: guestEngine.engine.id, revokedAt: expect.any(String) });
    });

    it('leaves the machine default to the host owner', async () => {
      const res = await inject(h.app, 'POST', routes.defaultEngine(guestEngine.engine.id), guestCookie);
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'owner_only']);
    });

    it('creates a project on its connected engine and binds it as the default', async () => {
      await connectEngine(guestEngine.key);
      const res = await createGuestProject(guestCookie, { engineId: guestEngine.engine.id });
      expect(res.statusCode, res.body).toBe(201);
      expect((res.json() as ProjectSummary).key).toBe('GU');
      expect(registry.projectBindings('GU')).toEqual([
        { engineId: guestEngine.engine.id, isDefault: true, revoked: false },
      ]);
      expect(registry.projectEngine('GU')).toBe(guestEngine.engine.id);
      // The host has no seat in it.
      expect(await h.app.projectman.domain.accessFor('GU', OWNER_LOGIN.email)).toBeNull();
    });

    it('checks the folder on the chosen engine', async () => {
      await connectEngine(guestEngine.key, () => false);
      const res = await createGuestProject(guestCookie, { engineId: guestEngine.engine.id });
      expect([res.statusCode, errorCode(res)]).toEqual([400, 'workspace_not_found']);
      expect(h.app.projectman.domain.projects.has('GU')).toBe(false);
    });

    it('creates a project whose folder the engine does not hold yet (PM-1077)', async () => {
      links.push(
        await connectRawEngine(
          h.app,
          guestEngine.key,
          rawHello(),
          () => new RawEngineRefusal('path_outside_roots'),
        ),
      );
      const res = await createGuestProject(guestCookie, { engineId: guestEngine.engine.id });
      expect(res.statusCode, res.body).toBe(201);
    });

    describe('its engine management (PM-1077)', () => {
      const connectProviders = async (asked: unknown[] = []) =>
        links.push(
          await connectRawEngine(h.app, guestEngine.key, rawHello(), (method, params) => {
            if (method !== 'provider.status') return null;
            asked.push(params);
            const { provider } = params as { provider: string };
            return { provider, loggedIn: true, method: 'subscription', checkedAt: now.toISOString() };
          }),
        );
      const providersOf = async (who: string, id: string, query = '') => {
        const res = await inject(h.app, 'GET', `${routes.engineProviders(id)}${query}`, who);
        return {
          res,
          names:
            res.statusCode === 200
              ? (res.json() as EngineProvidersView).providers.map((p) => p.provider)
              : [],
        };
      };

      it('reads the provider logins from the engine, asking again on refresh', async () => {
        const asked: { refresh?: boolean }[] = [];
        await connectProviders(asked);
        const { res, names } = await providersOf(guestCookie, guestEngine.engine.id);
        expect(res.statusCode, res.body).toBe(200);
        expect(names).toEqual(['claude', 'codex', 'gemini']);
        expect((res.json() as EngineProvidersView).providers.every((p) => p.loggedIn === true)).toBe(true);
        expect(asked).toHaveLength(3);
        await providersOf(guestCookie, guestEngine.engine.id, '?refresh=1');
        expect(asked.filter((params) => params.refresh === true)).toHaveLength(3);
      });

      it('answers `loggedIn: null` for an engine that is not connected', async () => {
        const { res } = await providersOf(guestCookie, guestEngine.engine.id);
        expect((res.json() as EngineProvidersView).providers.map((p) => p.loggedIn)).toEqual([
          null,
          null,
          null,
        ]);
      });

      it('lists the NanoGPT login to the host owner only', async () => {
        await connectProviders();
        expect((await providersOf(host, guestEngine.engine.id)).names).toContain('nanogpt');
        expect((await providersOf(guestCookie, guestEngine.engine.id)).names).not.toContain('nanogpt');
      });

      it('does not show another owner’s engine, and refuses a revoked one', async () => {
        const hostEngine = registry.create('Host Mac', hostId).engine;
        const foreign = await providersOf(guestCookie, hostEngine.id);
        expect([foreign.res.statusCode, errorCode(foreign.res)]).toEqual([404, 'engine_not_found']);
        const rename = await inject(h.app, 'PATCH', routes.engine(hostEngine.id), guestCookie, {
          name: 'Mine',
        });
        expect([rename.statusCode, errorCode(rename)]).toEqual([404, 'engine_not_found']);
        registry.revoke(guestEngine.engine.id, hostId);
        const revoked = await providersOf(guestCookie, guestEngine.engine.id);
        expect([revoked.res.statusCode, errorCode(revoked.res)]).toEqual([409, 'engine_revoked']);
        const late = await inject(h.app, 'PATCH', routes.engine(guestEngine.engine.id), guestCookie, {
          name: 'Late',
        });
        expect([late.statusCode, errorCode(late)]).toEqual([409, 'engine_revoked']);
      });

      it('renames the engine, for its owner and for the host owner', async () => {
        const own = await inject(h.app, 'PATCH', routes.engine(guestEngine.engine.id), guestCookie, {
          name: '  Studio Mac ',
        });
        expect(own.json()).toMatchObject({ id: guestEngine.engine.id, name: 'Studio Mac', ownedByMe: true });
        const byHost = await inject(h.app, 'PATCH', routes.engine(guestEngine.engine.id), host, {
          name: 'Renamed',
        });
        expect(byHost.json()).toMatchObject({ name: 'Renamed', ownedByMe: false });
        const empty = await inject(h.app, 'PATCH', routes.engine(guestEngine.engine.id), guestCookie, {
          name: ' ',
        });
        expect(empty.statusCode).toBe(400);
      });

      it('tells each caller which engine is theirs', async () => {
        const hostEngine = registry.create('Host Mac', hostId).engine;
        const listed = async (who: string) =>
          ((await inject(h.app, 'GET', routes.engines(), who)).json() as EngineView[]).map((engine) => [
            engine.id,
            engine.ownedByMe,
          ]);
        expect(await listed(guestCookie)).toEqual([[guestEngine.engine.id, true]]);
        expect(await listed(host)).toEqual([
          [guestEngine.engine.id, false],
          [hostEngine.id, true],
        ]);
        expect(guestEngine.engine.ownedByMe).toBe(true);
      });
    });

    it.each([
      ['no engine is chosen', null, 400, 'invalid_request'],
      ['the engine is unknown', 'eng_000000000000', 404, 'engine_not_found'],
      ['the engine is not connected', 'self', 409, 'engine_offline'],
    ])('refuses a project when %s', async (_name, chosen, status, code) => {
      const engineId = chosen === 'self' ? guestEngine.engine.id : chosen;
      const res = await createGuestProject(guestCookie, engineId ? { engineId } : {});
      expect([res.statusCode, errorCode(res)]).toEqual([status, code]);
    });

    it('refuses an engine of someone else and a revoked one', async () => {
      const hostEngine = registry.create('Host Mac', hostId).engine;
      const foreign = await createGuestProject(guestCookie, { engineId: hostEngine.id });
      expect([foreign.statusCode, errorCode(foreign)]).toEqual([403, 'engine_not_owned']);
      registry.revoke(guestEngine.engine.id, hostId);
      const revoked = await createGuestProject(guestCookie, { engineId: guestEngine.engine.id });
      expect([revoked.statusCode, errorCode(revoked)]).toEqual([409, 'engine_revoked']);
    });

    it('is refused to a member who is no owner account', async () => {
      const member = await addHumanAndLogin(h.app, { handle: 'pat', access: 'owner' });
      const res = await createGuestProject(member, { engineId: guestEngine.engine.id });
      expect([res.statusCode, errorCode(res)]).toEqual([403, 'owner_only']);
      const engine = await inject(h.app, 'POST', routes.engines(), member, { name: 'Pat Mac' });
      expect([engine.statusCode, errorCode(engine)]).toEqual([403, 'owner_only']);
    });

    it('never falls back to the host’s machine, whoever its configuration names an owner', async () => {
      await connectEngine(guestEngine.key);
      expect((await createGuestProject(guestCookie, { engineId: guestEngine.engine.id })).statusCode).toBe(
        201,
      );
      const hostEngine = registry.create('Host Mac', hostId).engine;
      registry.setDefault(hostEngine.id);
      // The project owner writes the host into the configuration as an owner and drops the binding.
      const draft = structuredClone(await h.app.projectman.domain.projects.config('GU'));
      draft.team.members.push({
        kind: 'human',
        handle: 'host',
        displayName: 'Host',
        email: OWNER_LOGIN.email,
        access: 'owner',
        roles: [],
      });
      const saved = await inject(h.app, 'PUT', routes.config('GU'), guestCookie, draft);
      expect(saved.statusCode, saved.body).toBe(200);
      const unbound = await inject(
        h.app,
        'DELETE',
        routes.projectEngine('GU', guestEngine.engine.id),
        guestCookie,
      );
      expect(unbound.statusCode).toBe(204);
      expect(registry.projectEngine('GU')).toBeNull();
      // The host's own consent is a binding of their engine, made with their own login.
      const consent = await inject(h.app, 'PUT', routes.projectEngine('GU', hostEngine.id), host, {});
      expect(consent.statusCode, consent.body).toBe(200);
      expect(registry.projectEngine('GU')).toBe(hostEngine.id);
    });

    it('keeps the host owner’s project creation without an engine as it was', async () => {
      const key = 'HO';
      const res = await withoutOnboarding(h.app.projectman.domain, () =>
        inject(h.app, 'POST', routes.projects(), host, {
          key,
          name: 'host project',
          workspacePath: h.workspace,
          templateId: 'test',
          repos: [{ name: 'web', path: '.', github: 'acme/web' }],
        }),
      );
      // No engine is connected in this cloud, so the folder cannot be checked: a refusal, not a binding.
      expect([res.statusCode, errorCode(res)]).toEqual([409, 'engine_offline']);
      expect(registry.projectBindings(key)).toEqual([]);
    });
  });

  describe('the revocation', () => {
    let guestCookie: string;
    let guestEngine: CreateEngineResponse;
    let guestId: string;

    beforeEach(async () => {
      guestCookie = await acceptAsGuest();
      guestId = h.app.projectman.repos.users.findByEmail(guest.email)!.id;
      guestEngine = await createEngine(guestCookie);
      await connectEngine(guestEngine.key);
      expect((await createGuestProject(guestCookie, { engineId: guestEngine.engine.id })).statusCode).toBe(
        201,
      );
      h.app.projectman.repos.integratorKeys.create({
        id: 'ikey_guest',
        userId: guestId,
        prefix: 'pmk_guest',
        hash: 'hash-of-the-guest-key',
        at: new Date().toISOString(),
        expiresAt: null,
        mode: 'read',
      });
    });

    const revoke = (who = host) => inject(h.app, 'POST', routes.revokeOwnerAccount(guestId), who);
    const guestRow = async () =>
      (
        (await inject(h.app, 'GET', routes.ownerAccounts(), host)).json() as { accounts: OwnerAccountView[] }
      ).accounts.find((account) => account.userId === guestId)!;

    it('counts the projects the revocation would pause, and those paused now, but not one shared with the host', async () => {
      expect(
        (
          await createGuestProject(guestCookie, {
            key: 'G2',
            workspacePath: '/fictional/guest/two',
            engineId: guestEngine.engine.id,
          })
        ).statusCode,
      ).toBe(201);
      // The guest is named an owner of the host's project, where the host keeps a seat: it is not theirs to lose.
      const draft = structuredClone(await h.app.projectman.domain.projects.config('AR'));
      draft.team.members.push({
        kind: 'human',
        handle: 'guest',
        displayName: 'Guest',
        email: guest.email,
        access: 'owner',
        roles: [],
      });
      expect((await inject(h.app, 'PUT', routes.config('AR'), host, draft)).statusCode).toBe(200);
      await h.app.projectman.domain.pauses.pause(
        { scope: 'project', projectKey: 'G2' },
        { userId: hostId, source: 'app' },
      );
      expect(await guestRow()).toMatchObject({ projectCount: 2, pausedProjectCount: 1 });
    });

    it('counts the engines that are not revoked, and those connected now', async () => {
      await createEngine(guestCookie, 'Idle Mac');
      const revoked = await createEngine(guestCookie, 'Old Mac');
      registry.revoke(revoked.engine.id, hostId);
      expect((await guestRow()).engines).toEqual({ total: 2, online: 1 });
    });

    it('reports every project paused and no engine left in the revocation response', async () => {
      const res = await revoke();
      const body = res.json<OwnerAccountView>();
      expect(body.projectCount).toBeGreaterThan(0);
      expect(body.pausedProjectCount).toBe(body.projectCount);
      expect(body.engines).toEqual({ total: 0, online: 0 });
    });

    it('pauses their projects, revokes their engines and keys, and takes the right to create away', async () => {
      const res = await revoke();
      expect(res.json()).toMatchObject({ userId: guestId, revokedAt: expect.any(String) });
      expect(h.app.projectman.domain.pauses.isPaused('GU')).toBe(true);
      expect(h.app.projectman.domain.pauses.isPaused('AR')).toBe(false);
      expect(registry.ids()).not.toContain(guestEngine.engine.id);
      expect(
        h.app.projectman.repos.integratorKeys.list(guestId, new Date().toISOString()).map((key) => key.state),
      ).toEqual(['revoked']);
      const create = await createGuestProject(guestCookie, { key: 'G2', engineId: guestEngine.engine.id });
      expect([create.statusCode, errorCode(create)]).toEqual([403, 'owner_only']);
      // The login and the data stay.
      expect((await inject(h.app, 'GET', routes.projects(), guestCookie)).json()).toEqual([
        expect.objectContaining({ key: 'GU' }),
      ]);
    });

    it('pauses a project they created even when the host is named a member of it', async () => {
      const draft = structuredClone(await h.app.projectman.domain.projects.config('GU'));
      draft.team.members.push({
        kind: 'human',
        handle: 'host',
        displayName: 'Host',
        email: OWNER_LOGIN.email,
        access: 'owner',
        roles: [],
      });
      expect((await inject(h.app, 'PUT', routes.config('GU'), guestCookie, draft)).statusCode).toBe(200);
      await revoke();
      expect(h.app.projectman.domain.pauses.isPaused('GU')).toBe(true);
    });

    it('can be repeated without harm, and refuses a non-host caller and an unknown account', async () => {
      await revoke();
      const again = await revoke();
      expect(again.statusCode).toBe(200);
      const byGuest = await revoke(guestCookie);
      expect([byGuest.statusCode, errorCode(byGuest)]).toEqual([403, 'owner_only']);
      const unknown = await inject(h.app, 'POST', routes.revokeOwnerAccount('usr_nobody'), host);
      expect(unknown.statusCode).toBe(404);
    });

    it('is undone by a new invitation that the account accepts with its own login', async () => {
      await revoke();
      const created = await invite();
      const accepted = await accept(created, guestCookie, {});
      expect(accepted.json<Me>()).toMatchObject({ userId: guestId, ownerAccount: true });
    });
  });
});
