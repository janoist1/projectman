import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CloudConfig } from './config';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { CloudflareApi, CloudflareError, readCloudflareToken, sameJson, type Json } from './cloudflare-api';
import type { StepResult } from './report';
import {
  checkSecretsDir,
  readEnvFile,
  readSecret,
  removeEnvNames,
  secretFileProblem,
  updateEnvFile,
  writeSecret,
} from './secrets';

/**
 * The Cloudflare side of the cloud board (PM-536, docs/AWS.md "Cloudflare"): the `preflight` part and the `edge`
 * command. Everything is found by name and put right when it differs, so a second run changes nothing; a setting
 * changed by hand in the dashboard is written back. The security conditions are those of docs/DEPLOY.md (PM-200):
 * Access in front of the board with the exact e-mail list, the engine's door open only to the engine service token,
 * the internal paths answered 404 by the tunnel, no Host rewrite, no framing.
 */

// ---- the rights of the token, named as the dashboard names them ----

const RIGHT_TUNNEL = 'Account / Cloudflare Tunnel / Edit';
const RIGHT_APPS = 'Account / Access: Apps and Policies / Edit';
const RIGHT_TOKENS = 'Account / Access: Service Tokens / Edit';
const RIGHT_IDPS = 'Account / Access: Organizations, Identity Providers, and Groups / Edit';
const RIGHT_ZONE = 'Zone / Zone / Edit (all zones from the account)';
const RIGHT_DNS = 'Zone / DNS / Edit';
const RIGHT_SETTINGS = 'Zone / Zone Settings / Edit';
const RIGHT_TRANSFORM = 'Zone / Transform Rules / Edit';

/** Runs a call; a refusal for lack of a right becomes an exit-2 message that names the right. */
export async function withRight<T>(right: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CloudflareError && error.isPermission)
      throw refused(`the API token lacks the right "${right}" (${error.message})`);
    throw error;
  }
}

// ---- the shapes of the answers ----

const accountSchema = z.looseObject({ id: z.string(), name: z.string().optional() });
const organizationSchema = z.looseObject({ auth_domain: z.string() });
const zoneSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  name_servers: z.array(z.string()).optional(),
});
const settingSchema = z.looseObject({ id: z.string(), value: z.unknown() });
const rulesetSchema = z.looseObject({
  id: z.string().optional(),
  rules: z.array(z.looseObject({})).nullish(),
});
const idpSchema = z.looseObject({ id: z.string(), type: z.string() });
const serviceTokenSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  client_id: z.string().optional(),
  client_secret: z.string().optional(),
  expires_at: z.string().nullish(),
});
const policySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  decision: z.string().optional(),
  include: z.array(z.unknown()).nullish(),
  exclude: z.array(z.unknown()).nullish(),
  require: z.array(z.unknown()).nullish(),
});
const appSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  domain: z.string().optional(),
  aud: z.string().optional(),
  app_launcher_visible: z.boolean().optional(),
  session_duration: z.string().optional(),
  allowed_idps: z.array(z.string()).nullish(),
  auto_redirect_to_identity: z.boolean().optional(),
  policies: z.array(z.union([z.string(), z.looseObject({ id: z.string() })])).nullish(),
});
const tunnelSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  status: z.string().optional(),
  config_src: z.string().optional(),
});
const tunnelConfigSchema = z.looseObject({
  config: z.looseObject({ ingress: z.array(z.looseObject({})).nullish() }).nullish(),
});
export const recordSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string(),
  proxied: z.boolean().optional(),
});
const verifySchema = z.looseObject({ status: z.string().optional() });

export type Zone = z.output<typeof zoneSchema>;
export type AccessApp = z.output<typeof appSchema>;
export type AccessPolicy = z.output<typeof policySchema>;
export type ServiceToken = z.output<typeof serviceTokenSchema>;
export type Tunnel = z.output<typeof tunnelSchema>;
export type DnsRecord = z.output<typeof recordSchema>;

export function shape<S extends z.ZodType>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new CloudError(`Cloudflare answered an unexpected ${what}`);
  return result.data;
}

// ---- the names of everything this makes ----

export interface Names {
  app: string;
  engineApp: string;
  engineToken: string;
  integratorToken: string;
  allowPolicy: string;
  publicPolicy: string;
  enginePolicy: string;
  integratorPolicy: string;
  tunnel: string;
}

export function namesOf(config: CloudConfig): Names {
  const n = config.cloudflare.tunnelName;
  return {
    app: n,
    engineApp: `${n}-engine`,
    engineToken: `${n}-engine`,
    integratorToken: `${n}-integrator`,
    allowPolicy: `${n}-allow-emails`,
    publicPolicy: `${n}-public-board`,
    enginePolicy: `${n}-engine-service`,
    integratorPolicy: `${n}-integrator-service`,
    tunnel: n,
  };
}

export const ENGINE_TOKEN_FILE = 'engine-access-token.json';
export const INTEGRATOR_TOKEN_FILE = 'integrator-access-token.json';
export const TRANSFORM_PHASE = 'http_response_headers_transform';
const TRANSFORM_REF = 'projectman_frame_headers';
const AUTH_DOMAIN_SUFFIX = '.cloudflareaccess.com';
/** The server's switch for the public board (PM-672); `cloud.env` holds it only in public mode. */
export const PUBLIC_BOARD_ENV = 'PROJECTMAN_PUBLIC_BOARD';
const TOKEN_DURATION = '8760h';
export const TOKEN_WARNING_DAYS = 30;
const DAY_MS = 86_400_000;

// ---- lookups shared by the commands ----

export interface Account {
  id: string;
  name: string | undefined;
}

export function cloudflareApi(context: CloudContext, readOnly: boolean): CloudflareApi {
  return CloudflareApi.fromTokenFile(context, context.config.cloudflare.tokenFile, readOnly);
}

/** The account the token works in: the configured one, or the only one the token can see. */
export async function resolveAccount(api: CloudflareApi, config: CloudConfig): Promise<Account> {
  const accounts = (await api.list('/accounts')).map((item) => shape(accountSchema, item, 'account'));
  const wanted = config.cloudflare.accountId;
  if (wanted) {
    const found = accounts.find((account) => account.id.toLowerCase() === wanted.toLowerCase());
    if (!found) throw refused(`the API token cannot see the account ${wanted} (cloudflare.accountId)`);
    return { id: found.id, name: found.name };
  }
  if (accounts.length === 0) throw refused('the API token sees no account');
  if (accounts.length > 1)
    throw refused(
      `the API token sees ${accounts.length} accounts (${accounts.map((account) => account.name ?? account.id).join(', ')}); set cloudflare.accountId`,
    );
  return { id: accounts[0]!.id, name: accounts[0]!.name };
}

