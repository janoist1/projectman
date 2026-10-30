import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Me } from '@projectman/shared';
import { CreatedIntegratorAccessKey, routes } from '@projectman/shared';
import { migrate } from '../src/db';
import { migrations } from '../src/db/migrations';
import { cookieOf, createAppHarness, createProject, inject, OWNER_LOGIN } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const newAccount = { name: 'Kata', password: 'correct horse battery' };
const invitation = {
  email: 'kata@acme.test',
  displayName: 'Kata',
  access: 'developer',
  roles: ['developer'],
};

describe('account system language migration (PM-1177)', () => {
  it('makes every existing account Hungarian and a later insert English', () => {
    const db = new Database(':memory:');
    try {
      for (const migration of migrations.filter((item) => item.version <= 136)) db.exec(migration.sql);
      db.pragma('user_version = 136');
      db.exec(
        `INSERT INTO users (id, name, email, password_hash, created_at) VALUES ('usr_old', 'Old', 'old@example.test', 'x', '2026-01-01');`,
      );
      migrate(db);
      db.exec(
        `INSERT INTO users (id, name, email, password_hash, created_at) VALUES ('usr_new', 'New', 'new@example.test', 'x', '2026-01-02');`,
      );
      const languageOf = (id: string) =>
        (db.prepare('SELECT language FROM users WHERE id = ?').get(id) as { language: string }).language;
      expect(languageOf('usr_old')).toBe('hu');
      expect(languageOf('usr_new')).toBe('en');
    } finally {
      db.close();
    }
  });
});

describe('account system language (PM-1177)', () => {
  let h: AppHarness;
  beforeEach(async () => {
    h = await createAppHarness();
  });
  afterEach(async () => h.close());

  const setup = (extra: Record<string, unknown> = {}) =>
    h.app.inject({ method: 'POST', url: '/api/setup', payload: { ...OWNER_LOGIN, ...extra } });
  const languageOfEmail = (email: string) => h.app.projectman.repos.users.findByEmail(email)?.language;

  describe('the language route', () => {
    it('saves the language and returns the account', async () => {
      const cookie = cookieOf(await setup());
      const response = await inject(h.app, 'PUT', routes.myLanguage(), cookie, { language: 'hu' });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json<Me>().language).toBe('hu');
      expect(languageOfEmail(OWNER_LOGIN.email)).toBe('hu');
      expect((await inject(h.app, 'GET', routes.me(), cookie)).json<Me>().language).toBe('hu');
    });

    it('refuses an unknown language and an extra field', async () => {
      const cookie = cookieOf(await setup());
      for (const body of [{ language: 'de' }, {}, { language: 'hu', extra: 1 }]) {
        const response = await inject(h.app, 'PUT', routes.myLanguage(), cookie, body);
        expect([response.statusCode, response.json().error.code]).toEqual([400, 'invalid_request']);
      }
      expect(languageOfEmail(OWNER_LOGIN.email)).toBe('en');
    });

    it('needs a login and refuses an integrator key', async () => {
      const cookie = cookieOf(await setup());
      expect((await inject(h.app, 'PUT', routes.myLanguage(), null, { language: 'hu' })).statusCode).toBe(
        401,
      );
      const created = CreatedIntegratorAccessKey.parse(
        (await inject(h.app, 'POST', routes.integratorKeys(), cookie, { mode: 'super' })).json(),
      );
      const response = await h.app.inject({
        method: 'PUT',
        url: routes.myLanguage(),
        headers: { cookie, authorization: `Bearer ${created.secret}` },
        payload: { language: 'hu' },
      });
      expect([response.statusCode, response.json().error.code]).toEqual([403, 'integrator_not_allowed']);
      expect(languageOfEmail(OWNER_LOGIN.email)).toBe('en');
    });
  });

  describe('a new account', () => {
    it.each([
      [undefined, 'en'],
      ['hu', 'hu'],
      ['en', 'en'],
    ] as const)('created at setup with the request language %s is %s', async (language, expected) => {
      const response = await setup(language ? { language } : {});
      expect(response.statusCode, response.body).toBe(201);
      expect(languageOfEmail(OWNER_LOGIN.email)).toBe(expected);
      expect((await inject(h.app, 'GET', routes.me(), cookieOf(response))).json<Me>().language).toBe(
        expected,
      );
    });

    describe('through an invitation', () => {
      let owner: string;
      beforeEach(async () => {
        owner = cookieOf(await setup());
        await createProject(h, owner);
      });
      const invite = async (project = 'AR') => {
        const response = await inject(h.app, 'POST', `/api/projects/${project}/invites`, owner, invitation);
        expect(response.statusCode, response.body).toBe(201);
        return (response.json<{ path: string }>().path as string).replace('/invite/', '/api/invites/');
      };

      it.each([
        [undefined, 'en'],
        ['hu', 'hu'],
      ] as const)('accepted with the request language %s is %s', async (language, expected) => {
        const path = await invite();
        const accepted = await inject(h.app, 'POST', `${path}/accept`, undefined, {
          ...newAccount,
          ...(language ? { language } : {}),
        });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(languageOfEmail(invitation.email)).toBe(expected);
      });

      it('never overwrites the language of an existing account that accepts a second invitation', async () => {
        const first = await invite();
        await inject(h.app, 'POST', `${first}/accept`, undefined, { ...newAccount, language: 'hu' });
        await createProject(h, owner, 'BR');
        const second = await invite('BR');
        const login = await inject(h.app, 'POST', routes.login(), undefined, {
          email: invitation.email,
          password: newAccount.password,
        });
        expect(login.statusCode, login.body).toBe(200);
        const accepted = await inject(h.app, 'POST', `${second}/accept`, cookieOf(login), { language: 'en' });
        expect(accepted.statusCode, accepted.body).toBe(200);
        expect(languageOfEmail(invitation.email)).toBe('hu');
      });
    });
  });

  describe('a project created without a language', () => {
    const create = (cookie: string, key: string, extra: Record<string, unknown> = {}) =>
      inject(h.app, 'POST', routes.projects(), cookie, {
        key,
        name: key.toLowerCase(),
        workspacePath: h.workspace,
        templateId: 'test',
        ...extra,
      });
    const projectLanguage = async (key: string) =>
      (await h.app.projectman.configStore.load(key)).config.project.language;

    it('gets the creator system language, and an explicit language wins', async () => {
      const cookie = cookieOf(await setup({ language: 'hu' }));
      expect((await create(cookie, 'PA')).statusCode).toBe(201);
      expect(await projectLanguage('PA')).toBe('hu');
      expect((await create(cookie, 'PB', { language: 'en' })).statusCode).toBe(201);
      expect(await projectLanguage('PB')).toBe('en');
      await inject(h.app, 'PUT', routes.myLanguage(), cookie, { language: 'en' });
      expect((await create(cookie, 'PC')).statusCode).toBe(201);
      expect(await projectLanguage('PC')).toBe('en');
    });
  });
});
