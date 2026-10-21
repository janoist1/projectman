import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { CloudflareWorld } from './helpers/fake-cloudflare';
import { SHA_NEW } from './helpers/fake-host';

/** The public board of the cloud commands (PM-672): `access.boardMode: public` through edge, publish and check. */

let world: CloudflareWorld;

const SES = { region: 'eu-west-1', domain: 'example.com', from: 'board@example.com' };
const CLOUDFLARE = { zone: 'example.com', hostname: 'board.example.com' };
const WITH_WIDGET = { ...CLOUDFLARE, feedbackHostname: 'mark.example.com' };
const MAIN = 'projectman-cloud';
const ENGINE = 'projectman-cloud-engine';
const PUBLIC_POLICY = 'projectman-cloud-public-board';
const ALLOW_POLICY = 'projectman-cloud-allow-emails';
const ENGINE_SECRET = 'engine-secret-value-0123456789abcdef';

// SES uses aws.profile unless ses.profile names another account (config.ts, PM-729).
const AWS = {
  profile: 'aroom',
  region: 'eu-west-1',
  databaseBucket: 'acme-projectman-db',
  backupBucket: 'acme-projectman-backup',
};

const publicConfig = (extra: Record<string, unknown> = {}, cloudflare: object = CLOUDFLARE) => ({
  aws: AWS,
  cloudflare: {
    ...cloudflare,
    ...(extra.integratorServiceToken ? { integratorHostname: 'machine.example.com' } : {}),
  },
  access: { emails: ['owner@example.com'], boardMode: 'public', ...extra },
  ses: SES,
});
const privateConfig = (extra: Record<string, unknown> = {}, cloudflare: object = CLOUDFLARE) => ({
  aws: AWS,
  cloudflare,
  access: { emails: ['owner@example.com'], ...extra },
  ses: SES,
});

const edge = (...args: string[]) => runCloud(['edge', ...args], world.deps());
const publish = (...args: string[]) => runCloud(['publish', ...args], world.deps());
const dnsMutations = () => world.cf.mutations().filter((call) => /dns_records/.test(call.path));
const policyIds = (name: string) => (world.cf.app(name)!.policies as { id: string }[]).map((item) => item.id);
const ingressOf = () => world.cf.configs.get(world.cf.tunnels[0]!.id)!.ingress as Record<string, unknown>[];
const env = () => readFileSync(world.envFile, 'utf8');

/** An account where `edge` ran with `config`, the zone is active, the tunnel is connected, the board runs. */
async function ready(config: Record<string, unknown>): Promise<void> {
  world.writeConfig(config);
  expect(await edge()).toBe(0);
  world.cf.zones[0]!.status = 'active';
  world.cf.tunnels[0]!.status = 'healthy';
  world.machine.preload(SHA_NEW, 'v2026.10.15');
  if ((config.cloudflare as { integratorHostname?: string }).integratorHostname)
    world.machine.publicCheck.integratorHostIsolated = true;
  world.lines.length = 0;
  world.cf.calls.length = 0;
}

beforeEach(() => {
  world = CloudflareWorld.ready();
  world.writeToken();
  world.aws.accounts.set(AWS.profile, world.aws.accounts.get('i')!);
});
afterEach(() => world.cleanup());

describe('the configuration', () => {
  it('needs the ses block for a public board, and keeps private as the default', async () => {
    world.writeConfig({ ...privateConfig(), ses: undefined, access: { emails: ['a@example.com'] } });
    expect(await edge('--dry-run')).toBe(0);
    world.writeConfig({
      cloudflare: CLOUDFLARE,
      access: { emails: ['a@example.com'], boardMode: 'public' },
    });
    expect(await edge('--dry-run')).not.toBe(0);
    expect(world.output).toContain('access.boardMode');
    expect(world.output).toContain('ses block');
  });
});