const MANUAL_ZERO_TRUST =
  'turn Zero Trust on in the dashboard (Zero Trust, Free plan, choose a team name); see docs/AWS.md';

/** The Zero Trust team name (the `auth_domain` without `.cloudflareaccess.com`); refuses when there is none. */
export async function teamNameOf(api: CloudflareApi, accountId: string): Promise<string> {
  let value: unknown;
  try {
    value = await api.get(`/accounts/${accountId}/access/organizations`);
  } catch (error) {
    if (error instanceof CloudflareError) {
      const notEnabled =
        error.status === 404 || error.messages.some((text) => /not_enabled|not enabled/i.test(text));
      if (notEnabled) throw refused(`this account has no Zero Trust organization: ${MANUAL_ZERO_TRUST}`);
      if (error.isPermission)
        throw refused(`the API token lacks the right "${RIGHT_IDPS}" (${error.message})`);
    }
    throw error;
  }
  if (value === null) throw refused(`this account has no Zero Trust organization: ${MANUAL_ZERO_TRUST}`);
  const domain = shape(organizationSchema, value, 'Zero Trust organization').auth_domain.toLowerCase();
  if (!domain.endsWith(AUTH_DOMAIN_SUFFIX))
    throw refused(`the Zero Trust auth domain is not <team>${AUTH_DOMAIN_SUFFIX}`);
  return domain.slice(0, -AUTH_DOMAIN_SUFFIX.length);
}

export async function findZone(
  api: CloudflareApi,
  config: CloudConfig,
  accountId: string,
): Promise<Zone | null> {
  const zones = (await api.list('/zones', { name: config.cloudflare.zone, 'account.id': accountId }))
    .map((item) => shape(zoneSchema, item, 'zone'))
    .filter((zone) => zone.name.toLowerCase() === config.cloudflare.zone);
  if (zones.length > 1)
    throw refused(`the account has ${zones.length} zones named ${config.cloudflare.zone}`);
  return zones[0] ?? null;
}

async function listNamed<S extends z.ZodType<{ name: string }>>(
  api: CloudflareApi,
  apiPath: string,
  schema: S,
  what: string,
  name: string,
  query: Record<string, string | number | boolean> = {},
): Promise<z.output<S> | null> {
  const found = (await api.list(apiPath, query))
    .map((item) => shape(schema, item, what))
    .filter((item) => item.name === name);
  if (found.length > 1)
    throw refused(`there are ${found.length} ${what}s named ${name}; delete the extra ones`);
  return found[0] ?? null;
}

export function findPolicy(
  api: CloudflareApi,
  accountId: string,
  name: string,
): Promise<AccessPolicy | null> {
  return listNamed(api, `/accounts/${accountId}/access/policies`, policySchema, 'Access policy', name);
}

export function findApp(api: CloudflareApi, accountId: string, name: string): Promise<AccessApp | null> {
  return listNamed(api, `/accounts/${accountId}/access/apps`, appSchema, 'Access application', name);
}

export function findServiceToken(
  api: CloudflareApi,
  accountId: string,
  name: string,
): Promise<ServiceToken | null> {
  return listNamed(
    api,
    `/accounts/${accountId}/access/service_tokens`,
    serviceTokenSchema,
    'service token',
    name,
  );
}

export function findTunnel(api: CloudflareApi, accountId: string, name: string): Promise<Tunnel | null> {
  return listNamed(api, `/accounts/${accountId}/cfd_tunnel`, tunnelSchema, 'tunnel', name, {
    name,
    is_deleted: false,
  });
}

/** What an Access policy has to be, per name (the exact lists; no group, no domain; `everyone` only in the one bypass policy of the public board, PM-672). */
export interface PolicySpec {
  name: string;
  decision: 'allow' | 'non_identity' | 'bypass';
  include: Json[];
}

/** Public board (PM-672): the main application lets everybody through to the board's own login. */
export function publicPolicySpec(names: Names): PolicySpec {
  return { name: names.publicPolicy, decision: 'bypass', include: [{ everyone: {} }] };
}

export function isPublicBoard(config: CloudConfig): boolean {
  return config.access.boardMode === 'public';
}

export function allowPolicySpec(config: CloudConfig, names: Names): PolicySpec {
  return {
    name: names.allowPolicy,
    decision: 'allow',
    include: config.access.emails.map((email) => ({ email: { email } })),
  };
}

export function servicePolicySpec(name: string, tokenId: string): PolicySpec {
  return { name, decision: 'non_identity', include: [{ service_token: { token_id: tokenId } }] };
}

function policyBody(spec: PolicySpec): Json {
  return { name: spec.name, decision: spec.decision, include: spec.include, exclude: [], require: [] };
}

function policyMatches(policy: AccessPolicy, spec: PolicySpec): boolean {
  return (
    policy.decision === spec.decision &&
    sameSet(policy.include ?? [], spec.include) &&
    (policy.exclude ?? []).length === 0 &&
    (policy.require ?? []).length === 0
  );
}

function sameSet(left: readonly unknown[], right: readonly unknown[]): boolean {
  const key = (value: unknown) => JSON.stringify(sortKeys(value));
  const a = left.map(key).sort();
  const b = right.map(key).sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  return value;
}

/** The ids of the policies of an app, in precedence order. */
export function appPolicyIds(app: AccessApp): string[] {
  return (app.policies ?? []).map((policy) => (typeof policy === 'string' ? policy : policy.id));
}

const ORIGIN = 'http://127.0.0.1:4700';

/**
 * The tunnel's ingress. Private: the whole main hostname demands the Access audience of the main and the engine
 * application (`audTags` = both). Public (PM-672): only `/engine` demands the engine application's audience
 * (`audTags` = the engine one alone); the rest of the hostname reaches the board's own login with no audience
 * requirement. Both: the internal `/hooks` and the member door `/mcp/<token>` answer 404, nothing overrides the
 * Host header. The bare `/mcp` is the integrator's bearer endpoint (PM-760): it takes the same way in as `/api`.
 */
