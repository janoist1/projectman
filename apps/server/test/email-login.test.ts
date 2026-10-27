import { mkdirSync } from 'node:fs';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CreatedInvitation, Me, PublicInviteView, SetupStatus } from '@projectman/shared';
import { routes } from '@projectman/shared';
import { createEmailLoginService, EMAIL_LOGIN_LIMITS } from '../src/services/email-login';
import { deriveEmailLoginKey } from '../src/auth';
import type { EmailCodeMailInput, EmailCodeMailer } from '../src/contracts';
import { EmailCodeDeliveryError } from '../src/contracts';
import {
  addHumanAndLogin,
  cookieOf,
  createAppHarness,
  createProject,
  inject,
  OWNER_LOGIN,
} from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';
import { humanActor } from '../src/kernel';

const IP_HEADER = 'cf-connecting-ip';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

class FakeMailer implements EmailCodeMailer {
  sent: EmailCodeMailInput[] = [];
  fail: Error | null = null;
  async send(input: EmailCodeMailInput): Promise<void> {
    if (this.fail) throw this.fail;
    this.sent.push(input);
  }
  /** The code of the latest letter to this address. */
  codeFor(to: string): string {
    const letter = [...this.sent].reverse().find((s) => s.to === to);
    if (!letter) throw new Error(`no letter to ${to}`);
    return letter.code;
  }
}