describe('edge for the public board', () => {
  it('attaches exactly the bypass policy to the main application and the service token to the engine', async () => {
    world.writeConfig(publicConfig());
    expect(await edge()).toBe(0);
    const { cf } = world;
    const bypass = cf.policy(PUBLIC_POLICY)!;
    expect(bypass).toMatchObject({
      decision: 'bypass',
      include: [{ everyone: {} }],
      exclude: [],
      require: [],
    });
    expect(policyIds(MAIN)).toEqual([bypass.id]);
    expect(policyIds(ENGINE)).toEqual([cf.policy('projectman-cloud-engine-service')!.id]);
    expect(cf.app(MAIN)).toMatchObject({ domain: 'board.example.com', auto_redirect_to_identity: false });
    expect(cf.app(ENGINE)).toMatchObject({
      domain: 'board.example.com/engine',
      auto_redirect_to_identity: true,
    });
    expect(cf.policy('projectman-cloud-engine-service')!.decision).toBe('non_identity');
    // The e-mail policy is kept for the way back, but no application uses it.
    expect(cf.policy(ALLOW_POLICY)).toBeDefined();
    expect(JSON.stringify([policyIds(MAIN), policyIds(ENGINE)])).not.toContain(cf.policy(ALLOW_POLICY)!.id);
  });

  it('keeps the integrator token per configuration but attaches no other policy to the public main application', async () => {
    world.writeConfig(publicConfig({ integratorServiceToken: true }));
    expect(await edge()).toBe(0);
    const { cf } = world;
    expect(cf.policy('projectman-cloud-integrator-service')).toBeDefined();
    expect(cf.token('projectman-cloud-integrator')).toBeDefined();
    expect(policyIds(MAIN)).toEqual([cf.policy(PUBLIC_POLICY)!.id]);
    expect(policyIds(ENGINE)).toEqual([cf.policy('projectman-cloud-engine-service')!.id]);
  });

  it('opens the ingress for the main hostname and guards only /engine with the engine audience', async () => {
    world.writeConfig(publicConfig({}, WITH_WIDGET));
    expect(await edge()).toBe(0);
    const { cf } = world;
    const access = { required: true, teamName: 'janoist1', audTag: [cf.app(ENGINE)!.aud] };
    const stripped = ingressOf().map((rule) => {
      const { originRequest, ...rest } = rule;
      return originRequest && Object.keys(originRequest as object).length > 0
        ? { ...rest, originRequest }
        : rest;
    });
    expect(stripped).toEqual([
      { hostname: 'mark.example.com', path: '^/feedback/', service: 'http://127.0.0.1:4700' },
      { hostname: 'mark.example.com', service: 'http_status:404' },
      { hostname: 'board.example.com', path: '^/hooks', service: 'http_status:404' },
      { hostname: 'board.example.com', path: '^/mcp/', service: 'http_status:404' },
      { hostname: 'board.example.com', path: '^/mcp$', service: 'http_status:404' },
      {
        hostname: 'board.example.com',
        path: '^/engine(/|$)',
        service: 'http://127.0.0.1:4700',
        originRequest: { access },
      },
      { hostname: 'board.example.com', service: 'http://127.0.0.1:4700' },
      { service: 'http_status:404' },
    ]);
    expect(JSON.stringify(ingressOf())).not.toContain('httpHostHeader');
    // The main application's audience is not demanded anywhere.
    expect(JSON.stringify(ingressOf())).not.toContain(cf.app(MAIN)!.aud as string);
  });

  it('writes the server switch to cloud.env, and changes nothing the second time', async () => {
    world.writeConfig(publicConfig());
    expect(await edge()).toBe(0);
    expect(env()).toContain('PROJECTMAN_PUBLIC_BOARD=1');
    world.cf.calls.length = 0;
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).not.toMatch(/^(created|updated) /m);
  });

  it('only reads under --dry-run when switching an existing private setup to public', async () => {
    world.writeConfig(privateConfig());
    expect(await edge()).toBe(0);
    const before = env();
    world.writeConfig(publicConfig());
    world.cf.calls.length = 0;
    expect(await edge('--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(env()).toBe(before);
    expect(policyIds(MAIN)).toEqual([world.cf.policy(ALLOW_POLICY)!.id]);
  });

  it('puts a main application right that was given a second policy by hand', async () => {
    world.writeConfig(publicConfig());
    expect(await edge()).toBe(0);
    const { cf } = world;
    cf.app(MAIN)!.policies = [
      ...(cf.app(MAIN)!.policies as object[]),
      { id: cf.policy(ALLOW_POLICY)!.id, precedence: 2 },
    ];
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect(policyIds(MAIN)).toEqual([cf.policy(PUBLIC_POLICY)!.id]);
    expect(world.output).toContain(`updated access-app ${MAIN}`);
  });
});

describe('the separate integrator host', () => {
  it('uses its own service policy and audience while keeping the private board human-only', async () => {
    await ready({
      ...privateConfig({ integratorServiceToken: true }),
      cloudflare: { ...CLOUDFLARE, integratorHostname: 'machine.example.com' },
    });
    const { cf } = world;
    expect(policyIds(MAIN)).toEqual([cf.policy(ALLOW_POLICY)!.id]);
    expect(policyIds('projectman-cloud-integrator')).toEqual([
      cf.policy('projectman-cloud-integrator-service')!.id,
    ]);
    const machineRules = ingressOf().filter((rule) => rule.hostname === 'machine.example.com');
    expect(machineRules.map((rule) => rule.path)).toEqual(['^/api/', '^/mcp$', undefined]);
    for (const rule of machineRules.slice(0, 2))
      expect(rule.originRequest).toEqual({
        access: {
          required: true,
          teamName: 'janoist1',
          audTag: [cf.app('projectman-cloud-integrator')!.aud],
        },
      });
    expect(env()).toContain('PROJECTMAN_INTEGRATOR_HOSTNAME=machine.example.com');
    world.machine.publicCheck.publicBoard = false;
    expect(await publish()).toBe(0);
    expect(world.cf.records.map((record) => record.name)).toContain('machine.example.com');
    expect(world.hostCalls.find((call) => call.subcommand === 'public-check')!.args).toEqual([
      'board.example.com',
      'machine.example.com',
    ]);
  });

  it.each([undefined, false])(
    'refuses publication when the running backend isolation is %s',
    async (isolated) => {
      await ready(publicConfig({ integratorServiceToken: true }));
      world.machine.publicCheck.integratorHostIsolated = isolated;
      expect(await publish()).toBe(2);
      expect(dnsMutations()).toEqual([]);
      expect(world.output).toContain('does not isolate the integrator host');
    },
  );

  it('refuses an integrator application that also allows a human policy', async () => {
    await ready(publicConfig({ integratorServiceToken: true }));
    world.cf.app('projectman-cloud-integrator')!.policies.push({ id: world.cf.policy(ALLOW_POLICY)!.id });
    expect(await publish()).toBe(2);
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses a missing integrator audience without falling back to another application', async () => {
    await ready(publicConfig({ integratorServiceToken: true }));
    delete world.cf.app('projectman-cloud-integrator')!.aud;
    expect(await publish()).toBe(2);
    expect(dnsMutations()).toEqual([]);
  });
});

describe('switching back to private', () => {
  it('restores the browser Access lock, removes the bypass policy and the switch, and is idempotent', async () => {
    world.writeConfig(publicConfig());
    expect(await edge()).toBe(0);
    world.writeConfig(privateConfig());
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    const { cf } = world;
    expect(cf.policy(PUBLIC_POLICY)).toBeUndefined();
    expect(policyIds(MAIN)).toEqual([cf.policy(ALLOW_POLICY)!.id]);
    expect(cf.app(MAIN)).toMatchObject({ auto_redirect_to_identity: true });
    const guarded = ingressOf().find(
      (rule) => (rule.originRequest as { access?: unknown } | undefined)?.access,
    ) as { originRequest: { access: { audTag: string[] } } };
    const audTags = guarded.originRequest.access.audTag;
    expect(audTags).toEqual([cf.app(MAIN)!.aud, cf.app(ENGINE)!.aud]);
    expect(ingressOf().some((rule) => typeof rule.path === 'string' && rule.path.includes('engine'))).toBe(
      false,
    );
    expect(env()).not.toContain('PROJECTMAN_PUBLIC_BOARD');
    expect(world.output).toContain(`deleted`);

    world.cf.calls.length = 0;
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('unchanged public-policy-cleanup: no public-board policy');
  });

  it('keeps the other cloud.env lines', async () => {
    world.writeConfig(publicConfig());
    expect(await edge()).toBe(0);
    writeFileSync(world.envFile, `${env()}PROJECTMAN_EMAIL_LOGIN_ENABLED=1\n`, { mode: 0o600 });
    world.writeConfig(privateConfig());
    expect(await edge()).toBe(0);
    expect(env()).toContain('PROJECTMAN_EMAIL_LOGIN_ENABLED=1');
    expect(env()).toContain('TUNNEL_TOKEN=');
  });
});

describe('publish for the public board', () => {
  it('publishes the proxied CNAME on the working answer, and only then', async () => {
    await ready(publicConfig());
    expect(await publish()).toBe(0);
    expect(world.hostCalls.find((call) => call.subcommand === 'public-check')!.args).toEqual([
      'board.example.com',
    ]);
    expect(dnsMutations().map((call) => (call.body as { name: string }).name)).toEqual(['board.example.com']);
    expect(world.output).toContain('ok public-board-ingress');
    expect(world.output).toContain('ok public-board-env');
    expect(world.output).toContain('ok public-board-check');
  });

  it.each([
    ['the server is not the public board', { publicBoard: false }, 'publicBoard'],
    ['the e-mail login is off', { emailLoginEnabled: false }, 'e-mail login'],
    ['the owner is not set up', { needsSetup: true }, 'no owner'],
    ['the API answers an anonymous caller', { apiStatus: 200 }, 'not 401'],
    ['the API answers 403 instead of 401', { apiStatus: 403 }, 'not 401'],
    ['a cross-origin login is not refused', { crossOriginStatus: 200 }, 'not 403'],
    ['a cross-origin login gets 401', { crossOriginStatus: 401 }, 'not 403'],
  ])('refuses and makes no record when %s', async (_label, change, text) => {
    await ready(publicConfig());
    world.machine.publicCheck = { ...world.machine.publicCheck, ...change };
    expect(await publish()).toBe(2);
    expect(world.output).toContain(text);
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses while the board is not running', async () => {
    await ready(publicConfig());
    world.machine.running = false;
    expect(await publish()).toBe(2);
    expect(world.output).toContain('not running');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when the answer of the machine has an unexpected shape', async () => {
    await ready(publicConfig());
    world.machine.publicCheck = { publicBoard: 'yes' };
    expect(await publish()).toBe(1);
    expect(world.output).toContain('unexpected shape');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when the main application has another policy attached', async () => {
    await ready(publicConfig());
    const { cf } = world;
    cf.app(MAIN)!.policies = [
      ...(cf.app(MAIN)!.policies as object[]),
      { id: cf.policy(ALLOW_POLICY)!.id, precedence: 2 },
    ];
    expect(await publish()).toBe(2);
    expect(world.output).toContain('Access is not in place');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when the bypass policy is not exactly everyone', async () => {
    await ready(publicConfig());
    world.cf.policy(PUBLIC_POLICY)!.include = [{ email_domain: { domain: 'example.com' } }];
    expect(await publish()).toBe(2);
    expect(world.output).toContain('not exactly the bypass for everyone');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when the engine application is not exactly the engine service token', async () => {
    await ready(publicConfig());
    world.cf.policy('projectman-cloud-engine-service')!.decision = 'bypass';
    expect(await publish()).toBe(2);
    expect(world.output).toContain('is not exactly its service token');
    expect(dnsMutations()).toEqual([]);
  });

  it.each([
    [
      'the main hostname demands the main audience',
      (aud: { main: string; engine: string }) => [
        { hostname: 'board.example.com', path: '^/hooks', service: 'http_status:404' },
        { hostname: 'board.example.com', path: '^/mcp/', service: 'http_status:404' },
        {
          hostname: 'board.example.com',
          service: 'http://127.0.0.1:4700',
          originRequest: { access: { required: true, teamName: 'janoist1', audTag: [aud.main, aud.engine] } },
        },
        { service: 'http_status:404' },
      ],
    ],
    [
      '/hooks is passed on',
      (aud: { main: string; engine: string }) => [
        { hostname: 'board.example.com', path: '^/mcp/', service: 'http_status:404' },
        {
          hostname: 'board.example.com',
          path: '^/engine(/|$)',
          service: 'http://127.0.0.1:4700',
          originRequest: { access: { required: true, teamName: 'janoist1', audTag: [aud.engine] } },
        },
        { hostname: 'board.example.com', service: 'http://127.0.0.1:4700' },
        { service: 'http_status:404' },
      ],
    ],
    [
      '/engine needs no audience',
      () => [
        { hostname: 'board.example.com', path: '^/hooks', service: 'http_status:404' },
        { hostname: 'board.example.com', path: '^/mcp/', service: 'http_status:404' },
        { hostname: 'board.example.com', service: 'http://127.0.0.1:4700' },
        { service: 'http_status:404' },
      ],
    ],
  ])('refuses when the live tunnel is wrong: %s', async (_label, wrong) => {
    await ready(publicConfig());
    const { cf } = world;
    cf.configs.set(cf.tunnels[0]!.id, {
      ingress: wrong({ main: cf.app(MAIN)!.aud as string, engine: cf.app(ENGINE)!.aud as string }),
    });
    expect(await publish()).toBe(2);
    expect(world.output).toContain('the tunnel is not set for the public board');
    expect(dnsMutations()).toEqual([]);
  });

  it('refuses when cloud.env does not switch the server to the public board', async () => {
    await ready(publicConfig());
    writeFileSync(world.envFile, 'TUNNEL_TOKEN=tunnel-token-value-0123456789\n', { mode: 0o600 });
    expect(await publish()).toBe(2);
    expect(world.output).toContain('PROJECTMAN_PUBLIC_BOARD=1');
    expect(dnsMutations()).toEqual([]);
  });

  it('needs the working feedback guard when the widget hostname is configured, without --feedback', async () => {
    await ready(publicConfig({}, WITH_WIDGET));
    world.machine.guardCodes = { plain: '200', port: '404' };
    expect(await publish()).toBe(2);
    expect(world.output).toContain('not 404 twice');
    expect(dnsMutations()).toEqual([]);
    world.machine.guardCodes = { plain: '404', port: '404' };
    world.cf.calls.length = 0;
    expect(await publish()).toBe(0);
    // The widget hostname is published only with --feedback.
    expect(dnsMutations().map((call) => (call.body as { name: string }).name)).toEqual(['board.example.com']);
  });

  it('only reads under --dry-run', async () => {
    await ready(publicConfig());
    expect(await publish('--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
  });

  it('does not ask the machine for the public answer in private mode', async () => {
    await ready(privateConfig());
    world.machine.publicCheck = { publicBoard: false };
    expect(await publish()).toBe(0);
    expect(world.hostCalls.some((call) => call.subcommand === 'public-check')).toBe(false);
  });
});

describe('check for the public board', () => {
  let loginFile: string;
  const check = () => runCloud(['check', '--login-json', loginFile], world.deps());
  const DOORS = ['/engine/link', '/engine/files/downloads/smoke-test', '/engine/files/uploads/smoke-test'];

  /** The doors as they should be: Access login without a token; with the engine token the board's refusal. */
  const goodDoors = (tokenOnBoard = 401) => {
    world.doors = (url, init) => {
      const headers = new Headers(init.headers);
      const target = new URL(url);
      const integrator = headers.get('cf-access-client-id') === 'integrator-id.access';
      if (target.hostname === 'machine.example.com')
        return new Response('', {
          status: !integrator ? 403 : ['/api/projects', '/mcp'].includes(target.pathname) ? 401 : 404,
        });
      if (integrator && target.pathname.startsWith('/engine/')) return new Response('', { status: 403 });
      if (headers.has('cf-access-client-id') && String(url).includes('%65'))
        return new Response('', { status: 404 });
      if (!headers.has('cf-access-client-id'))
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://janoist1.cloudflareaccess.com/cdn-cgi/access/login/board.example.com',
          },
        });
      return new Response('', { status: new URL(url).pathname === '/api/auth/me' ? tokenOnBoard : 401 });
    };
  };

  beforeEach(() => {
    world.writeConfig(publicConfig({ integratorServiceToken: true }));
    writeFileSync(
      path.join(world.secretsDir, 'integrator-access-token.json'),
      JSON.stringify({
        'CF-Access-Client-Id': 'integrator-id.access',
        'CF-Access-Client-Secret': 'integrator-secret-value',
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      path.join(world.secretsDir, 'engine-access-token.json'),
      `${JSON.stringify({ 'CF-Access-Client-Id': 'engine-id.access', 'CF-Access-Client-Secret': ENGINE_SECRET })}\n`,
      { mode: 0o600 },
    );
    loginFile = path.join(world.home, 'login.json');
    writeFileSync(loginFile, '{"email":"a@example.com","password":"correct horse battery"}', { mode: 0o600 });
    chmodSync(loginFile, 0o600);
    goodDoors();
  });

  it('checks the public board and both isolated machine audiences', async () => {
    expect(await check()).toBe(0);
    const script = world.scriptCalls.find((call) => call.script === 'check.sh')!;
    expect(script.env).toMatchObject({
      LOGIN_JSON: loginFile,
      BOARD_MODE: 'public',
      INTEGRATOR_ORIGIN: 'https://machine.example.com',
    });
    expect(world.doorCalls.slice(0, 9).map((call) => new URL(call.url).pathname)).toEqual([
      ...DOORS.flatMap((door) => [door, door]),
      '/%65ngine/link',
      '/%65ngine/link',
      '/api/auth/me',
    ]);
    expect(world.output).toContain('ok integrator-doors');
    expect(world.scriptCalls.some((call) => call.script === 'smoke.sh')).toBe(false);
  });

  it('fails when the engine token gives board rights', async () => {
    goodDoors(200);
    expect(await check()).toBe(1);
    expect(world.output).toContain('/api/auth/me with the engine token answered 200');
    expect(world.output).not.toContain(ENGINE_SECRET);
  });

  it('fails when the engine door is open without a service token', async () => {
    world.doors = () => new Response('{}', { status: 200 });
    expect(await check()).toBe(1);
    expect(world.output).toContain('without a token answered 200');
  });

  it('fails when the engine token file is missing', async () => {
    rmSync(path.join(world.secretsDir, 'engine-access-token.json'));
    expect(await check()).toBe(2);
  });
});