export function ingressRules(config: CloudConfig, teamName: string, audTags: string[]): Json[] {
  const { hostname, feedbackHostname } = config.cloudflare;
  const access = { access: { required: true, teamName, audTag: audTags } };
  return [
    ...(feedbackHostname
      ? [
          { hostname: feedbackHostname, path: '^/feedback/', service: ORIGIN },
          { hostname: feedbackHostname, service: 'http_status:404' },
        ]
      : []),
    { hostname, path: '^/hooks', service: 'http_status:404' },
    // `/mcp/<token>` is the member door; the bare `/mcp` is the integrator's bearer endpoint (PM-760) and goes on.
    { hostname, path: '^/mcp/', service: 'http_status:404' },
    ...(isPublicBoard(config)
      ? [
          { hostname, path: '^/engine(/|$)', service: ORIGIN, originRequest: access },
          { hostname, service: ORIGIN },
        ]
      : [{ hostname, service: ORIGIN, originRequest: access }]),
    { service: 'http_status:404' },
  ];
}

export function frameRule(hostname: string): Record<string, Json> {
  return {
    ref: TRANSFORM_REF,
    description: 'projectman: no framing (PM-532)',
    enabled: true,
    expression: `(http.host eq "${hostname}")`,
    action: 'rewrite',
    action_parameters: {
      headers: {
        'X-Frame-Options': { operation: 'set', value: 'DENY' },
        'Content-Security-Policy': { operation: 'add', value: "frame-ancestors 'none'" },
      },
    },
  };
}

const ZONE_SETTINGS: { id: string; value: Json }[] = [
  { id: 'always_use_https', value: 'on' },
  { id: 'min_tls_version', value: '1.2' },
  { id: 'automatic_https_rewrites', value: 'off' },
  { id: 'rocket_loader', value: 'off' },
  { id: 'email_obfuscation', value: 'off' },
  { id: 'server_side_exclude', value: 'off' },
  {
    id: 'security_header',
    value: {
      strict_transport_security: {
        enabled: true,
        max_age: 15552000,
        include_subdomains: false,
        preload: false,
        nosniff: true,
      },
    },
  },
];

// ---- preflight ----

const HINT_TOKEN = 'create it with the rights listed in docs/AWS.md and save it as the token file';

/** The Cloudflare part of `preflight`: the token, the account, Zero Trust, and one reading probe per right. */
export async function cloudflarePreflight(context: CloudContext): Promise<void> {
  const { config, report } = context;
  let failed = false;
  const check = async (name: string, body: () => Promise<StepResult>): Promise<boolean> => {
    try {
      await report.run(name, body);
      return true;
    } catch (error) {
      if (!(error instanceof CloudError)) throw error;
      failed = true;
      return false;
    }
  };
  const skip = (names: string[], why: string) => {
    for (const name of names) report.step('skipped', name, why);
  };

  const found: { api?: CloudflareApi; account?: Account; zone?: Zone | null } = {};
  const tokenRead = await check('cloudflare-token', async () => {
    const api = CloudflareApi.fromTokenFile(context, config.cloudflare.tokenFile, true);
    const configured = config.cloudflare.accountId;
    let verified: z.output<typeof verifySchema>;
    try {
      verified = shape(verifySchema, await api.get('/user/tokens/verify'), 'token verification');
    } catch (error) {
      if (!(configured && error instanceof CloudflareError && error.status === 401)) throw error;
      // An account-owned token is verified under its account.
      verified = shape(
        verifySchema,
        await api.get(`/accounts/${configured}/tokens/verify`),
        'token verification',
      );
    }
    if (verified.status !== 'active')
      throw refused(`the API token is ${verified.status ?? 'not active'}; ${HINT_TOKEN}`);
    found.api = api;
    return { status: 'ok', detail: 'active' };
  });
  const client = found.api;
  if (!tokenRead || !client) {
    skip(['cloudflare-account', 'cloudflare-zero-trust', 'cloudflare-rights'], 'the token check failed');
    return finish();
  }

  await check('cloudflare-account', async () => {
    found.account = await resolveAccount(client, config);
    return { status: 'ok', detail: found.account.name ?? found.account.id };
  });
  if (!found.account) {
    skip(['cloudflare-zero-trust', 'cloudflare-rights'], 'the account check failed');
    return finish();
  }
  const accountId = found.account.id;

  await check('cloudflare-zero-trust', async () => {
    const team = await teamNameOf(client, accountId);
    return { status: 'ok', detail: `team ${team}` };
  });

  const probe = (name: string, right: string, run: () => Promise<unknown>) =>
    check(name, async () => {
      await withRight(right, run);
      return { status: 'ok', detail: right };
    });
  await probe('cloudflare-tunnel', RIGHT_TUNNEL, () =>
    client.get(`/accounts/${accountId}/cfd_tunnel`, { per_page: 1, is_deleted: false }),
  );
  await probe('cloudflare-access-apps', RIGHT_APPS, () =>
    client.get(`/accounts/${accountId}/access/apps`, { per_page: 1 }),
  );
  await probe('cloudflare-access-policies', RIGHT_APPS, () =>
    client.get(`/accounts/${accountId}/access/policies`, { per_page: 1 }),
  );
  await probe('cloudflare-service-tokens', RIGHT_TOKENS, () =>
    client.get(`/accounts/${accountId}/access/service_tokens`, { per_page: 1 }),
  );
  await probe('cloudflare-identity-providers', RIGHT_IDPS, () =>
    client.get(`/accounts/${accountId}/access/identity_providers`, { per_page: 1 }),
  );
  await probe('cloudflare-zones', RIGHT_ZONE, async () => {
    found.zone = await findZone(client, config, accountId);
  });
  if (found.zone) {
    const zoneId = found.zone.id;
    await probe('cloudflare-dns', RIGHT_DNS, () =>
      client.get(`/zones/${zoneId}/dns_records`, { per_page: 1 }),
    );
    await probe('cloudflare-zone-settings', RIGHT_SETTINGS, () => client.get(`/zones/${zoneId}/settings`));
    await probe('cloudflare-transform-rules', RIGHT_TRANSFORM, () =>
      client.getOrNull(`/zones/${zoneId}/rulesets/phases/${TRANSFORM_PHASE}/entrypoint`),
    );
  } else if (found.zone === null) {
    skip(
      ['cloudflare-dns', 'cloudflare-zone-settings', 'cloudflare-transform-rules'],
      `the zone ${config.cloudflare.zone} does not exist yet (edge creates it)`,
    );
  }
  report.line(
    'note: a reading call proves a right to read only; edge names the right when a change is refused (docs/AWS.md)',
  );
  return finish();

  function finish(): void {
    if (failed) {
      const error = new CloudError('the Cloudflare preflight failed', 2);
      error.reported = true;
      throw error;
    }
  }
}