describe('e-mail login of invited clients (PM-670)', () => {
  let h: AppHarness;
  let owner: string;
  let now: Date;
  let mailer: FakeMailer;
  let logs: string[];
  let ipCounter: number;

  beforeEach(async () => {
    now = new Date('2026-10-14T10:00:00.000Z');
    mailer = new FakeMailer();
    logs = [];
    ipCounter = 0;
    h = await createAppHarness({
      now: () => now,
      app: {
        emailCodeMailer: mailer,
        clientIpHeader: IP_HEADER,
        logger: {
          level: 'trace',
          stream: new Writable({
            write(chunk: Buffer, _enc, done) {
              logs.push(chunk.toString());
              done();
            },
          }),
        },
      },
    });
    owner = cookieOf(await h.app.inject({ method: 'POST', url: routes.setup(), payload: OWNER_LOGIN }));
    await createProject(h, owner);
  });
  afterEach(async () => {
    await h.close();
  });

  const emailLogin = () => h.app.projectman.domain.emailLogin!;
  const freshIp = () => `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;

  async function post(url: string, payload: unknown, ip = freshIp(), cookie?: string) {
    return h.app.inject({
      method: 'POST',
      url,
      headers: { [IP_HEADER]: ip, ...(cookie ? { cookie } : {}) },
      payload: payload as object,
    });
  }
  /** A code request; the background step has run when this returns. */
  async function requestCode(body: Record<string, string>, ip = freshIp()) {
    const res = await post(routes.emailLoginRequest(), body, ip);
    await emailLogin().settled();
    return res;
  }
  const verify = (body: Record<string, string>, ip = freshIp(), cookie?: string) =>
    post(routes.emailLoginVerify(), body, ip, cookie);

  async function inviteClient(
    email: string,
    input: { displayName?: string; projectKey?: string } = {},
  ): Promise<CreatedInvitation> {
    const res = await inject(h.app, 'POST', `/api/projects/${input.projectKey ?? 'AR'}/invites`, owner, {
      email,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      access: 'client',
      roles: [],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json();
  }
  async function inviteOf(email: string, access: 'developer' | 'viewer', projectKey = 'AR') {
    const res = await inject(h.app, 'POST', `/api/projects/${projectKey}/invites`, owner, {
      email,
      displayName: 'Someone',
      access,
      roles: [],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as CreatedInvitation;
  }
  const tokenOf = (invite: CreatedInvitation) => invite.path.replace('/invite/', '');
  async function secondProject(): Promise<void> {
    mkdirSync(`${h.home}/workspace-br`, { recursive: true });
    const res = await inject(h.app, 'POST', '/api/projects', owner, {
      key: 'BR',
      name: 'bravo',
      workspacePath: `${h.home}/workspace-br`,
      templateId: 'test',
      repos: [{ name: 'web', path: '.', github: 'acme/web' }],
    });
    expect(res.statusCode, res.body).toBe(201);
  }
  const users = () => h.app.projectman.repos.users;
  const counts = () => h.app.projectman.repos.emailLogin;
  const me = async (cookie: string) => (await inject(h.app, 'GET', routes.me(), cookie)).json() as Me;

  /** Redeems a fresh code for an address: request, read the letter, verify. */
  async function login(email: string, extra: Record<string, string> = {}, ip = freshIp()) {
    await requestCode({ email }, ip);
    return verify({ email, code: mailer.codeFor(email), ...extra }, ip);
  }

  describe('availability', () => {
    it('answers 503 before the first setup and without a mailer, and hides the flag', async () => {
      const fresh = await createAppHarness({ app: { emailCodeMailer: mailer } });
      try {
        const status = await inject(fresh.app, 'GET', routes.setupStatus());
        expect(status.json()).toEqual({ needsSetup: true });
        for (const url of [routes.emailLoginRequest(), routes.emailLoginVerify()]) {
          const res = await inject(fresh.app, 'POST', url, null, { not: 'even a valid body' });
          expect([res.statusCode, res.json().error.code]).toEqual([503, 'email_login_unavailable']);
        }
      } finally {
        await fresh.close();
      }
      const bare = await createAppHarness();
      try {
        await inject(bare.app, 'POST', routes.setup(), null, OWNER_LOGIN);
        const status = (await inject(bare.app, 'GET', routes.setupStatus())).json() as SetupStatus;
        expect(status).not.toHaveProperty('emailLoginEnabled');
        const res = await inject(bare.app, 'POST', routes.emailLoginRequest(), null, { email: 'a@b.test' });
        expect([res.statusCode, res.json().error.code]).toEqual([503, 'email_login_unavailable']);
      } finally {
        await bare.close();
      }
    });

    it('reports the flag once an owner exists', async () => {
      const status = (await inject(h.app, 'GET', routes.setupStatus())).json() as SetupStatus;
      expect(status.emailLoginEnabled).toBe(true);
    });
  });

  describe('the code', () => {
    beforeEach(async () => {
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
    });

    it('logs a new client in with the right code, once', async () => {
      const requested = await requestCode({ email: 'kata@acme.test' });
      expect([requested.statusCode, requested.json()]).toEqual([
        202,
        { expiresInSeconds: 600, resendAfterSeconds: 60 },
      ]);
      expect(mailer.sent).toHaveLength(1);
      expect(mailer.sent[0]!.expiresAt).toBe(new Date(now.getTime() + 10 * MINUTE).toISOString());
      const code = mailer.codeFor('kata@acme.test');
      expect(code).toMatch(/^\d{6}$/);

      const ok = await verify({ email: 'kata@acme.test', code });
      expect(ok.statusCode, ok.body).toBe(200);
      const session = await me(cookieOf(ok));
      expect(session).toMatchObject({ name: 'Kata', email: 'kata@acme.test' });
      expect(Object.keys(session.handles)).toEqual(['AR']);
      expect(users().findByEmail('kata@acme.test')!.passwordHash).toBeNull();

      const again = await verify({ email: 'kata@acme.test', code });
      expect([again.statusCode, again.json().error.code]).toEqual([400, 'email_code_invalid']);
    });

    it('is case-insensitive about the address', async () => {
      await requestCode({ email: 'KATA@Acme.Test' });
      expect(mailer.sent).toHaveLength(1);
      const ok = await verify({ email: 'Kata@ACME.test', code: mailer.codeFor('kata@acme.test') });
      expect(ok.statusCode).toBe(200);
    });

    it('rejects a wrong code, and the fifth wrong try voids the code', async () => {
      await requestCode({ email: 'kata@acme.test' });
      const code = mailer.codeFor('kata@acme.test');
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i += 1) {
        const res = await verify({ email: 'kata@acme.test', code: wrong });
        expect([res.statusCode, res.json().error.code]).toEqual([400, 'email_code_invalid']);
      }
      const right = await verify({ email: 'kata@acme.test', code });
      expect([right.statusCode, right.json().error.code]).toEqual([400, 'email_code_invalid']);
      expect(users().findByEmail('kata@acme.test')).toBeNull();
    });

    it('rejects an expired code at the exact expiry', async () => {
      await requestCode({ email: 'kata@acme.test' });
      const code = mailer.codeFor('kata@acme.test');
      now = new Date(now.getTime() + 10 * MINUTE);
      const res = await verify({ email: 'kata@acme.test', code });
      expect([res.statusCode, res.json().error.code]).toEqual([400, 'email_code_invalid']);
    });

    it.each(['missing', 'used', 'expired', 'exhausted', 'unknown-token'])(
      'answers byte for byte the same for a %s code and a wrong live code',
      async (state) => {
        await requestCode({ email: 'kata@acme.test' });
        const code = mailer.codeFor('kata@acme.test');
        const wrong = code === '000000' ? '111111' : '000000';
        const reference = await verify({ email: 'kata@acme.test', code: wrong });
        let input: Record<string, string> = { email: 'kata@acme.test', code };
        if (state === 'missing') input = { email: 'unknown@acme.test', code };
        if (state === 'unknown-token') input = { inviteToken: 'unknown-token', code };
        if (state === 'used') {
          expect((await verify(input)).statusCode).toBe(200);
        }
        if (state === 'expired') now = new Date(now.getTime() + EMAIL_LOGIN_LIMITS.codeTtlMs);
        if (state === 'exhausted') {
          for (let i = 1; i < 5; i += 1) {
            expect((await verify({ email: 'kata@acme.test', code: wrong })).statusCode).toBe(400);
          }
        }
        const rejected = await verify(input);
        expect(rejected.statusCode).toBe(400);
        expect([rejected.statusCode, rejected.body]).toEqual([reference.statusCode, reference.body]);
      },
    );

    it('accepts a code just before it expires', async () => {
      await requestCode({ email: 'kata@acme.test' });
      const code = mailer.codeFor('kata@acme.test');
      now = new Date(now.getTime() + 10 * MINUTE - 1);
      expect((await verify({ email: 'kata@acme.test', code })).statusCode).toBe(200);
    });

    it('voids the earlier code when a new one is requested', async () => {
      await requestCode({ email: 'kata@acme.test' });
      const first = mailer.codeFor('kata@acme.test');
      now = new Date(now.getTime() + MINUTE + 1000);
      await requestCode({ email: 'kata@acme.test' });
      expect(mailer.sent).toHaveLength(2);
      const second = mailer.codeFor('kata@acme.test');
      if (first !== second) {
        const old = await verify({ email: 'kata@acme.test', code: first });
        expect(old.json().error.code).toBe('email_code_invalid');
      }
      expect((await verify({ email: 'kata@acme.test', code: second })).statusCode).toBe(200);
    });

    it('lets exactly one of many parallel redemptions through', async () => {
      await requestCode({ email: 'kata@acme.test' });
      const code = mailer.codeFor('kata@acme.test');
      const results = await Promise.all(
        Array.from({ length: 6 }, () => verify({ email: 'kata@acme.test', code })),
      );
      expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
      expect(results.filter((r) => r.statusCode === 400)).toHaveLength(5);
      expect(h.app.projectman.repos.users.list().filter((u) => u.email === 'kata@acme.test')).toHaveLength(1);
    });

    it('rejects a malformed code before it counts as a try', async () => {
      await requestCode({ email: 'kata@acme.test' });
      for (const code of ['12345', '1234567', 'abcdef', '']) {
        const res = await verify({ email: 'kata@acme.test', code });
        expect(res.statusCode).toBe(400);
        expect(res.json().error.code).toBe('invalid_request');
      }
      expect(
        (await verify({ email: 'kata@acme.test', code: mailer.codeFor('kata@acme.test') })).statusCode,
      ).toBe(200);
    });

    it('revokes the presented session and starts a new one', async () => {
      const oldCookie = await addHumanAndLogin(h.app, {
        handle: 'someone',
        access: 'client',
        email: 'someone@acme.test',
      });
      expect((await inject(h.app, 'GET', routes.me(), oldCookie)).statusCode).toBe(200);
      await requestCode({ email: 'kata@acme.test' });
      const ok = await verify(
        { email: 'kata@acme.test', code: mailer.codeFor('kata@acme.test') },
        freshIp(),
        oldCookie,
      );
      expect(ok.statusCode).toBe(200);
      expect((await inject(h.app, 'GET', routes.me(), oldCookie)).statusCode).toBe(401);
      expect((await me(cookieOf(ok))).email).toBe('kata@acme.test');
    });
  });

  describe('who is sent a code', () => {
    const lettersAfter = async (email: string) => {
      const before = mailer.sent.length;
      const res = await requestCode({ email });
      return { res, sent: mailer.sent.length - before };
    };

    it('answers every address byte for byte the same and mails only the eligible ones', async () => {
      await inviteClient('client@acme.test');
      await addHumanAndLogin(h.app, { handle: 'dev', access: 'developer', email: 'dev@acme.test' });
      await addHumanAndLogin(h.app, { handle: 'view', access: 'viewer', email: 'view@acme.test' });
      mailer.fail = null;
      const answers = new Map<string, { status: number; body: string; type: unknown }>();
      const sent = new Map<string, number>();
      for (const email of [
        'client@acme.test',
        'unknown@acme.test',
        'dev@acme.test',
        'view@acme.test',
        OWNER_LOGIN.email,
      ]) {
        const { res, sent: count } = await lettersAfter(email);
        answers.set(email, { status: res.statusCode, body: res.body, type: res.headers['content-type'] });
        sent.set(email, count);
      }
      const reference = answers.get('client@acme.test')!;
      for (const answer of answers.values()) expect(answer).toEqual(reference);
      expect(Object.fromEntries(sent)).toEqual({
        'client@acme.test': 1,
        'unknown@acme.test': 0,
        'dev@acme.test': 0,
        'view@acme.test': 0,
        [OWNER_LOGIN.email]: 0,
      });
      // The failing mailer looks the same as well.
      mailer.fail = new EmailCodeDeliveryError('rejected');
      now = new Date(now.getTime() + 2 * MINUTE);
      const failing = await requestCode({ email: 'client@acme.test' });
      expect({
        status: failing.statusCode,
        body: failing.body,
        type: failing.headers['content-type'],
      }).toEqual(reference);
    });

    it('sends nothing for a revoked or expired invitation', async () => {
      const revoked = await inviteClient('revoked@acme.test');
      await inject(h.app, 'DELETE', `/api/projects/AR/invites/${revoked.id}`, owner);
      expect((await lettersAfter('revoked@acme.test')).sent).toBe(0);
      await inviteClient('late@acme.test');
      now = new Date(now.getTime() + 8 * 24 * HOUR);
      expect((await lettersAfter('late@acme.test')).sent).toBe(0);
    });

    it('sends nothing to a client whose membership ended', async () => {
      await addHumanAndLogin(h.app, { handle: 'gone', access: 'client', email: 'gone@acme.test' });
      expect((await lettersAfter('gone@acme.test')).sent).toBe(1);
      await h.app.projectman.domain.projects.update(
        'AR',
        { actor: humanActor('owner'), author: OWNER_LOGIN },
        (draft) => {
          draft.team.members = draft.team.members.filter((m) => m.handle !== 'gone');
          return 'Remove the client';
        },
      );
      now = new Date(now.getTime() + 2 * MINUTE);
      expect((await lettersAfter('gone@acme.test')).sent).toBe(0);
    });

    it('sends nothing to an address that is a client here and internal elsewhere', async () => {
      await secondProject();
      await inviteClient('mixed@acme.test');
      expect((await lettersAfter('mixed@acme.test')).sent).toBe(1);
      await inviteOf('mixed@acme.test', 'developer', 'BR');
      now = new Date(now.getTime() + 2 * MINUTE);
      expect((await lettersAfter('mixed@acme.test')).sent).toBe(0);
    });

    it('does not let a code redeem into more access than the client invitations give', async () => {
      await secondProject();
      await inviteClient('mixed@acme.test', { displayName: 'Mixed' });
      await requestCode({ email: 'mixed@acme.test' });
      const code = mailer.codeFor('mixed@acme.test');
      // An internal invitation opened after the code was sent makes the redemption refuse.
      await inviteOf('mixed@acme.test', 'developer', 'BR');
      const res = await verify({ email: 'mixed@acme.test', code });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'email_login_no_access']);
      expect(users().findByEmail('mixed@acme.test')).toBeNull();
      expect(
        (await h.app.projectman.domain.projects.config('BR')).team.members.map((m) => m.handle),
      ).not.toContain('mixed');
    });

    it('refuses an existing client account that was given internal access after the code was sent', async () => {
      await addHumanAndLogin(h.app, { handle: 'cli', access: 'client', email: 'cli@acme.test' });
      await requestCode({ email: 'cli@acme.test' });
      const code = mailer.codeFor('cli@acme.test');
      await h.app.projectman.domain.projects.update(
        'AR',
        { actor: humanActor('owner'), author: OWNER_LOGIN },
        (draft) => {
          const member = draft.team.members.find((m) => m.handle === 'cli');
          if (member?.kind === 'human') member.access = 'developer';
          return 'Promote the client';
        },
      );
      const res = await verify({ email: 'cli@acme.test', code });
      expect([res.statusCode, res.json().error.code]).toEqual([403, 'email_login_no_access']);
    });
  });

  describe('accounts', () => {
    it('accepts all open client invitations of the address at once', async () => {
      await secondProject();
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
      await inviteClient('kata@acme.test', { displayName: 'Kata', projectKey: 'BR' });
      const ok = await login('kata@acme.test');
      expect(ok.statusCode, ok.body).toBe(200);
      expect(Object.keys((await me(cookieOf(ok))).handles).sort()).toEqual(['AR', 'BR']);
      const pending = await inject(h.app, 'GET', '/api/projects/AR/invites', owner);
      expect(pending.json().invitations.filter((i: { acceptedAt: string | null }) => !i.acceptedAt)).toEqual(
        [],
      );
    });

    it('asks for a name when the invitation has none, without using up the code', async () => {
      await inviteClient('anon@acme.test');
      await requestCode({ email: 'anon@acme.test' });
      const code = mailer.codeFor('anon@acme.test');
      const missing = await verify({ email: 'anon@acme.test', code });
      expect([missing.statusCode, missing.json().error.code]).toEqual([400, 'email_login_name_required']);
      expect(users().findByEmail('anon@acme.test')).toBeNull();
      const named = await verify({ email: 'anon@acme.test', code, name: 'Anna' });
      expect(named.statusCode, named.body).toBe(200);
      expect((await me(cookieOf(named))).name).toBe('Anna');
    });

    it('names a new account after the request, and ignores a name for an existing account', async () => {
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
      const ok = await login('kata@acme.test', { name: 'Kata K.' });
      expect((await me(cookieOf(ok))).name).toBe('Kata K.');
      now = new Date(now.getTime() + 2 * MINUTE);
      const again = await login('kata@acme.test', { name: 'Third' });
      expect((await me(cookieOf(again))).name).toBe('Kata K.');
    });

    it('lets an existing client with a password use a code and keeps the password', async () => {
      await addHumanAndLogin(h.app, { handle: 'cli', access: 'client', email: 'cli@acme.test' });
      const before = users().findByEmail('cli@acme.test')!.passwordHash;
      expect(before).toEqual(expect.any(String));
      const ok = await login('cli@acme.test');
      expect(ok.statusCode, ok.body).toBe(200);
      expect(users().findByEmail('cli@acme.test')!.passwordHash).toBe(before);
      const password = await post(routes.login(), { email: 'cli@acme.test', password: OWNER_LOGIN.password });
      expect(password.statusCode).toBe(200);
    });

    it('works from the invitation link, and shows only a masked address hint on a client invitation', async () => {
      const client = await inviteClient('kata@acme.test', { displayName: 'Kata' });
      const developer = await inviteOf('dev@acme.test', 'developer');
      const view = await inject(h.app, 'GET', `/api/invites/${tokenOf(client)}`);
      const hint = (view.json() as PublicInviteView).emailHint;
      expect(hint).toBe('k***@a***.test');
      expect(view.body).not.toContain('kata@acme.test');
      const other = await inject(h.app, 'GET', `/api/invites/${tokenOf(developer)}`);
      expect(other.json()).not.toHaveProperty('emailHint');

      const requested = await post(routes.emailLoginRequest(), { inviteToken: tokenOf(client) });
      await emailLogin().settled();
      expect(requested.statusCode).toBe(202);
      expect(mailer.sent.map((s) => s.to)).toEqual(['kata@acme.test']);
      const ok = await verify({ inviteToken: tokenOf(client), code: mailer.codeFor('kata@acme.test') });
      expect(ok.statusCode, ok.body).toBe(200);

      // A non-client or unknown token looks the same and sends nothing.
      const sentBefore = mailer.sent.length;
      for (const token of [tokenOf(developer), 'unknown-token']) {
        const res = await post(routes.emailLoginRequest(), { inviteToken: token });
        expect(res.statusCode).toBe(202);
        const bad = await verify({ inviteToken: token, code: '123456' });
        expect([bad.statusCode, bad.json().error.code]).toEqual([400, 'email_code_invalid']);
      }
      await emailLogin().settled();
      expect(mailer.sent).toHaveLength(sentBefore);
    });

    it('keeps a passwordless account away from the password login, integrator keys and non-client links', async () => {
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
      const ok = await login('kata@acme.test');
      const cookie = cookieOf(ok);
      for (const password of ['anything at all', 'correct horse battery', 'x'.repeat(12)]) {
        const res = await post(routes.login(), { email: 'kata@acme.test', password });
        expect([res.statusCode, res.json().error.code]).toEqual([401, 'invalid_credentials']);
      }
      // No integrator key for it, even if it were the host owner.
      const key = await inject(h.app, 'GET', routes.integratorKeys(), cookie);
      expect(key.statusCode).toBe(403);
      const userId = users().findByEmail('kata@acme.test')!.id;
      expect(h.app.projectman.auth.hasPassword(userId)).toBe(false);
      expect(h.app.projectman.auth.resolveIntegratorCredential('pmi_not-a-key', 'rest')).toBeNull();

      // A developer invitation for the same address cannot be taken with a password it does not have.
      await secondProject();
      const link = await inviteOf('kata@acme.test', 'developer', 'BR');
      const accepted = await post(
        `/api/invites/${tokenOf(link)}/accept`,
        { password: 'correct horse battery' },
        freshIp(),
        cookie,
      );
      expect([accepted.statusCode, accepted.json().error.code]).toEqual([
        expect.any(Number),
        'invite_password_account_required',
      ]);
      expect(users().findByEmail('kata@acme.test')!.passwordHash).toBeNull();
    });
  });

  describe('limits', () => {
    beforeEach(async () => {
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
    });

    it('lets a new code come after a minute, five times an hour', async () => {
      await requestCode({ email: 'kata@acme.test' });
      await requestCode({ email: 'kata@acme.test' });
      expect(mailer.sent).toHaveLength(1);
      for (let i = 0; i < 4; i += 1) {
        now = new Date(now.getTime() + MINUTE + 1000);
        await requestCode({ email: 'kata@acme.test' });
      }
      expect(mailer.sent).toHaveLength(5);
      now = new Date(now.getTime() + MINUTE + 1000);
      await requestCode({ email: 'kata@acme.test' });
      expect(mailer.sent).toHaveLength(5);
    });

    it('holds an address to ten letters a day', async () => {
      for (let i = 0; i < 12; i += 1) {
        await requestCode({ email: 'kata@acme.test' });
        now = new Date(now.getTime() + 13 * MINUTE);
      }
      expect(mailer.sent).toHaveLength(10);
      now = new Date(now.getTime() + 24 * HOUR);
      await requestCode({ email: 'kata@acme.test' });
      expect(mailer.sent).toHaveLength(11);
    });

    it('limits requests per IP address with a 429 and Retry-After, never telling about an address', async () => {
      const ip = '203.0.113.7';
      for (let i = 0; i < EMAIL_LOGIN_LIMITS.requestsPerIpHour; i += 1) {
        expect((await post(routes.emailLoginRequest(), { email: `n${i}@acme.test` }, ip)).statusCode).toBe(
          202,
        );
      }
      const limited = await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, ip);
      expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'email_login_rate_limited']);
      expect(limited.json().error.details).toEqual({ retryAfterSeconds: 3600 });
      expect(limited.headers['retry-after']).toBe('3600');
      // Another IP is not affected; the window slides.
      expect(
        (await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, '203.0.113.8')).statusCode,
      ).toBe(202);
      now = new Date(now.getTime() + HOUR);
      expect((await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, ip)).statusCode).toBe(202);
    });

    it('limits redemptions per IP address and does not count the 30 per hour of another IP', async () => {
      const ip = '203.0.113.9';
      for (let i = 0; i < EMAIL_LOGIN_LIMITS.verifiesPerIpHour; i += 1) {
        const res = await verify({ email: 'kata@acme.test', code: '123456' }, ip);
        expect(res.statusCode).toBe(400);
      }
      const limited = await verify({ email: 'kata@acme.test', code: '123456' }, ip);
      expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'email_login_rate_limited']);
      expect(limited.headers['retry-after']).toEqual(expect.any(String));
      expect((await verify({ email: 'kata@acme.test', code: '123456' }, '203.0.113.10')).statusCode).toBe(
        400,
      );
    });

    it('shares the request limit across different addresses in an IPv6 /64', async () => {
      for (let i = 1; i <= EMAIL_LOGIN_LIMITS.requestsPerIpHour; i += 1) {
        const res = await post(
          routes.emailLoginRequest(),
          { email: `n${i}@acme.test` },
          `2001:db8:1234:5678::${i.toString(16)}`,
        );
        expect(res.statusCode).toBe(202);
      }
      const limited = await post(
        routes.emailLoginRequest(),
        { email: 'kata@acme.test' },
        '2001:0DB8:1234:5678:FFFF:FFFF:FFFF:FFFF',
      );
      expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'email_login_rate_limited']);
      expect(limited.headers['retry-after']).toBe('3600');
      expect(
        (await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, '2001:db8:1234:5679::1'))
          .statusCode,
      ).toBe(202);
      now = new Date(now.getTime() + HOUR);
      expect(
        (await post(routes.emailLoginRequest(), { email: 'kata@acme.test' }, '2001:db8:1234:5678::1'))
          .statusCode,
      ).toBe(202);
    });

    it('shares the redemption limit across different addresses in an IPv6 /64', async () => {
      for (let i = 1; i <= EMAIL_LOGIN_LIMITS.verifiesPerIpHour; i += 1) {
        const res = await verify(
          { email: 'kata@acme.test', code: '123456' },
          `2001:db8:1234:5678::${i.toString(16)}`,
        );
        expect(res.statusCode).toBe(400);
      }
      const limited = await verify(
        { email: 'kata@acme.test', code: '123456' },
        '2001:0DB8:1234:5678:FFFF:FFFF:FFFF:FFFF',
      );
      expect([limited.statusCode, limited.json().error.code]).toEqual([429, 'email_login_rate_limited']);
      expect(limited.headers['retry-after']).toBe('3600');
      expect(
        (await verify({ email: 'kata@acme.test', code: '123456' }, '2001:db8:1234:5679::1')).statusCode,
      ).toBe(400);
      now = new Date(now.getTime() + HOUR);
      expect(
        (await verify({ email: 'kata@acme.test', code: '123456' }, '2001:db8:1234:5678::1')).statusCode,
      ).toBe(400);
    });

    it('keeps the counts across a restart, because they live in the database', async () => {
      const directory = {
        standing: async () => ({
          eligible: true as const,
          userId: null,
          clientProjects: 0,
          openClientInvites: 1,
          inviteDisplayName: 'Kata',
        }),
        inviteEmail: () => null,
        acceptOpenClientInvites: async () => ({ userId: null, accepted: 0 }),
      };
      const build = () =>
        createEmailLoginService({
          repo: counts(),
          directory,
          mailer,
          key: deriveEmailLoginKey('restart-test-secret-restart-test-secret'),
          now: () => now,
          logger: { info: () => undefined, warn: () => undefined },
        });
      const first = build();
      first.requestCode({ email: 'kata@acme.test' }, '198.51.100.1');
      await first.settled();
      const sent = mailer.sent.length;
      await first.stop();
      const second = build();
      second.requestCode({ email: 'kata@acme.test' }, '198.51.100.1');
      await second.settled();
      expect(mailer.sent).toHaveLength(sent);
      // The IP window carries over as well.
      for (let i = 0; i < EMAIL_LOGIN_LIMITS.requestsPerIpHour - 2; i += 1) {
        second.requestCode({ email: `x${i}@acme.test` }, '198.51.100.1');
      }
      expect(() => second.requestCode({ email: 'y@acme.test' }, '198.51.100.1')).toThrow(
        expect.objectContaining({ code: 'email_login_rate_limited', status: 429 }),
      );
      await second.stop();
    });

    it('stops sending when the day total is reached, without telling the requester', async () => {
      for (let i = 0; i < EMAIL_LOGIN_LIMITS.sendsPerDay; i += 1) {
        counts().addEvent('send', `addr:filler${i % 20}`, now.toISOString());
      }
      const res = await post(routes.emailLoginRequest(), { email: 'kata@acme.test' });
      expect([res.statusCode, res.json().error.code]).toEqual([429, 'email_login_rate_limited']);
      expect(res.json().error.details.retryAfterSeconds).toBeGreaterThan(0);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe('storage and logs', () => {
    it('keeps neither the address nor the code readable in the database or the logs', async () => {
      await inviteClient('kata@acme.test', { displayName: 'Kata' });
      const ip = '203.0.113.55';
      await requestCode({ email: 'kata@acme.test' }, ip);
      const code = mailer.codeFor('kata@acme.test');
      await verify({ email: 'kata@acme.test', code: '000000' === code ? '111111' : '000000' }, ip);
      mailer.fail = new EmailCodeDeliveryError('throttled');
      now = new Date(now.getTime() + 2 * MINUTE);
      await requestCode({ email: 'kata@acme.test' }, ip);
      await verify({ email: 'kata@acme.test', code }, ip);

      const all = logs.join('\n');
      expect(all).not.toContain('kata@acme.test');
      expect(all).not.toContain(code);
      expect(all).not.toContain(ip);
      expect(all).toContain('email_code_delivery_failed');
      const dump = JSON.stringify([
        h.app.projectman.repos.emailLogin.code('x'),
        h.app.projectman.repos.emailLogin.countEvents('send', null, '1970-01-01T00:00:00.000Z'),
      ]);
      expect(dump).not.toContain('kata@acme.test');
    });
  });

  describe('regressions', () => {
    it('keeps the password login, the setup and the password invitation working', async () => {
      const developer = await inviteOf('dev@acme.test', 'developer');
      const accepted = await post(`/api/invites/${tokenOf(developer)}/accept`, {
        name: 'Dev',
        password: 'correct horse battery',
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      const res = await post(routes.login(), { email: 'dev@acme.test', password: 'correct horse battery' });
      expect(res.statusCode).toBe(200);
      const wrong = await post(routes.login(), { email: 'dev@acme.test', password: 'not the password' });
      expect(wrong.statusCode).toBe(401);
      const second = await post(routes.setup(), OWNER_LOGIN);
      expect(second.statusCode).toBe(409);
      // The host owner still holds an integrator key with a password.
      expect(
        (await inject(h.app, 'POST', routes.integratorKeys(), owner, { mode: 'super' })).statusCode,
      ).toBe(201);
    });
  });
});
