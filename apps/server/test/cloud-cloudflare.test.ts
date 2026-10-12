import { existsSync, readFileSync, statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { CF_ACCOUNT, CloudflareWorld } from './helpers/fake-cloudflare';

/** `npm run cloud -- edge` against the stateful Cloudflare fake (PM-536). */

let world: CloudflareWorld;
beforeEach(() => {
  world = CloudflareWorld.ready();
  world.writeToken();
});
afterEach(() => world.cleanup());

const edge = (...args: string[]) => runCloud(['edge', ...args], world.deps());

const FEEDBACK = { zone: 'example.com', hostname: 'board.example.com', feedbackHostname: 'mark.example.com' };

function tokenFile(name: string): { id: string; secret: string } {
  const parsed = JSON.parse(readFileSync(world.tokenPath(name), 'utf8')) as Record<string, string>;
  return { id: parsed['CF-Access-Client-Id']!, secret: parsed['CF-Access-Client-Secret']! };
}

describe('edge on a fresh account', () => {
  it('makes the zone, the settings, the rule, Access, the tokens, the tunnel and the cloud.env value', async () => {
    expect(await edge()).toBe(0);
    const { cf } = world;

    expect(cf.mutationsTo('POST', /^\/zones$/)[0]!.body).toEqual({
      name: 'example.com',
      account: { id: CF_ACCOUNT },
      type: 'full',
      jump_start: false,
    });
    expect(world.output).toContain(
      'created zone: example.com is pending; name servers: ada.ns.cloudflare.com, bob.ns.cloudflare.com',
    );

    const zone = cf.zones[0]!;
    expect(cf.zoneSettings(zone.id)).toMatchObject({
      always_use_https: 'on',
      min_tls_version: '1.2',
      automatic_https_rewrites: 'off',
      rocket_loader: 'off',
      email_obfuscation: 'off',
      server_side_exclude: 'off',
      security_header: {
        strict_transport_security: {
          enabled: true,
          max_age: 15552000,
          include_subdomains: false,
          preload: false,
          nosniff: true,
        },
      },
    });
    expect(cf.idps).toHaveLength(1);
    expect(cf.idps[0]).toMatchObject({ type: 'onetimepin', name: 'One-time PIN', config: {} });
    expect(cf.tokens.map((token) => token.name)).toEqual(['projectman-cloud-engine']);
    expect(cf.tokens[0]!.duration).toBe('8760h');
    expect(cf.policies.map((policy) => policy.name)).toEqual([
      'projectman-cloud-allow-emails',
      'projectman-cloud-engine-service',
    ]);
    expect(cf.apps.map((app) => app.name)).toEqual(['projectman-cloud', 'projectman-cloud-engine']);
    expect(cf.tunnels).toHaveLength(1);
    expect(cf.tunnels[0]).toMatchObject({ name: 'projectman-cloud', config_src: 'cloudflare' });

    const env = readFileSync(world.envFile, 'utf8');
    expect(env).toContain(`TUNNEL_TOKEN=tunnel-token-of-${cf.tunnels[0]!.id}-0123456789abcdef`);
    expect(world.lines).toContain(
      'note: cloud.env changed; run "npm run cloud -- deploy" to hand it to the machine',
    );
  });

  it('changes nothing when it runs a second time', async () => {
    expect(await edge()).toBe(0);
    world.lines.length = 0;
    world.cf.calls.length = 0;
    expect(await edge()).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.lines.filter((line) => /^(created|updated) /.test(line))).toEqual([]);
    expect(world.lines.some((line) => line.startsWith('note: cloud.env changed'))).toBe(false);
  });

  it('only reads under --dry-run and writes no file', async () => {
    expect(await edge('--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.lines.filter((line) => line.startsWith('skipped ')).length).toBeGreaterThan(5);
    expect(world.output).toContain('skipped zone: dry-run: would create the zone example.com');
    expect(existsSync(world.tokenPath('engine-access-token.json'))).toBe(false);
    expect(readFileSync(world.envFile, 'utf8')).toContain('TUNNEL_TOKEN=tunnel-token-value-0123456789');
  });

  it('only reads under --dry-run on a zone that exists, and says what it would change', async () => {
    world.cf.addZone('example.com', 'active');
    expect(await edge('--dry-run')).toBe(0);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.output).toContain('skipped zone-settings: dry-run: would set');
    expect(world.output).toContain(
      'skipped transform-rule: dry-run: would add the rule projectman_frame_headers',
    );
  });
});

describe('the Access setup', () => {
  beforeEach(async () => {
    world.writeConfig({ ...{}, access: { emails: ['Owner@Example.com', 'second@example.com'] } });
    expect(await edge()).toBe(0);
  });

  it('allows exactly the listed e-mail addresses, nobody else', () => {
    const policy = world.cf.policy('projectman-cloud-allow-emails')!;
    expect(policy.decision).toBe('allow');
    expect(policy.include).toEqual([
      { email: { email: 'owner@example.com' } },
      { email: { email: 'second@example.com' } },
    ]);
    expect(policy.exclude).toEqual([]);
    expect(policy.require).toEqual([]);
    expect(JSON.stringify(policy)).not.toMatch(/everyone|group|email_domain/);
  });

  it('drops an address that was taken out of the list', async () => {
    world.writeConfig({ access: { emails: ['second@example.com'] } });
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect(world.cf.policy('projectman-cloud-allow-emails')!.include).toEqual([
      { email: { email: 'second@example.com' } },
    ]);
    expect(world.output).toContain('updated policy projectman-cloud-allow-emails');
  });

  it('gives each application exactly its own policies', () => {
    const { cf } = world;
    const ids = (name: string) => (cf.app(name)!.policies as { id: string }[]).map((policy) => policy.id);
    expect(ids('projectman-cloud')).toEqual([cf.policy('projectman-cloud-allow-emails')!.id]);
    expect(ids('projectman-cloud-engine')).toEqual([cf.policy('projectman-cloud-engine-service')!.id]);
    expect(cf.app('projectman-cloud')).toMatchObject({
      type: 'self_hosted',
      domain: 'board.example.com',
      app_launcher_visible: false,
      session_duration: '24h',
      auto_redirect_to_identity: true,
      allowed_idps: [cf.idps[0]!.id],
    });
    expect(cf.app('projectman-cloud-engine')).toMatchObject({ domain: 'board.example.com/engine' });
    const engine = cf.policy('projectman-cloud-engine-service')!;
    expect(engine.decision).toBe('non_identity');
    expect(engine.include).toEqual([
      { service_token: { token_id: cf.token('projectman-cloud-engine')!.id } },
    ]);
  });

  it('puts an application right whose policy list was changed by hand', async () => {
    const { cf } = world;
    cf.app('projectman-cloud-engine')!.policies = [
      ...(cf.app('projectman-cloud-engine')!.policies as object[]),
      { id: cf.policy('projectman-cloud-allow-emails')!.id, precedence: 2 },
    ];
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect((cf.app('projectman-cloud-engine')!.policies as unknown[]).length).toBe(1);
    expect(world.output).toContain('updated access-app projectman-cloud-engine');
  });

  it('refuses when two policies share a name', async () => {
    world.cf.policies.push({ ...world.cf.policy('projectman-cloud-allow-emails')!, id: 'dup' });
    expect(await edge()).toBe(2);
    expect(world.output).toContain('2 Access policys named projectman-cloud-allow-emails');
  });
});

describe('the tunnel', () => {
  it('sets exactly the ingress of the board, without a Host rewrite', async () => {
    expect(await edge()).toBe(0);
    const { cf } = world;
    const tunnel = cf.tunnels[0]!;
    const config = cf.configs.get(tunnel.id)!;
    const stripped = (config.ingress as Record<string, unknown>[]).map((rule) => {
      const { originRequest, ...rest } = rule;
      return originRequest && Object.keys(originRequest as object).length > 0
        ? { ...rest, originRequest }
        : rest;
    });
    expect(stripped).toEqual([
      { hostname: 'board.example.com', path: '^/hooks', service: 'http_status:404' },
      { hostname: 'board.example.com', path: '^/mcp', service: 'http_status:404' },
      {
        hostname: 'board.example.com',
        service: 'http://127.0.0.1:4700',
        originRequest: {
          access: {
            required: true,
            teamName: 'janoist1',
            audTag: [cf.app('projectman-cloud')!.aud, cf.app('projectman-cloud-engine')!.aud],
          },
        },
      },
      { service: 'http_status:404' },
    ]);
    expect(JSON.stringify(config)).not.toContain('httpHostHeader');
  });

  it('adds the feedback hostname rules first, and the public address to cloud.env', async () => {
    world.writeConfig({ cloudflare: FEEDBACK });
    expect(await edge()).toBe(0);
    const ingress = world.cf.configs.get(world.cf.tunnels[0]!.id)!.ingress as {
      hostname?: string;
      path?: string;
      service: string;
    }[];
    expect(ingress.slice(0, 2).map(({ hostname, path, service }) => ({ hostname, path, service }))).toEqual([
      { hostname: 'mark.example.com', path: '^/feedback/', service: 'http://127.0.0.1:4700' },
      { hostname: 'mark.example.com', path: undefined, service: 'http_status:404' },
    ]);
    expect(ingress).toHaveLength(6);
    expect(readFileSync(world.envFile, 'utf8')).toContain(
      'PROJECTMAN_FEEDBACK_PUBLIC_URL=https://mark.example.com',
    );
  });

  it('takes the feedback address out of cloud.env when the hostname is dropped, and keeps other lines', async () => {
    world.writeConfig({ cloudflare: FEEDBACK });
    expect(await edge()).toBe(0);
    world.writeConfig();
    expect(await edge()).toBe(0);
    const env = readFileSync(world.envFile, 'utf8');
    expect(env).not.toContain('PROJECTMAN_FEEDBACK_PUBLIC_URL');
    expect(env).toContain('LITESTREAM_BUCKET=acme-projectman-db');
    expect((statSync(world.envFile).mode & 0o777).toString(8)).toBe('600');
  });

  it('repairs an ingress that was changed by hand', async () => {
    expect(await edge()).toBe(0);
    const tunnel = world.cf.tunnels[0]!;
    world.cf.configs.set(tunnel.id, { ingress: [{ service: 'http://127.0.0.1:4700' }] });
    world.lines.length = 0;
    expect(await edge()).toBe(0);
    expect(world.output).toContain('updated tunnel-config');
    expect((world.cf.configs.get(tunnel.id)!.ingress as unknown[]).length).toBe(4);
  });

  it('refuses a tunnel that is configured from a file', async () => {
    world.cf.tunnels.push({
      id: 'tun-local',
      name: 'projectman-cloud',
      config_src: 'local',
      status: 'inactive',
    });
    expect(await edge()).toBe(2);
    expect(world.output).toContain('configured from a local file');
  });
});

describe('the edge settings', () => {
  it('writes a setting back that was changed in the dashboard, and nothing else', async () => {
    expect(await edge()).toBe(0);
    const zone = world.cf.zones[0]!;
    world.cf.zoneSettings(zone.id).rocket_loader = 'on';
    world.cf.calls.length = 0;
    expect(await edge()).toBe(0);
    expect(world.cf.mutations().map((call) => `${call.method} ${call.path}`)).toEqual([
      `PATCH /zones/${zone.id}/settings/rocket_loader`,
    ]);
    expect(world.cf.zoneSettings(zone.id).rocket_loader).toBe('off');
  });

  it('keeps a rule with another ref and replaces only its own', async () => {
    const zone = world.cf.addZone('example.com');
    world.cf.rulesets.set(`${zone.id}/http_response_headers_transform`, [
      { id: 'other', ref: 'someone_else', enabled: true, expression: 'true', action: 'rewrite' },
      { id: 'mine', ref: 'projectman_frame_headers', enabled: false, expression: 'false', action: 'rewrite' },
    ]);
    expect(await edge()).toBe(0);
    const rules = world.cf.rulesets.get(`${zone.id}/http_response_headers_transform`)!;
    expect(rules.map((rule) => rule.ref)).toEqual(['someone_else', 'projectman_frame_headers']);
    expect(rules[1]).toMatchObject({
      enabled: true,
      expression: '(http.host eq "board.example.com")',
      action: 'rewrite',
      action_parameters: {
        headers: {
          'X-Frame-Options': { operation: 'set', value: 'DENY' },
          'Content-Security-Policy': { operation: 'add', value: "frame-ancestors 'none'" },
        },
      },
    });
    const put = world.cf.mutationsTo('PUT', /rulesets/)[0]!;
    expect(JSON.stringify(put.body)).not.toContain('last_updated');
  });
});

describe('the service tokens', () => {
  it('puts the secret only into a 600 file, never into the output', async () => {
    expect(await edge()).toBe(0);
    const file = world.tokenPath('engine-access-token.json');
    expect((statSync(file).mode & 0o777).toString(8)).toBe('600');
    const { id, secret } = tokenFile('engine-access-token.json');
    expect(id).toBe(world.cf.token('projectman-cloud-engine')!.client_id);
    expect(secret).toBe(world.cf.secrets.get(world.cf.token('projectman-cloud-engine')!.id));
    expect(world.output).not.toContain(secret);
    expect(world.output).toMatch(
      /created service-token-engine: projectman-cloud-engine, expires 2027-10-12 \(in 365 days\)/,
    );
    expect(readFileSync(file, 'utf8')).toBe(
      `${JSON.stringify({ 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret }, null, 2)}\n`,
    );
  });

  it('never sends the Cloudflare API token anywhere but the Authorization header', async () => {
    expect(await edge()).toBe(0);
    expect(world.output).not.toContain('cf-api-token-value');
    expect(new Set(world.cf.calls.map((call) => call.authorization))).toEqual(
      new Set(['Bearer cf-api-token-value-0123456789']),
    );
    expect(
      world.cf.calls.some((call) => JSON.stringify(call.body ?? {}).includes('cf-api-token-value')),
    ).toBe(false);
  });

  it('refuses when the token exists but its file does not, and changes nothing more', async () => {
    expect(await edge()).toBe(0);
    const { rmSync } = await import('node:fs');
    rmSync(world.tokenPath('engine-access-token.json'));
    world.cf.calls.length = 0;
    expect(await edge()).toBe(2);
    expect(world.output).toContain('--rotate-engine-token');
    expect(world.cf.mutations()).toEqual([]);
  });

  it('rotates the secret with --rotate-engine-token and writes the new file', async () => {
    expect(await edge()).toBe(0);
    const before = tokenFile('engine-access-token.json');
    world.lines.length = 0;
    expect(await edge('--rotate-engine-token')).toBe(0);
    const after = tokenFile('engine-access-token.json');
    expect(after.id).toBe(before.id);
    expect(after.secret).not.toBe(before.secret);
    expect(world.output).not.toContain(after.secret);
    expect(world.output).toContain('updated service-token-engine: projectman-cloud-engine rotated');
  });

  it('refuses a file whose mode is too wide before it creates anything', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(world.tokenPath('engine-access-token.json'), '{}', { mode: 0o644 });
    expect(await edge()).toBe(2);
    expect(world.output).toContain('must be 600');
    expect(world.cf.mutations()).toEqual([]);
  });

  it('adds the integrator token and policy to the main application, and removes them when it is switched off', async () => {
    world.writeConfig({ access: { emails: ['owner@example.com'], integratorServiceToken: true } });
    expect(await edge()).toBe(0);
    const { cf } = world;
    expect(cf.tokens.map((token) => token.name).sort()).toEqual([
      'projectman-cloud-engine',
      'projectman-cloud-integrator',
    ]);
    expect((cf.app('projectman-cloud')!.policies as { id: string }[]).map((policy) => policy.id)).toEqual([
      cf.policy('projectman-cloud-allow-emails')!.id,
      cf.policy('projectman-cloud-integrator-service')!.id,
    ]);
    expect(
      (cf.app('projectman-cloud-engine')!.policies as { id: string }[]).map((policy) => policy.id),
    ).toEqual([cf.policy('projectman-cloud-engine-service')!.id]);
    expect(existsSync(world.tokenPath('integrator-access-token.json'))).toBe(true);

    world.writeConfig({ access: { emails: ['owner@example.com'] } });
    expect(await edge()).toBe(0);
    expect(cf.tokens.map((token) => token.name)).toEqual(['projectman-cloud-engine']);
    expect(cf.policy('projectman-cloud-integrator-service')).toBeUndefined();
    expect(existsSync(world.tokenPath('integrator-access-token.json'))).toBe(false);
    expect((cf.app('projectman-cloud')!.policies as unknown[]).length).toBe(1);
  });
});

describe('what edge refuses', () => {
  it('exits 2 and names the manual step when Zero Trust is not turned on', async () => {
    world.cf.organization = null;
    expect(await edge()).toBe(2);
    expect(world.output).toContain('no Zero Trust organization');
    expect(world.cf.mutations()).toEqual([]);
  });

  it('exits 2 and names the right when the token may not edit Access applications', async () => {
    world.cf.denied = [/\/access\/apps/];
    expect(await edge()).toBe(2);
    expect(world.output).toContain('Account / Access: Apps and Policies / Edit');
  });

  it('exits 2 when the token file is missing', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(world.tokenPath('cloudflare-token'));
    expect(await edge()).toBe(2);
    expect(world.output).toContain('cloudflare-token does not exist');
  });

  it('exits 2 when the token sees several accounts and none is chosen', async () => {
    world.cf.accounts.push({ id: 'b'.repeat(32), name: 'Other' });
    expect(await edge()).toBe(2);
    expect(world.output).toContain('set cloudflare.accountId');
  });
});