// ---- edge ----

export interface EdgeOptions {
  dryRun: boolean;
  rotateEngineToken: boolean;
  rotateIntegratorToken: boolean;
}

interface EdgeState {
  context: CloudContext;
  api: CloudflareApi;
  options: EdgeOptions;
  names: Names;
  accountId: string;
  teamName: string;
  zone: Zone | null;
  idpId: string | null;
  tokenIds: { engine: string | null; integrator: string | null };
  policyIds: {
    allow: string | null;
    public: string | null;
    engine: string | null;
    integrator: string | null;
  };
  audTags: { app: string | null; engine: string | null };
}

const dry = (what: string): StepResult => ({ status: 'skipped', detail: `dry-run: would ${what}` });

export async function runEdge(context: CloudContext, options: EdgeOptions): Promise<void> {
  const { config, report } = context;
  // The secrets store is checked before anything is created: a new service token's secret goes to it at once.
  checkSecretsDir(context.secretsDir);
  readEnvFile(context.envFile);
  for (const file of [ENGINE_TOKEN_FILE, INTEGRATOR_TOKEN_FILE]) {
    const problem = secretFileProblem(path.join(context.secretsDir, file));
    if (problem) throw refused(problem);
  }
  const api = cloudflareApi(context, options.dryRun);
  const account = await report.guard('cloudflare-account', async () => {
    const found = await resolveAccount(api, config);
    report.step('ok', 'cloudflare-account', found.name ?? found.id);
    return found;
  });
  const teamName = await report.guard('cloudflare-zero-trust', async () => {
    const team = await teamNameOf(api, account.id);
    report.step('ok', 'cloudflare-zero-trust', `team ${team}`);
    return team;
  });
  const state: EdgeState = {
    context,
    api,
    options,
    names: namesOf(config),
    accountId: account.id,
    teamName,
    zone: null,
    idpId: null,
    tokenIds: { engine: null, integrator: null },
    policyIds: { allow: null, public: null, engine: null, integrator: null },
    audTags: { app: null, engine: null },
  };

  await ensureZone(state);
  await ensureZoneSettings(state);
  await ensureTransformRule(state);
  await ensureIdentityProvider(state);
  await ensureServiceToken(state, 'engine');
  if (config.access.integratorServiceToken) await ensureServiceToken(state, 'integrator');
  await ensurePolicies(state);
  await ensureApps(state);
  await removeIntegrator(state);
  await removePublicPolicy(state);
  const tunnel = await ensureTunnel(state);
  await ensureTunnelConfig(state, tunnel);
  await ensureEnv(state, tunnel);
}

function runStep(state: EdgeState, name: string, body: () => Promise<StepResult | void>): Promise<void> {
  return state.context.report.run(name, body);
}

async function ensureZone(state: EdgeState): Promise<void> {
  const { config } = state.context;
  await runStep(state, 'zone', async () => {
    let zone = await withRight(RIGHT_ZONE, () => findZone(state.api, config, state.accountId));
    let status: 'ok' | 'created' = 'ok';
    if (!zone) {
      if (state.options.dryRun)
        return dry(`create the zone ${config.cloudflare.zone} (full setup, no automatic records)`);
      const created = await withRight(RIGHT_ZONE, () =>
        state.api.post('/zones', {
          name: config.cloudflare.zone,
          account: { id: state.accountId },
          type: 'full',
          jump_start: false,
        }),
      );
      zone = shape(zoneSchema, created, 'zone');
      status = 'created';
    }
    state.zone = zone;
    const servers = zone.name_servers?.length ? zone.name_servers.join(', ') : 'none reported yet';
    return { status, detail: `${zone.name} is ${zone.status}; name servers: ${servers}` };
  });
}

function sameSetting(actual: unknown, wanted: Json): boolean {
  if (wanted !== null && typeof wanted === 'object' && !Array.isArray(wanted)) {
    if (actual === null || typeof actual !== 'object') return false;
    return Object.entries(wanted).every(([key, value]) =>
      sameJson((actual as Record<string, unknown>)[key], value),
    );
  }
  return actual === wanted;
}

async function ensureZoneSettings(state: EdgeState): Promise<void> {
  await runStep(state, 'zone-settings', async () => {
    const zone = state.zone;
    if (!zone)
      return dry(
        'set the edge settings (HTTPS only, TLS 1.2, no rewrites, no Rocket Loader, HSTS) once the zone exists',
      );
    const current = (
      await withRight(RIGHT_SETTINGS, () => state.api.get<unknown[]>(`/zones/${zone.id}/settings`))
    ).map((item) => shape(settingSchema, item, 'zone setting'));
    const differing = ZONE_SETTINGS.filter((wanted) => {
      const actual = current.find((item) => item.id === wanted.id);
      return !actual || !sameSetting(actual.value, wanted.value);
    });
    if (differing.length === 0) return { status: 'unchanged', detail: `${ZONE_SETTINGS.length} settings` };
    const names = differing.map((item) => item.id).join(', ');
    if (state.options.dryRun) return dry(`set ${names}`);
    for (const setting of differing)
      await withRight(RIGHT_SETTINGS, () =>
        state.api.patch(`/zones/${zone.id}/settings/${setting.id}`, { value: setting.value }),
      );
    return { status: 'updated', detail: names };
  });
}

/** Read-only fields of a stored rule that are not sent back. */
const RULE_SERVER_FIELDS = ['version', 'last_updated'];

