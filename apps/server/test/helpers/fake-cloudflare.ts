import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { CloudDeps } from '../../../../scripts/cloud/deps';
import { Ec2HostWorld } from './fake-ec2-host';

/**
 * A stateful fake of the Cloudflare API (PM-536): zones, zone settings, rulesets, identity providers, service
 * tokens, Access policies and applications, tunnels, their configurations and DNS records. It answers the calls
 * the way the real API does where the commands depend on it (the secret of a service token only on creation, a
 * policy that an application still uses cannot be deleted, a tunnel configuration comes back with an empty
 * `originRequest`, an application's policies come back as objects) and logs every call, so a test can assert that
 * a second run changes nothing and that a dry run only reads.
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface CfCall {
  method: string;
  path: string;
  query: Record<string, string>;
  body: Obj | undefined;
  authorization: string | null;
}

interface Zone {
  id: string;
  name: string;
  status: string;
  name_servers: string[];
}

const DEFAULT_SETTINGS: Record<string, unknown> = {
  always_use_https: 'off',
  min_tls_version: '1.0',
  automatic_https_rewrites: 'on',
  rocket_loader: 'on',
  email_obfuscation: 'on',
  server_side_exclude: 'on',
  ssl: 'full',
  security_header: {
    strict_transport_security: {
      enabled: false,
      max_age: 0,
      include_subdomains: false,
      preload: false,
      nosniff: false,
    },
  },
};

export const CF_TOKEN = 'cf-api-token-value-0123456789';
export const CF_ACCOUNT = 'a'.repeat(32);

export class FakeCloudflare {
  readonly calls: CfCall[] = [];
  expectedToken = CF_TOKEN;
  tokenStatus = 'active';
  accounts: { id: string; name: string }[] = [{ id: CF_ACCOUNT, name: 'Owner account' }];
  organization: { auth_domain: string } | null = { auth_domain: 'janoist1.cloudflareaccess.com' };
  zones: Zone[] = [];
  settings = new Map<string, Record<string, unknown>>();
  rulesets = new Map<string, Obj[]>();
  idps: Obj[] = [];
  tokens: Obj[] = [];
  policies: Obj[] = [];
  apps: Obj[] = [];
  tunnels: Obj[] = [];
  configs = new Map<string, Obj>();
  records: Obj[] = [];
  /** Request paths (regular expressions) answered 403 "no permission". */
  denied: RegExp[] = [];
  /** The secrets of the service tokens, by token id (what only the creation call shows). */
  readonly secrets = new Map<string, string>();
  tunnelStatus = 'healthy';

  private counter = 0;

  id(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${String(this.counter).padStart(4, '0')}`;
  }

  /** The calls that change something. */
  mutations(): CfCall[] {
    return this.calls.filter((call) => call.method !== 'GET');
  }

  mutationsTo(method: string, pattern: RegExp): CfCall[] {
    return this.mutations().filter((call) => call.method === method && pattern.test(call.path));
  }

  addZone(name: string, status = 'active'): Zone {
    const zone = {
      id: this.id('zone'),
      name,
      status,
      name_servers: ['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com'],
    };
    this.zones.push(zone);
    return zone;
  }

  zoneSettings(zoneId: string): Record<string, unknown> {
    let settings = this.settings.get(zoneId);
    if (!settings) {
      settings = structuredClone(DEFAULT_SETTINGS);
      this.settings.set(zoneId, settings);
    }
    return settings;
  }

  app(name: string): Obj | undefined {
    return this.apps.find((app) => app.name === name);
  }

  policy(name: string): Obj | undefined {
    return this.policies.find((policy) => policy.name === name);
  }

  token(name: string): Obj | undefined {
    return this.tokens.find((token) => token.name === name);
  }

  tunnel(name: string): Obj | undefined {
    return this.tunnels.find((tunnel) => tunnel.name === name);
  }

  fetch = async (input: URL | string | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const query = Object.fromEntries(url.searchParams.entries());
    const route = url.pathname.replace(/^\/client\/v4/, '');
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Obj) : undefined;
    this.calls.push({ method, path: route, query, body, authorization: headers.get('authorization') });
    if (headers.get('authorization') !== `Bearer ${this.expectedToken}`)
      return this.fail(401, 9109, 'Invalid access token');
    if (this.denied.some((pattern) => pattern.test(route)))
      return this.fail(403, 10000, 'Authentication error');
    return this.handle(method, route, query, body);
  };

  private ok(
    result: unknown,
    info?: { page: number; per_page: number; total_pages: number; total_count: number },
  ) {
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result,
        ...(info ? { result_info: info } : {}),
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  private fail(status: number, code: number, message: string) {
    return new Response(
      JSON.stringify({ success: false, errors: [{ code, message }], messages: [], result: null }),
      {
        status,
        headers: { 'content-type': 'application/json' },
      },
    );
  }

  private list(items: Obj[], query: Record<string, string>): Response {
    const perPage = Number(query.per_page ?? 20);
    const page = Number(query.page ?? 1);
    const pages = Math.max(1, Math.ceil(items.length / perPage));
    return this.ok(items.slice((page - 1) * perPage, page * perPage), {
      page,
      per_page: perPage,
      total_pages: pages,
      total_count: items.length,
    });
  }

  private handle(
    method: string,
    route: string,
    query: Record<string, string>,
    body: Obj | undefined,
  ): Response {
    const match = (pattern: RegExp) => pattern.exec(route);
    let m: RegExpExecArray | null;

    if (method === 'GET' && route === '/user/tokens/verify')
      return this.ok({ id: 'tok', status: this.tokenStatus });
    if (method === 'GET' && route === '/accounts') return this.list(this.accounts, query);

    if ((m = match(/^\/accounts\/([^/]+)\/access\/organizations$/)) && method === 'GET')
      return this.organization
        ? this.ok(this.organization)
        : this.fail(404, 12130, 'access.api.error.not_enabled: Access is not enabled for this account');

    // zones
    if ((m = match(/^\/zones\/([^/]+)$/)) && method === 'GET') {
      const zone = this.zones.find((zone) => zone.id === m![1]);
      return zone ? this.ok(zone) : this.fail(404, 7003, 'zone not found');
    }
    if (match(/^\/zones\/([^/]+)\/activation_check$/) && method === 'PUT') return this.ok({});
    if (route === '/zones' && method === 'GET') {
      const wanted = query.name;
      return this.list(
        this.zones.filter((zone) => !wanted || zone.name === wanted),
        query,
      );
    }
    if (route === '/zones' && method === 'POST') {
      const zone = this.addZone(String(body?.name), 'pending');
      return this.ok(zone);
    }
    if ((m = match(/^\/zones\/([^/]+)\/settings$/)) && method === 'GET')
      return this.ok(
        Object.entries(this.zoneSettings(m[1]!)).map(([id, value]) => ({ id, value, editable: true })),
      );
    if ((m = match(/^\/zones\/([^/]+)\/settings\/([^/]+)$/)) && method === 'PATCH') {
      this.zoneSettings(m[1]!)[m[2]!] = body?.value;
      return this.ok({ id: m[2], value: body?.value, editable: true });
    }
    if ((m = match(/^\/zones\/([^/]+)\/rulesets\/phases\/([^/]+)\/entrypoint$/))) {
      const key = `${m[1]}/${m[2]}`;
      if (method === 'GET') {
        const rules = this.rulesets.get(key);
        return rules
          ? this.ok({ id: `rs-${key}`, rules })
          : this.fail(404, 10003, 'could not find entrypoint ruleset');
      }
      if (method === 'PUT') {
        const rules = ((body?.rules ?? []) as Obj[]).map((rule) => ({
          id: rule.id ?? this.id('rule'),
          version: '1',
          last_updated: '2026-10-12T12:00:00Z',
          ...rule,
        }));
        this.rulesets.set(key, rules);
        return this.ok({ id: `rs-${key}`, rules });
      }
    }
    if ((m = match(/^\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/))) {
      if (method === 'GET')
        return this.list(
          this.records.filter(
            (record) => record.zone_id === m![1] && (!query.name || record.name === query.name),
          ),
          query,
        );
      if (method === 'POST') {
        const record = { id: this.id('rec'), zone_id: m[1], ...body };
        this.records.push(record);
        return this.ok(record);
      }
      if (method === 'PATCH') {
        const record = this.records.find((item) => item.id === m![2]);
        if (!record) return this.fail(404, 81044, 'record not found');
        Object.assign(record, body);
        return this.ok(record);
      }
    }

    // Access
    if ((m = match(/^\/accounts\/([^/]+)\/access\/identity_providers$/))) {
      if (method === 'GET') return this.list(this.idps, query);
      if (method === 'POST') {
        const idp = { id: this.id('idp'), ...body };
        this.idps.push(idp);
        return this.ok(idp);
      }
    }
    if ((m = match(/^\/accounts\/([^/]+)\/access\/service_tokens(?:\/([^/]+)(\/rotate)?)?$/))) {
      if (method === 'GET' && !m[2])
        return this.list(
          this.tokens.map(({ client_secret: _secret, ...rest }) => rest),
          query,
        );
      if (method === 'POST' && !m[2]) {
        const id = this.id('stok');
        const token = {
          id,
          name: body?.name,
          client_id: `${id}.access`,
          client_secret: `secret-of-${id}-0123456789abcdef`,
          duration: body?.duration,
          expires_at: '2027-10-12T12:00:00Z',
        };
        this.tokens.push(token);
        this.secrets.set(id, token.client_secret);
        return this.ok(token);
      }
      if (method === 'POST' && m[3]) {
        const token = this.tokens.find((item) => item.id === m![2]);
        if (!token) return this.fail(404, 1001, 'token not found');
        token.client_secret = `rotated-secret-of-${token.id}-${this.id('r')}-0123456789`;
        this.secrets.set(token.id, token.client_secret);
        return this.ok(token);
      }
      if (method === 'DELETE' && m[2]) {
        this.tokens = this.tokens.filter((item) => item.id !== m![2]);
        return this.ok({ id: m[2] });
      }
    }
    if ((m = match(/^\/accounts\/([^/]+)\/access\/policies(?:\/([^/]+))?$/))) {
      if (method === 'GET' && !m[2]) return this.list(this.policies, query);
      if (method === 'POST' && !m[2]) {
        const policy = { id: this.id('pol'), ...body };
        this.policies.push(policy);
        return this.ok(policy);
      }
      if (method === 'PUT' && m[2]) {
        const index = this.policies.findIndex((item) => item.id === m![2]);
        if (index === -1) return this.fail(404, 12101, 'policy not found');
        this.policies[index] = { id: m[2], ...body };
        return this.ok(this.policies[index]);
      }
      if (method === 'DELETE' && m[2]) {
        const id = m[2];
        if (this.apps.some((app) => (app.policies as Obj[]).some((policy) => policy.id === id)))
          return this.fail(400, 12130, 'policy is still used by an application');
        this.policies = this.policies.filter((item) => item.id !== id);
        return this.ok({ id });
      }
    }
    if ((m = match(/^\/accounts\/([^/]+)\/access\/apps(?:\/([^/]+))?$/))) {
      if (method === 'GET' && !m[2]) return this.list(this.apps, query);
      if (method === 'POST' || method === 'PUT') {
        const existing = m[2] ? this.apps.find((item) => item.id === m![2]) : undefined;
        if (m[2] && !existing) return this.fail(404, 12101, 'application not found');
        const policies = ((body?.policies ?? []) as Obj[]).map((reference) => {
          const policy = this.policies.find((item) => item.id === reference.id);
          return { ...policy, ...reference };
        });
        const app = {
          ...body,
          id: existing?.id ?? this.id('app'),
          aud: existing?.aud ?? `aud-${this.id('x')}`,
          policies,
        };
        if (existing) this.apps[this.apps.indexOf(existing)] = app;
        else this.apps.push(app);
        return this.ok(app);
      }
    }

    // tunnels
    if ((m = match(/^\/accounts\/([^/]+)\/cfd_tunnel(?:\/([^/]+)(\/token|\/configurations)?)?$/))) {
      if (method === 'GET' && !m[2])
        return this.list(
          this.tunnels.filter((tunnel) => !query.name || tunnel.name === query.name),
          query,
        );
      if (method === 'POST' && !m[2]) {
        const tunnel = {
          id: this.id('tun'),
          name: body?.name,
          config_src: body?.config_src ?? 'local',
          status: 'inactive',
        };
        this.tunnels.push(tunnel);
        return this.ok(tunnel);
      }
      if (method === 'GET' && m[3] === '/token') return this.ok(`tunnel-token-of-${m[2]}-0123456789abcdef`);
      if (m[3] === '/configurations') {
        if (method === 'GET') return this.ok({ tunnel_id: m[2], config: this.configs.get(m[2]!) ?? null });
        if (method === 'PUT') {
          const ingress = ((body?.config?.ingress ?? []) as Obj[]).map((rule) => ({
            originRequest: {},
            ...rule,
          }));
          this.configs.set(m[2]!, { ingress });
          return this.ok({ tunnel_id: m[2], config: this.configs.get(m[2]!) });
        }
      }
    }

    return this.fail(404, 7003, `no route: ${method} ${route}`);
  }
}

/** A world with a machine behind the fake ssh and a Cloudflare behind `api.cloudflare.com`. */
export class CloudflareWorld extends Ec2HostWorld {
  readonly cf = new FakeCloudflare();
  /** What the public hostnames answer (the three engine doors, the check's own requests). */
  doors: (url: URL, init: RequestInit) => Response | Promise<Response> = () =>
    new Response('', { status: 403 });
  readonly doorCalls: { url: string; headers: Headers; redirect: string | undefined }[] = [];
  /** What the fake `bash` answers for `check.sh` and `smoke.sh`. */
  scripts = new Map<string, { code: number; stdout: string; stderr: string }>();
  readonly scriptCalls: { script: string; args: string[]; env: Record<string, string> | undefined }[] = [];

  /** The token file of the Cloudflare API token (mode 600 unless a test says otherwise). */
  writeToken(content = CF_TOKEN, mode = 0o600): string {
    mkdirSync(this.secretsDir, { recursive: true, mode: 0o700 });
    const file = path.join(this.secretsDir, 'cloudflare-token');
    writeFileSync(file, `${content}\n`, { mode });
    return file;
  }

  tokenPath(name: string): string {
    return path.join(this.secretsDir, name);
  }

  override deps(overrides: Partial<CloudDeps> = {}): CloudDeps {
    return super.deps({
      fetch: (async (input: URL | string | Request, init: RequestInit = {}) => {
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        );
        if (url.hostname === 'api.cloudflare.com') return this.cf.fetch(input, init);
        this.doorCalls.push({
          url: url.href,
          headers: new Headers(init.headers),
          redirect: init.redirect,
        });
        return this.doors(url, init);
      }) as typeof fetch,
      run: async (command, args, options = {}) => {
        if (command === 'bash') {
          const script = path.basename(args[0] ?? '');
          this.scriptCalls.push({ script, args, env: options.env });
          return this.scripts.get(script) ?? { code: 0, stdout: 'ok    fake script\n', stderr: '' };
        }
        return super.deps().run(command, args, options);
      },
      ...overrides,
    });
  }
}
