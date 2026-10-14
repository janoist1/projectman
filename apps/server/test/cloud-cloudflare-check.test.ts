import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { CloudflareWorld } from './helpers/fake-cloudflare';

/** `npm run cloud -- check --login-json <file>` (PM-536). */

let world: CloudflareWorld;
let loginFile: string;

const ENGINE_SECRET = 'engine-secret-value-0123456789abcdef';
const INTEGRATOR_SECRET = 'integrator-secret-value-0123456789abcdef';
const DOORS = ['/engine/link', '/engine/files/downloads/smoke-test', '/engine/files/uploads/smoke-test'];

function writeTokenFile(name: string, id: string, secret: string): void {
  writeFileSync(
    path.join(world.secretsDir, name),
    `${JSON.stringify({ 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

const check = (...extra: string[]) => runCloud(['check', '--login-json', loginFile, ...extra], world.deps());

/** The doors as they should be: Access login without a token, the board's own refusal with the engine token. */
function goodDoors(): void {
  world.doors = (_url, init) => {
    const headers = new Headers(init.headers);
    return headers.has('cf-access-client-id')
      ? new Response('', { status: 401 })
      : new Response('', {
          status: 302,
          headers: {
            location: 'https://janoist1.cloudflareaccess.com/cdn-cgi/access/login/board.example.com',
          },
        });
  };
}

beforeEach(() => {
  world = CloudflareWorld.ready();
  world.writeToken();
  writeTokenFile('engine-access-token.json', 'engine-id.access', ENGINE_SECRET);
  loginFile = path.join(world.home, 'login.json');
  writeFileSync(loginFile, '{"email":"a@example.com","password":"correct horse battery"}', { mode: 0o600 });
  goodDoors();
});
afterEach(() => world.cleanup());

describe('check', () => {
  it('runs check.sh with the login file in its environment and the three doors of the engine', async () => {
    expect(await check()).toBe(0);
    const script = world.scriptCalls.find((call) => call.script === 'check.sh')!;
    expect(script.args.slice(1)).toEqual(['https://board.example.com']);
    expect(script.env).toEqual({ LOGIN_JSON: loginFile });
    expect(world.output).toContain('ok access-checks: https://board.example.com');
    expect(world.output).toContain('ok engine-doors');
    expect(world.doorCalls.map((call) => new URL(call.url).pathname)).toEqual(
      DOORS.flatMap((door) => [door, door]),
    );
    expect(world.doorCalls.every((call) => call.redirect === 'manual')).toBe(true);
    expect(world.output).not.toContain(ENGINE_SECRET);
    expect(world.output).toContain('skipped integrator-smoke');
  });

  it('passes the feedback origin to check.sh when there is a feedback hostname', async () => {
    world.writeConfig({
      cloudflare: {
        zone: 'example.com',
        hostname: 'board.example.com',
        feedbackHostname: 'mark.example.com',
      },
    });
    expect(await check()).toBe(0);
    expect(world.scriptCalls.find((call) => call.script === 'check.sh')!.env).toEqual({
      LOGIN_JSON: loginFile,
      FEEDBACK_ORIGIN: 'https://mark.example.com',
    });
  });

  it('prints what check.sh found and fails when it exits 1', async () => {
    world.scripts.set('check.sh', {
      code: 1,
      stdout: 'ok    one\nFAIL  /: cf-cache-status is HIT\n',
      stderr: '',
    });
    expect(await check()).toBe(1);
    expect(world.output).toContain('FAIL  /: cf-cache-status is HIT');
    expect(world.output).toContain('FAIL access-checks');
  });

  it('is refused (2) when check.sh cannot start, for example without a cloudflared login', async () => {
    world.scripts.set('check.sh', {
      code: 2,
      stdout: '',
      stderr: 'no Access token: run cloudflared access login\n',
    });
    expect(await check()).toBe(2);
    expect(world.output).toContain('no Access token');
  });

  it('refuses a login file that anyone else can read', async () => {
    writeFileSync(loginFile, '{}', { mode: 0o644 });
    const { chmodSync } = await import('node:fs');
    chmodSync(loginFile, 0o644);
    expect(await check()).toBe(2);
    expect(world.output).toContain('must be 600');
    expect(world.scriptCalls).toEqual([]);
  });

  it('needs --login-json', async () => {
    expect(await runCloud(['check'], world.deps())).toBe(64);
  });
});

describe('the engine doors', () => {
  it('fails when the engine token gets through to a success', async () => {
    world.doors = (_url, init) =>
      new Headers(init.headers).has('cf-access-client-id')
        ? new Response('{}', { status: 200 })
        : new Response('', { status: 403 });
    expect(await check()).toBe(1);
    expect(world.output).toContain('with the engine token answered 200: the door is open');
    expect(world.output).not.toContain(ENGINE_SECRET);
  });

  it('fails when the engine token is sent to the Access login (not accepted)', async () => {
    world.doors = (_url, init) => {
      void init;
      return new Response('', {
        status: 302,
        headers: { location: 'https://janoist1.cloudflareaccess.com/cdn-cgi/access/login/x' },
      });
    };
    expect(await check()).toBe(1);
    expect(world.output).toContain('went to the Access login');
  });

  it('fails when a door does not answer at all', async () => {
    world.doors = (_url, init) => {
      if (new Headers(init.headers).has('cf-access-client-id')) throw new Error('connection reset');
      return new Response('', { status: 403 });
    };
    expect(await check()).toBe(1);
    expect(world.output).toContain('no answer (000)');
  });

  it('fails when a door is open without any token', async () => {
    world.doors = () => new Response('{}', { status: 200 });
    expect(await check()).toBe(1);
    expect(world.output).toContain('without a token answered 200');
  });

  it('is refused when the engine token file is missing', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(path.join(world.secretsDir, 'engine-access-token.json'));
    expect(await check()).toBe(2);
    expect(world.output).toContain('run "npm run cloud -- edge"');
  });
});

describe('the integrator smoke test', () => {
  beforeEach(() => {
    world.writeConfig({
      cloudflare: { zone: 'example.com', hostname: 'board.example.com' },
      access: { emails: ['owner@example.com'], integratorServiceToken: true },
    });
    writeTokenFile('integrator-access-token.json', 'integrator-id.access', INTEGRATOR_SECRET);
  });

  it('runs smoke.sh with the token in the environment and never in the arguments', async () => {
    expect(await check()).toBe(0);
    const smoke = world.scriptCalls.find((call) => call.script === 'smoke.sh')!;
    expect(smoke.args.slice(1)).toEqual(['https://board.example.com']);
    expect(smoke.env).toEqual({
      CF_ACCESS_CLIENT_ID: 'integrator-id.access',
      CF_ACCESS_CLIENT_SECRET: INTEGRATOR_SECRET,
    });
    expect(smoke.args.join(' ')).not.toContain(INTEGRATOR_SECRET);
    expect(world.output).toContain('ok integrator-smoke');
  });

  it('masks the secret if the script echoes it, and fails when the script fails', async () => {
    world.scripts.set('smoke.sh', { code: 1, stdout: '', stderr: `FAIL: sent ${INTEGRATOR_SECRET}\n` });
    expect(await check()).toBe(1);
    expect(world.output).not.toContain(INTEGRATOR_SECRET);
    expect(world.output).toContain('FAIL integrator-smoke');
  });
});