async function ensureTransformRule(state: EdgeState): Promise<void> {
  const { hostname } = state.context.config.cloudflare;
  await runStep(state, 'transform-rule', async () => {
    const zone = state.zone;
    if (!zone) return dry('add the no-framing header rule once the zone exists');
    const entrypoint = `/zones/${zone.id}/rulesets/phases/${TRANSFORM_PHASE}/entrypoint`;
    const existing = await withRight(RIGHT_TRANSFORM, () => state.api.getOrNull(entrypoint));
    const rules = existing === null ? [] : (shape(rulesetSchema, existing, 'ruleset').rules ?? []);
    const wanted = frameRule(hostname);
    const index = rules.findIndex((rule) => rule.ref === TRANSFORM_REF);
    const own = index === -1 ? null : rules[index]!;
    if (own && Object.entries(wanted).every(([key, value]) => sameJson(own[key], value)))
      return { status: 'unchanged', detail: TRANSFORM_REF };
    if (state.options.dryRun)
      return dry(`${own ? 'update' : 'add'} the rule ${TRANSFORM_REF} (X-Frame-Options and frame-ancestors)`);
    const sent: Json[] = rules.map((rule) => {
      const copy = { ...rule } as Record<string, Json>;
      for (const field of RULE_SERVER_FIELDS) delete copy[field];
      return copy;
    });
    if (own) sent[index] = { ...(sent[index] as Record<string, Json>), ...wanted };
    else sent.push(wanted);
    await withRight(RIGHT_TRANSFORM, () => state.api.put(entrypoint, { rules: sent }));
    return {
      status: own ? 'updated' : 'created',
      detail: `${TRANSFORM_REF}; ${rules.length - (own ? 1 : 0)} other rule(s) kept`,
    };
  });
}

async function ensureIdentityProvider(state: EdgeState): Promise<void> {
  await runStep(state, 'identity-provider', async () => {
    const path = `/accounts/${state.accountId}/access/identity_providers`;
    const providers = (await withRight(RIGHT_IDPS, () => state.api.list(path))).map((item) =>
      shape(idpSchema, item, 'identity provider'),
    );
    const otp = providers.find((provider) => provider.type === 'onetimepin');
    if (otp) {
      state.idpId = otp.id;
      return { status: 'unchanged', detail: 'One-time PIN' };
    }
    if (state.options.dryRun) return dry('create the One-time PIN identity provider');
    const created = shape(
      idpSchema,
      await withRight(RIGHT_IDPS, () =>
        state.api.post(path, { type: 'onetimepin', name: 'One-time PIN', config: {} }),
      ),
      'identity provider',
    );
    state.idpId = created.id;
    return { status: 'created', detail: 'One-time PIN' };
  });
}

export interface TokenFile {
  clientId: string;
  clientSecret: string;
}

/** The service token file (the engine's `linkHeadersFile` format); null when it is missing or not that format. */
export function readTokenFile(file: string): TokenFile | null {
  const text = readSecret(file);
  if (text === null) return null;
  try {
    const parsed = z
      .looseObject({ 'CF-Access-Client-Id': z.string().min(1), 'CF-Access-Client-Secret': z.string().min(1) })
      .parse(JSON.parse(text));
    return { clientId: parsed['CF-Access-Client-Id'], clientSecret: parsed['CF-Access-Client-Secret'] };
  } catch {
    return null;
  }
}

/** The `linkHeadersFile` format of the engine (PM-317). */
function tokenFileText(clientId: string, clientSecret: string): string {
  return `${JSON.stringify({ 'CF-Access-Client-Id': clientId, 'CF-Access-Client-Secret': clientSecret }, null, 2)}\n`;
}

function expiryText(token: ServiceToken, now: Date): string {
  if (!token.expires_at) return 'no expiry reported';
  const expires = Date.parse(token.expires_at);
  if (Number.isNaN(expires)) return `expires ${token.expires_at}`;
  const days = Math.floor((expires - now.getTime()) / DAY_MS);
  return `expires ${token.expires_at.slice(0, 10)} (in ${days} days)`;
}

async function ensureServiceToken(state: EdgeState, kind: 'engine' | 'integrator'): Promise<void> {
  const { context, api, accountId } = state;
  const name = kind === 'engine' ? state.names.engineToken : state.names.integratorToken;
  const fileName = kind === 'engine' ? ENGINE_TOKEN_FILE : INTEGRATOR_TOKEN_FILE;
  const rotate = kind === 'engine' ? state.options.rotateEngineToken : state.options.rotateIntegratorToken;
  const flag = kind === 'engine' ? '--rotate-engine-token' : '--rotate-integrator-token';
  const file = path.join(context.secretsDir, fileName);
  const collection = `/accounts/${accountId}/access/service_tokens`;
  await runStep(state, `service-token-${kind}`, async () => {
    const existing = await withRight(RIGHT_TOKENS, () => findServiceToken(api, accountId, name));
    const save = (id: string, secret: string) => {
      context.report.protect(secret);
      writeSecret(context.secretsDir, fileName, tokenFileText(id, secret));
    };
    if (!existing) {
      if (state.options.dryRun)
        return dry(`create the service token ${name} (${TOKEN_DURATION}) and write ${fileName}`);
      const created = shape(
        serviceTokenSchema,
        await withRight(RIGHT_TOKENS, () => api.post(collection, { name, duration: TOKEN_DURATION })),
        'service token',
      );
      state.tokenIds[kind] = created.id;
      if (!created.client_id || !created.client_secret)
        throw new CloudError(
          `the new service token ${name} came back without its id and secret; delete it in the dashboard and run edge again`,
        );
      try {
        save(created.client_id, created.client_secret);
      } catch (error) {
        throw new CloudError(
          `the service token ${name} was created but ${fileName} could not be written (${(error as Error).message}); its secret is lost: run edge with ${flag}`,
        );
      }
      return {
        status: 'created',
        detail: `${name}, ${expiryText(created, context.deps.now())}; secret in ${fileName} (mode 600)`,
      };
    }
    state.tokenIds[kind] = existing.id;
    const stored = readTokenFile(file);
    const fileGood =
      stored !== null && (existing.client_id === undefined || stored.clientId === existing.client_id);
    if (fileGood && !rotate)
      return { status: 'unchanged', detail: `${name}, ${expiryText(existing, context.deps.now())}` };
    if (!fileGood && !rotate)
      throw refused(
        `the service token ${name} exists but ${fileName} is ${stored === null ? 'missing or unreadable' : 'for another token'}: the secret is shown only when the token is made. Run edge with ${flag} to replace the secret (whoever uses the old one then needs the new file)`,
      );
    if (state.options.dryRun) return dry(`rotate the secret of ${name} and write ${fileName}`);
    const rotated = shape(
      serviceTokenSchema,
      await withRight(RIGHT_TOKENS, () => api.post(`${collection}/${existing.id}/rotate`, {})),
      'service token',
    );
    const clientId = rotated.client_id ?? existing.client_id;
    if (!clientId || !rotated.client_secret)
      throw new CloudError(`the rotated service token ${name} came back without its secret`);
    save(clientId, rotated.client_secret);
    return {
      status: 'updated',
      detail: `${name} rotated, ${expiryText(rotated.expires_at ? rotated : existing, context.deps.now())}; secret in ${fileName} (mode 600)`,
    };
  });
}

