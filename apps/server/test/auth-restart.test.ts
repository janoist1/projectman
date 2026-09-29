import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { cookieOf, OWNER_LOGIN, setupOwner } from './helpers/app-harness';
import { createFakeMcp, createFakeRunnerModule, FakeGithub } from './helpers/fakes';

it('keeps a login cookie valid after rebuilding the app on the same home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pm-auth-restart-'));
  let app: FastifyInstance | undefined;
  const build = () => {
    const runner = createFakeRunnerModule();
    const mcp = createFakeMcp();
    return buildApp({
      home,
      logger: false,
      modules: {
        createRunnerModule: (opts) => runner.create(opts),
        createMcpModule: (opts) => mcp.create(opts),
        github: new FakeGithub(),
      },
    });
  };
  try {
    app = await build();
    expect(statSync(home).mode & 0o777).toBe(0o700);
    await setupOwner(app);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: OWNER_LOGIN.email, password: OWNER_LOGIN.password },
    });
    expect(login.statusCode).toBe(200);
    const cookie = cookieOf(login);
    const secret = readFileSync(join(home, 'secret'), 'utf8');
    expect(login.headers['set-cookie']).toContain('Max-Age=2592000');
    await app.close();
    app = await build();
    expect(readFileSync(join(home, 'secret'), 'utf8')).toBe(secret);
    const me = await app.inject({ url: '/api/me', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ email: OWNER_LOGIN.email });
    expect((await app.inject({ url: '/api/setup' })).json()).toEqual({ needsSetup: false });
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  } finally {
    await app?.close();
    rmSync(home, { recursive: true, force: true });
  }
});
