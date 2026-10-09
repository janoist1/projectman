import { afterEach, describe, expect, it } from 'vitest';
import type { ApiError, SetupStatus } from '@projectman/shared';
import { isLocalRequest, requestProtocol } from '../src/auth';
import { createSetupCode, generateSetupCode, MAX_SETUP_CODE_FAILURES } from '../src/auth/setup-code';
import { createAppHarness, OWNER_LOGIN } from './helpers/app-harness';
import type { AppHarness } from './helpers/app-harness';

const CODE = 'ABCD-2345-WXYZ';
const PUBLIC_HOST = 'chopper.example.com';

/** What the cloudflared tunnel hands the server: a loopback peer, the public name, the real client. */
const TUNNEL_HEADERS = {
  host: PUBLIC_HOST,
  'x-forwarded-for': '203.0.113.9',
  'cf-connecting-ip': '203.0.113.9',
  'x-forwarded-proto': 'https',
};

describe('the setup code (PM-317)', () => {
  it('is 12 base32 characters in groups of four', () => {
    for (let i = 0; i < 20; i++) expect(generateSetupCode()).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){2}$/);
    expect(generateSetupCode()).not.toBe(generateSetupCode());
  });

  it('matches whatever way a person types it, and voids after the allowed wrong tries', () => {
    const code = createSetupCode({ code: CODE });
    expect(code.verify('abcd 2345 wxyz')).toBe('ok');
    expect(code.verify('ABCD2345WXYZ')).toBe('ok');
    for (let i = 1; i < MAX_SETUP_CODE_FAILURES; i++) expect(code.verify('AAAA-AAAA-AAAA')).toBe('wrong');
    expect(code.active()).toBe(true);
    expect(code.verify('AAAA-AAAA-AAAA')).toBe('wrong');
    expect(code.active()).toBe(false);
    expect(code.value).toBeNull();
    expect(code.verify(CODE)).toBe('void');
  });

  it('is gone once consumed', () => {
    const code = createSetupCode({ code: CODE });
    code.consume();
    expect(code.verify(CODE)).toBe('void');
  });
});

describe('the first setup in cloud mode (PM-317)', () => {
  let h: AppHarness | undefined;
  afterEach(async () => {
    await h?.close();
    h = undefined;
  });

  const start = async (engineMode?: 'cloud') => {
    h = await createAppHarness({ app: { engineMode, setupCode: CODE, clientIpHeader: 'cf-connecting-ip' } });
    return h;
  };
  const setup = (payload: object, headers: Record<string, string> = TUNNEL_HEADERS) =>
    h!.app.inject({ method: 'POST', url: '/api/setup', payload, headers });
  const codeOf = (res: { json<T>(): T }) => res.json<ApiError>().error.code;

  it('sees a request through the tunnel as remote, over HTTPS', async () => {
    const request = { socket: { remoteAddress: '127.0.0.1' }, headers: TUNNEL_HEADERS, protocol: 'http' };
    expect(isLocalRequest(request as never)).toBe(false);
    expect(requestProtocol(request as never)).toBe('https');
    // The forbidden tunnel setting (httpHostHeader on loopback) would make the same request local.
    const loopbackHost = { ...request, headers: { ...TUNNEL_HEADERS, host: '127.0.0.1:4700' } };
    expect(isLocalRequest({ ...loopbackHost, headers: { host: '127.0.0.1:4700' } } as never)).toBe(true);
    expect(isLocalRequest(loopbackHost as never)).toBe(false);
  });

  it('asks for the code only in cloud mode and only before the first user', async () => {
    await start('cloud');
    const status = await h!.app.inject({ method: 'GET', url: '/api/setup' });
    expect(status.json<SetupStatus>()).toEqual({ needsSetup: true, needsSetupCode: true });

    await h!.close();
    await start();
    const single = await h!.app.inject({ method: 'GET', url: '/api/setup' });
    expect(single.json<SetupStatus>()).toEqual({ needsSetup: true });
  });

  it('refuses a remote setup without the code or with a wrong one', async () => {
    await start('cloud');
    const missing = await setup({ ...OWNER_LOGIN });
    expect(missing.statusCode).toBe(403);
    expect(codeOf(missing)).toBe('setup_code_invalid');
    const wrong = await setup({ ...OWNER_LOGIN, setupCode: 'AAAA-AAAA-AAAA' });
    expect(wrong.statusCode).toBe(403);
    expect(codeOf(wrong)).toBe('setup_code_invalid');
    expect(h!.app.projectman.auth.needsSetup()).toBe(true);
  });

  it('creates the owner with the code, sets a Secure cookie and makes the code void', async () => {
    await start('cloud');
    const res = await setup({ ...OWNER_LOGIN, setupCode: CODE.toLowerCase() });
    expect(res.statusCode).toBe(201);
    expect(res.headers['set-cookie']).toContain('Secure');
    expect(h!.app.projectman.auth.needsSetup()).toBe(false);

    const again = await setup({ ...OWNER_LOGIN, setupCode: CODE });
    // An owner exists: no code error, the plain answer (the code is gone and cannot be guessed at).
    expect(again.statusCode).toBe(409);
    expect(codeOf(again)).toBe('already_set_up');
    const noCode = await setup({ ...OWNER_LOGIN });
    expect(codeOf(noCode)).toBe('already_set_up');
    const status = await h!.app.inject({ method: 'GET', url: '/api/setup' });
    expect(status.json<SetupStatus>()).toEqual({ needsSetup: false });
  });

  it('voids the code after ten wrong tries, even for the right one', async () => {
    await start('cloud');
    for (let i = 0; i < MAX_SETUP_CODE_FAILURES; i++) {
      const wrong = await setup({ ...OWNER_LOGIN, setupCode: `AAAA-AAAA-${String(1000 + i)}` });
      expect(wrong.statusCode).toBe(403);
    }
    const right = await setup({ ...OWNER_LOGIN, setupCode: CODE });
    expect(right.statusCode).toBe(403);
    expect(right.json<ApiError>().error.message).toContain('void');
    expect(h!.app.projectman.auth.needsSetup()).toBe(true);
  });

  it('lets the machine itself set up without the code', async () => {
    await start('cloud');
    const res = await h!.app.inject({ method: 'POST', url: '/api/setup', payload: { ...OWNER_LOGIN } });
    expect(res.statusCode).toBe(201);
  });

  it('stays as before in single-machine mode: remote is refused, the code means nothing', async () => {
    await start();
    const remote = await setup({ ...OWNER_LOGIN, setupCode: CODE });
    expect(remote.statusCode).toBe(403);
    expect(codeOf(remote)).toBe('setup_requires_localhost');
    const local = await h!.app.inject({ method: 'POST', url: '/api/setup', payload: { ...OWNER_LOGIN } });
    expect(local.statusCode).toBe(201);
  });
});