async function ensurePolicy(state: EdgeState, spec: PolicySpec): Promise<string | null> {
  const { api, accountId } = state;
  const collection = `/accounts/${accountId}/access/policies`;
  let id: string | null = null;
  await runStep(state, `policy ${spec.name}`, async () => {
    const existing = await withRight(RIGHT_APPS, () => findPolicy(api, accountId, spec.name));
    if (!existing) {
      if (state.options.dryRun) return dry('create it');
      const created = shape(
        policySchema,
        await withRight(RIGHT_APPS, () => api.post(collection, policyBody(spec))),
        'Access policy',
      );
      id = created.id;
      return { status: 'created', detail: spec.decision };
    }
    id = existing.id;
    if (policyMatches(existing, spec)) return { status: 'unchanged', detail: spec.decision };
    if (state.options.dryRun) return dry('put its rules right');
    await withRight(RIGHT_APPS, () => api.put(`${collection}/${existing.id}`, policyBody(spec)));
    return { status: 'updated', detail: spec.decision };
  });
  return id;
}

async function ensurePolicies(state: EdgeState): Promise<void> {
  const { config } = state.context;
  // The e-mail policy is kept in public mode too (unattached), so switching back is one `edge` run.
  state.policyIds.allow = await ensurePolicy(state, allowPolicySpec(config, state.names));
  if (isPublicBoard(config))
    state.policyIds.public = await ensurePolicy(state, publicPolicySpec(state.names));
  state.policyIds.engine = state.tokenIds.engine
    ? await ensurePolicy(state, servicePolicySpec(state.names.enginePolicy, state.tokenIds.engine))
    : await dryPolicy(state, state.names.enginePolicy);
  if (config.access.integratorServiceToken)
    state.policyIds.integrator = state.tokenIds.integrator
      ? await ensurePolicy(state, servicePolicySpec(state.names.integratorPolicy, state.tokenIds.integrator))
      : await dryPolicy(state, state.names.integratorPolicy);
}

/** A policy of a token that does not exist yet (a dry run): the policy may exist, its content cannot be compared. */
async function dryPolicy(state: EdgeState, name: string): Promise<string | null> {
  const existing = await findPolicy(state.api, state.accountId, name);
  state.context.report.step(
    'skipped',
    `policy ${name}`,
    existing
      ? 'dry-run: its token does not exist yet; would put its rules right'
      : 'dry-run: would create it with the new service token',
  );
  return existing?.id ?? null;
}

interface AppSpec {
  name: string;
  domain: string;
  policyIds: (string | null)[];
  /** The login page goes straight to the identity provider; off for the public main application (no login there). */
  autoRedirect: boolean;
}

function appBody(state: EdgeState, spec: AppSpec, ids: string[]): Json {
  return {
    name: spec.name,
    type: 'self_hosted',
    domain: spec.domain,
    app_launcher_visible: false,
    session_duration: state.context.config.access.sessionDuration,
    allowed_idps: [state.idpId!],
    auto_redirect_to_identity: spec.autoRedirect,
    policies: ids.map((id, index) => ({ id, precedence: index + 1 })),
  };
}

function appMatches(state: EdgeState, app: AccessApp, spec: AppSpec, ids: string[]): boolean {
  return (
    (app.type ?? 'self_hosted') === 'self_hosted' &&
    app.domain === spec.domain &&
    app.app_launcher_visible === false &&
    app.session_duration === state.context.config.access.sessionDuration &&
    app.auto_redirect_to_identity === spec.autoRedirect &&
    sameJson(app.allowed_idps ?? [], [state.idpId]) &&
    sameJson(appPolicyIds(app), ids)
  );
}

async function ensureApp(state: EdgeState, spec: AppSpec): Promise<string | null> {
  const { api, accountId } = state;
  const collection = `/accounts/${accountId}/access/apps`;
  let aud: string | null = null;
  await runStep(state, `access-app ${spec.name}`, async () => {
    const existing = await withRight(RIGHT_APPS, () => findApp(api, accountId, spec.name));
    aud = existing?.aud ?? null;
    const ids = spec.policyIds.filter((id): id is string => id !== null);
    const complete = ids.length === spec.policyIds.length && state.idpId !== null;
    if (!complete) {
      return dry(
        `${existing ? 'put' : 'create'} it once its policies and the identity provider exist (${spec.domain})`,
      );
    }
    if (existing && appMatches(state, existing, spec, ids))
      return { status: 'unchanged', detail: spec.domain };
    if (state.options.dryRun)
      return dry(
        `${existing ? 'put it right' : 'create it'} (${spec.domain}, ${ids.length} polic${ids.length === 1 ? 'y' : 'ies'})`,
      );
    const body = appBody(state, spec, ids);
    const saved = shape(
      appSchema,
      await withRight(RIGHT_APPS, () =>
        existing ? api.put(`${collection}/${existing.id}`, body) : api.post(collection, body),
      ),
      'Access application',
    );
    aud = saved.aud ?? existing?.aud ?? null;
    return { status: existing ? 'updated' : 'created', detail: spec.domain };
  });
  return aud;
}

async function ensureApps(state: EdgeState): Promise<void> {
  const { config } = state.context;
  const { hostname } = config.cloudflare;
  // Public: exactly the one bypass policy; the integrator policy is not attached (its token stays per config).
  const main = isPublicBoard(config)
    ? [state.policyIds.public]
    : [state.policyIds.allow, ...(config.access.integratorServiceToken ? [state.policyIds.integrator] : [])];
  state.audTags.app = await ensureApp(state, {
    name: state.names.app,
    domain: hostname,
    policyIds: main,
    autoRedirect: !isPublicBoard(config),
  });
  state.audTags.engine = await ensureApp(state, {
    name: state.names.engineApp,
    domain: `${hostname}/engine`,
    policyIds: [state.policyIds.engine],
    autoRedirect: true,
  });
}

/** With the integrator token switched off, its policy and token go (after the apps stopped using the policy). */
async function removeIntegrator(state: EdgeState): Promise<void> {
  const { config } = state.context;
  if (config.access.integratorServiceToken) return;
  const { api, accountId, names } = state;
  await runStep(state, 'integrator-cleanup', async () => {
    const policy = await withRight(RIGHT_APPS, () => findPolicy(api, accountId, names.integratorPolicy));
    const token = await withRight(RIGHT_TOKENS, () =>
      findServiceToken(api, accountId, names.integratorToken),
    );
    const file = path.join(state.context.secretsDir, INTEGRATOR_TOKEN_FILE);
    const hasFile = fs.existsSync(file);
    if (!policy && !token && !hasFile) return { status: 'unchanged', detail: 'no integrator token' };
    if (state.options.dryRun) return dry('delete the integrator policy, token and file');
    if (policy)
      await withRight(RIGHT_APPS, () => api.delete(`/accounts/${accountId}/access/policies/${policy.id}`));
    if (token)
      await withRight(RIGHT_TOKENS, () =>
        api.delete(`/accounts/${accountId}/access/service_tokens/${token.id}`),
      );
    if (hasFile) fs.rmSync(file, { force: true });
    return { status: 'updated', detail: 'the integrator policy, token and file are deleted' };
  });
}

/**
 * Back in private mode the bypass policy goes, after the main application stopped using it: no unused policy that
 * lets everybody through stays around (PM-672). Not needed when it does not exist.
 */
async function removePublicPolicy(state: EdgeState): Promise<void> {
  if (isPublicBoard(state.context.config)) return;
  const { api, accountId, names } = state;
  await runStep(state, 'public-policy-cleanup', async () => {
    const policy = await withRight(RIGHT_APPS, () => findPolicy(api, accountId, names.publicPolicy));
    if (!policy) return { status: 'unchanged', detail: 'no public-board policy' };
    if (state.options.dryRun) return dry(`delete the policy ${names.publicPolicy}`);
    await withRight(RIGHT_APPS, () => api.delete(`/accounts/${accountId}/access/policies/${policy.id}`));
    return { status: 'updated', detail: `the policy ${names.publicPolicy} is deleted` };
  });
}

async function ensureTunnel(state: EdgeState): Promise<Tunnel | null> {
  const { config } = state.context;
  let tunnel: Tunnel | null = null;
  await runStep(state, 'tunnel', async () => {
    const existing = await withRight(RIGHT_TUNNEL, () =>
      findTunnel(state.api, state.accountId, state.names.tunnel),
    );
    if (existing) {
      if (existing.config_src !== undefined && existing.config_src !== 'cloudflare')
        throw refused(
          `the tunnel ${existing.name} is configured from a local file (config_src ${existing.config_src}); the ingress cannot be set through the API. Delete it in the dashboard or use another cloudflare.tunnelName`,
        );
      tunnel = existing;
      return { status: 'unchanged', detail: `${existing.name} is ${existing.status ?? 'of unknown status'}` };
    }
    if (state.options.dryRun) return dry(`create the tunnel ${config.cloudflare.tunnelName}`);
    tunnel = shape(
      tunnelSchema,
      await withRight(RIGHT_TUNNEL, () =>
        state.api.post(`/accounts/${state.accountId}/cfd_tunnel`, {
          name: state.names.tunnel,
          config_src: 'cloudflare',
        }),
      ),
      'tunnel',
    );
    return { status: 'created', detail: state.names.tunnel };
  });
  return tunnel;
}

/** The audiences the tunnel demands: private, both applications; public, the engine application alone (PM-672). */
export function ingressAudTags(config: CloudConfig, app: string, engine: string): string[] {
  return isPublicBoard(config) ? [engine] : [app, engine];
}

/** What the comparison of an ingress rule looks at: the keys we set (an empty originRequest is none). */
function normalizeIngress(rules: readonly unknown[]): unknown[] {
  return rules.map((rule) => {
    const item = { ...(rule as Record<string, unknown>) };
    const origin = item.originRequest;
    if (origin !== null && typeof origin === 'object' && Object.keys(origin).length === 0)
      delete item.originRequest;
    for (const key of Object.keys(item))
      if (!['hostname', 'path', 'service', 'originRequest'].includes(key)) delete item[key];
    return item;
  });
}

/**
 * What else the tunnel configuration holds besides the ingress. A top-level `originRequest` applies to every
 * rule that has none of its own (an `httpHostHeader` there would reach the main rule), so anything meaningful
 * counts as a difference; only the empty defaults Cloudflare returns by itself are let through.
 */
function foreignConfigKeys(config: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'ingress') continue;
    if (value === null || value === undefined) continue;
    if (key === 'originRequest' && typeof value === 'object' && Object.keys(value).length === 0) continue;
    if (key === 'warp-routing' && sameJson(value, { enabled: false })) continue;
    rest[key] = value;
  }
  return rest;
}

async function ensureTunnelConfig(state: EdgeState, tunnel: Tunnel | null): Promise<void> {
  const { config } = state.context;
  await runStep(state, 'tunnel-config', async () => {
    const { app, engine } = state.audTags;
    if (!tunnel || !app || !engine)
      return dry('set the ingress once the tunnel and both Access applications exist');
    const ingress = ingressRules(config, state.teamName, ingressAudTags(config, app, engine));
    const path = `/accounts/${state.accountId}/cfd_tunnel/${tunnel.id}/configurations`;
    const current = shape(
      tunnelConfigSchema,
      (await withRight(RIGHT_TUNNEL, () => state.api.getOrNull(path))) ?? {},
      'tunnel configuration',
    );
    if (
      sameJson(normalizeIngress(current.config?.ingress ?? []), normalizeIngress(ingress)) &&
      Object.keys(foreignConfigKeys(current.config ?? {})).length === 0
    )
      return { status: 'unchanged', detail: `${ingress.length} ingress rules` };
    if (state.options.dryRun) return dry('put the ingress right');
    await withRight(RIGHT_TUNNEL, () => state.api.put(path, { config: { ingress } }));
    return { status: 'updated', detail: `${ingress.length} ingress rules` };
  });
}

async function ensureEnv(state: EdgeState, tunnel: Tunnel | null): Promise<void> {
  const { config, report, envFile } = state.context;
  await runStep(state, 'cloud-env', async () => {
    if (!tunnel) return dry('write TUNNEL_TOKEN to cloud.env once the tunnel exists');
    const token = shape(
      z.string().min(1),
      await withRight(RIGHT_TUNNEL, () =>
        state.api.get(`/accounts/${state.accountId}/cfd_tunnel/${tunnel.id}/token`),
      ),
      'tunnel token',
    );
    report.protect(token);
    const updates: Record<string, string> = { TUNNEL_TOKEN: token };
    const feedback = config.cloudflare.feedbackHostname;
    const current = readEnvFile(envFile);
    const changed: string[] = [];
    if (current.get('TUNNEL_TOKEN') !== token) changed.push('TUNNEL_TOKEN');
    if (feedback) {
      updates.PROJECTMAN_FEEDBACK_PUBLIC_URL = `https://${feedback}`;
      if (current.get('PROJECTMAN_FEEDBACK_PUBLIC_URL') !== updates.PROJECTMAN_FEEDBACK_PUBLIC_URL)
        changed.push('PROJECTMAN_FEEDBACK_PUBLIC_URL');
    } else if (current.has('PROJECTMAN_FEEDBACK_PUBLIC_URL')) changed.push('PROJECTMAN_FEEDBACK_PUBLIC_URL');
    // The server's own start check of the public board (PM-672): on only in public mode, gone in private mode.
    const publicBoard = isPublicBoard(config);
    if (publicBoard) {
      updates[PUBLIC_BOARD_ENV] = '1';
      if (current.get(PUBLIC_BOARD_ENV) !== '1') changed.push(PUBLIC_BOARD_ENV);
    } else if (current.has(PUBLIC_BOARD_ENV)) changed.push(PUBLIC_BOARD_ENV);
    if (changed.length === 0) return { status: 'unchanged', detail: 'TUNNEL_TOKEN is current' };
    if (state.options.dryRun) return dry(`change ${changed.join(', ')} in cloud.env`);
    updateEnvFile(envFile, updates);
    const gone = [
      ...(feedback ? [] : ['PROJECTMAN_FEEDBACK_PUBLIC_URL']),
      ...(publicBoard ? [] : [PUBLIC_BOARD_ENV]),
    ];
    if (gone.length > 0) removeEnvNames(envFile, gone);
    report.step('updated', 'cloud-env', changed.join(', '));
    report.line('note: cloud.env changed; run "npm run cloud -- deploy" to hand it to the machine');
  });
}

// ---- the check of an Access setup, shared with publish ----

/** The expected policy lists of the two applications and the content of the policies; every difference is a problem. */
export async function verifyAccess(
  context: CloudContext,
  api: CloudflareApi,
  accountId: string,
): Promise<string[]> {
  const { config } = context;
  const names = namesOf(config);
  const problems: string[] = [];
  const publicBoard = isPublicBoard(config);
  const policies = {
    allow: await findPolicy(api, accountId, names.allowPolicy),
    public: publicBoard ? await findPolicy(api, accountId, names.publicPolicy) : null,
    engine: await findPolicy(api, accountId, names.enginePolicy),
    integrator: config.access.integratorServiceToken
      ? await findPolicy(api, accountId, names.integratorPolicy)
      : null,
  };
  const engineToken = await findServiceToken(api, accountId, names.engineToken);
  const integratorToken = config.access.integratorServiceToken
    ? await findServiceToken(api, accountId, names.integratorToken)
    : null;
  const allowSpec = allowPolicySpec(config, names);
  if (publicBoard) {
    // The e-mail policy may exist (kept for the way back) but is not attached, so it is not compared here.
    if (!policies.public) problems.push(`the policy ${names.publicPolicy} does not exist`);
    else if (!policyMatches(policies.public, publicPolicySpec(names)))
      problems.push(`the policy ${names.publicPolicy} is not exactly the bypass for everyone`);
  } else if (!policies.allow) problems.push(`the policy ${names.allowPolicy} does not exist`);
  else if (!policyMatches(policies.allow, allowSpec))
    problems.push(`the policy ${names.allowPolicy} is not exactly the e-mail list of access.emails`);
  const serviceCheck = (policy: AccessPolicy | null, name: string, token: ServiceToken | null) => {
    if (!policy || !token) {
      problems.push(`the policy ${name} or its service token does not exist`);
      return;
    }
    if (!policyMatches(policy, servicePolicySpec(name, token.id)))
      problems.push(`the policy ${name} is not exactly its service token`);
  };
  serviceCheck(policies.engine, names.enginePolicy, engineToken);
  if (config.access.integratorServiceToken)
    serviceCheck(policies.integrator, names.integratorPolicy, integratorToken);

  const appCheck = async (name: string, domain: string, expected: (AccessPolicy | null)[]) => {
    const app = await findApp(api, accountId, name);
    if (!app) {
      problems.push(`the Access application ${name} does not exist`);
      return;
    }
    if (app.domain !== domain)
      problems.push(`the Access application ${name} covers ${app.domain ?? 'nothing'}, not ${domain}`);
    const wanted = expected.map((policy) => policy?.id ?? '(missing)');
    if (!sameJson(appPolicyIds(app), wanted))
      problems.push(
        `the Access application ${name} does not have exactly its own policies (${appPolicyIds(app).length} attached, ${wanted.length} expected)`,
      );
  };
  await appCheck(
    names.app,
    config.cloudflare.hostname,
    publicBoard
      ? [policies.public]
      : [policies.allow, ...(config.access.integratorServiceToken ? [policies.integrator] : [])],
  );
  await appCheck(names.engineApp, `${config.cloudflare.hostname}/engine`, [policies.engine]);
  return problems;
}

/**
 * Public board (PM-672): the live ingress of the tunnel is exactly the public shape, with the engine application's
 * audience on `/engine` and none on the rest of the hostname. Returns the problems; empty means it is right.
 */
export async function verifyPublicIngress(
  context: CloudContext,
  api: CloudflareApi,
  accountId: string,
  tunnel: Tunnel,
): Promise<string[]> {
  const { config } = context;
  const names = namesOf(config);
  const engineApp = await findApp(api, accountId, names.engineApp);
  if (!engineApp?.aud)
    return [`the Access application ${names.engineApp} has no audience to check the ingress with`];
  const teamName = await teamNameOf(api, accountId);
  const wanted = ingressRules(config, teamName, [engineApp.aud]);
  const current = shape(
    tunnelConfigSchema,
    (await withRight(RIGHT_TUNNEL, () =>
      api.getOrNull(`/accounts/${accountId}/cfd_tunnel/${tunnel.id}/configurations`),
    )) ?? {},
    'tunnel configuration',
  );
  const problems: string[] = [];
  if (!sameJson(normalizeIngress(current.config?.ingress ?? []), normalizeIngress(wanted)))
    problems.push('the tunnel ingress is not exactly the public-board ingress');
  if (Object.keys(foreignConfigKeys(current.config ?? {})).length > 0)
    problems.push('the tunnel configuration has settings besides the ingress');
  return problems;
}
