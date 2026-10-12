import { z } from 'zod';
import { AwsCallError, AwsCli } from './aws-cli';
import { cloudflareApi, findZone, resolveAccount, shape } from './cloudflare';
import { sameJson } from './cloudflare-api';
import type { Json } from './cloudflare-api';
import type { CloudContext } from './context';
import type { DnsRecordType } from './deps';
import { CloudError, refused } from './errors';

const sourceSchema = z.looseObject({
  Name: z.string(),
  Type: z.string(),
  TTL: z.number().int().nonnegative().optional(),
  ResourceRecords: z.array(z.object({ Value: z.string() })).optional(),
  AliasTarget: z.looseObject({ DNSName: z.string() }).optional(),
  SetIdentifier: z.unknown().optional(),
  HealthCheckId: z.unknown().optional(),
  MultiValueAnswer: z.boolean().optional(),
});
type Source = z.output<typeof sourceSchema>;
export interface RecordSpec {
  type: DnsRecordType;
  name: string;
  content?: string;
  ttl: number;
  proxied: false;
  priority?: number;
  data?: Record<string, string | number>;
}
const remoteSchema = z.looseObject({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  content: z.string().optional(),
  ttl: z.number(),
  proxied: z.boolean().optional(),
  priority: z.number().optional(),
  data: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
type Remote = z.output<typeof remoteSchema>;
function brief(value: unknown): string {
  const text = JSON.stringify(value) ?? '';
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}
export interface Mapping {
  records: RecordSpec[];
  skipped: Source[];
  refusals: string[];
}

function unescape(value: string): string {
  return value.replace(/\\([0-7]{3}|["\\])/g, (_match, escaped: string) =>
    /^[0-7]{3}$/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : escaped,
  );
}
export function dnsName(value: string): string {
  return unescape(value).replace(/\.$/, '').toLowerCase();
}

/** Route 53 quoted TXT chunks are concatenated without adding whitespace. */
export function txtContent(value: string): string {
  const chunks = value.match(/"(?:\\[\s\S]|[^"\\])*"/g);
  if (!chunks || value.replace(/"(?:\\[\s\S]|[^"\\])*"/g, '').trim())
    throw new Error('invalid quoted TXT chunks');
  return chunks.map((chunk) => unescape(chunk.slice(1, -1))).join('');
}

export function mapRecords(sources: Source[], zone: string, reserved: string[]): Mapping {
  const result: Mapping = { records: [], skipped: [], refusals: [] };
  for (const source of sources) {
    const name = dnsName(source.Name);
    try {
      if (source.SetIdentifier !== undefined || source.HealthCheckId !== undefined || source.MultiValueAnswer)
        throw new Error('routing policy or health check cannot be migrated');
      if (reserved.includes(name)) throw new Error('hostname is reserved for publish');
      if (name === zone && ['NS', 'SOA'].includes(source.Type)) {
        result.skipped.push(source);
        continue;
      }
      if (!['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'].includes(source.Type))
        throw new Error(`unsupported type ${source.Type}`);
      const base = { name, ttl: Math.max(60, Math.min(86400, source.TTL ?? 300)), proxied: false as const };
      if (source.AliasTarget) {
        if (name !== zone && sources.some((other) => dnsName(other.Name) === name && !other.AliasTarget))
          throw new Error('alias CNAME conflicts with another record type');
        const record: RecordSpec = { ...base, type: 'CNAME', content: dnsName(source.AliasTarget.DNSName) };
        const previous = result.records.find((other) => other.name === name && other.type === 'CNAME');
        if (previous && !sameJson(previous, record)) throw new Error('aliases have different targets');
        if (!previous) result.records.push(record);
        continue;
      }
      if (!source.ResourceRecords?.length || source.TTL === undefined)
        throw new Error('missing values or TTL');
      const mapped = source.ResourceRecords.map(({ Value }): RecordSpec => {
        const type = source.Type as DnsRecordType;
        if (['A', 'AAAA'].includes(type)) return { ...base, type, content: Value };
        if (['CNAME', 'NS'].includes(type)) return { ...base, type, content: dnsName(Value) };
        if (type === 'TXT') return { ...base, type, content: txtContent(Value) };
        const parts = Value.trim().split(/\s+/);
        const number = (index: number, max = 65535) => {
          const part = parts[index] ?? '';
          if (!/^\d+$/.test(part) || Number(part) > max) throw new Error(`invalid ${type} value`);
          return Number(part);
        };
        if (type === 'MX' && parts.length === 2)
          return { ...base, type, priority: number(0), content: dnsName(parts[1]!) };
        if (type === 'SRV' && parts.length === 4)
          return {
            ...base,
            type,
            data: { priority: number(0), weight: number(1), port: number(2), target: dnsName(parts[3]!) },
          };
        const caa = /^(\d+)\s+([a-zA-Z0-9]+)\s+("(?:\\[\s\S]|[^"\\])*")$/.exec(Value);
        if (type === 'CAA' && caa && Number(caa[1]) <= 255)
          return {
            ...base,
            type,
            data: { flags: Number(caa[1]), tag: caa[2]!.toLowerCase(), value: txtContent(caa[3]!) },
          };
        throw new Error(`invalid ${type} value`);
      });
      result.records.push(...mapped);
    } catch (error) {
      result.refusals.push(`${name} ${source.Type}: ${(error as Error).message}`);
    }
  }
  return result;
}

async function sourceZone(context: CloudContext) {
  const aws = new AwsCli(context.deps, context.config.aws);
  let id = context.config.route53.hostedZoneId;
  if (!id) {
    const answer = await aws.callAs(
      ['route53', 'list-hosted-zones-by-name', '--dns-name', context.config.cloudflare.zone],
      z.object({
        HostedZones: z.array(
          z.looseObject({ Id: z.string(), Name: z.string(), Config: z.object({ PrivateZone: z.boolean() }) }),
        ),
      }),
    );
    const matches = answer.HostedZones.filter(
      (zone) => zone.Name.toLowerCase() === `${context.config.cloudflare.zone}.` && !zone.Config.PrivateZone,
    );
    if (matches.length !== 1)
      throw refused(
        `expected one public Route 53 zone for ${context.config.cloudflare.zone}; found ${matches.length}`,
      );
    id = matches[0]!.Id;
  }
  const detail = await aws.callAs(
    ['route53', 'get-hosted-zone', '--id', id],
    z.object({
      HostedZone: z.looseObject({ Name: z.string(), Config: z.object({ PrivateZone: z.boolean() }) }),
      DelegationSet: z.object({ NameServers: z.array(z.string()).min(1) }),
    }),
  );
  if (
    dnsName(detail.HostedZone.Name) !== context.config.cloudflare.zone ||
    detail.HostedZone.Config.PrivateZone
  )
    throw refused('the configured Route 53 zone is not the public source zone');
  const answer = await aws.callAs(
    ['route53', 'list-resource-record-sets', '--hosted-zone-id', id],
    z.object({ ResourceRecordSets: z.array(sourceSchema) }),
  );
  return { sources: answer.ResourceRecordSets, servers: detail.DelegationSet.NameServers };
}

export async function dnsZone(context: CloudContext, readOnly = true) {
  const api = cloudflareApi(context, readOnly);
  const account = await resolveAccount(api, context.config);
  const zone = await findZone(api, context.config, account.id);
  if (!zone) throw refused('Cloudflare zone is missing; run edge first');
  const detail = shape(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      name_servers: z.array(z.string()).optional(),
    }),
    await api.get(`/zones/${zone.id}`),
    'zone',
  );
  return { api, zone: detail };
}

function identity(record: RecordSpec | Remote) {
  const data = record.data ? { ...record.data } : undefined;
  if (data?.target !== undefined) data.target = dnsName(String(data.target));
  if (data?.tag !== undefined) data.tag = String(data.tag).toLowerCase();
  let content = record.content;
  if (content !== undefined && ['CNAME', 'NS', 'MX'].includes(record.type)) content = dnsName(content);
  if (record.type === 'SRV' || record.type === 'CAA') content = undefined;
  return {
    type: record.type,
    name: dnsName(record.name),
    content,
    priority: record.type === 'MX' ? record.priority : undefined,
    data:
      data &&
      Object.fromEntries(
        Object.entries(data).filter(([key]) =>
          ['priority', 'weight', 'port', 'target', 'flags', 'tag', 'value'].includes(key),
        ),
      ),
  };
}
function checkedMapping(context: CloudContext, sources: Source[]) {
  return mapRecords(sources, context.config.cloudflare.zone, [
    context.config.cloudflare.hostname,
    context.config.cloudflare.feedbackHostname ?? '',
  ]);
}
function assertMapping(mapping: Mapping, context: CloudContext) {
  for (const reason of mapping.refusals) context.report.line(`REFUSE ${reason}`);
  if (mapping.refusals.length) throw refused('Route 53 records cannot be migrated safely');
}

export async function runDnsPlan(context: CloudContext, options?: { dryRun: boolean; update: boolean }) {
  const { sources } = await sourceZone(context);
  const mapping = checkedMapping(context, sources);
  const { api, zone } = await dnsZone(context, !options || options.dryRun);
  const remaining = (await api.list(`/zones/${zone.id}/dns_records`)).map((item) =>
    shape(remoteSchema, item, 'DNS record'),
  );
  const actions: { status: string; record: RecordSpec; remote?: Remote }[] = [];
  // Match exact values first, so a changed value cannot consume another value's existing record.
  for (const record of mapping.records) {
    const index = remaining.findIndex((remote) => sameJson(identity(record), identity(remote)));
    const remote = index < 0 ? undefined : remaining.splice(index, 1)[0]!;
    actions.push({
      record,
      remote,
      status: remote ? (remote.ttl === record.ttl && !remote.proxied ? 'same' : 'different') : 'create',
    });
  }
  for (const action of actions.filter((action) => !action.remote)) {
    const index = remaining.findIndex(
      (remote) => remote.type === action.record.type && dnsName(remote.name) === action.record.name,
    );
    if (index >= 0) {
      action.remote = remaining.splice(index, 1)[0]!;
      action.status = 'different';
    }
  }
  for (const source of mapping.skipped) context.report.line(`skip ${dnsName(source.Name)} ${source.Type}`);
  for (const action of actions)
    context.report.line(
      `${action.status} ${action.record.name} ${action.record.type} ${brief(action.record.content ?? action.record.data)}`,
    );
  for (const remote of remaining) {
    if (
      remote.type === 'CNAME' &&
      remote.proxied &&
      remote.content?.endsWith('.cfargotunnel.com') &&
      [context.config.cloudflare.hostname, context.config.cloudflare.feedbackHostname].includes(
        dnsName(remote.name),
      )
    )
      continue;
    context.report.line(
      `WARN Cloudflare-only ${remote.name} ${remote.type} ${brief(remote.content ?? remote.data)}`,
    );
  }
  assertMapping(mapping, context);
  // Validate conflicts before the first mutation.
  for (const action of actions.filter((action) => action.status === 'create')) {
    const others = [...remaining, ...actions.flatMap((item) => (item.remote ? [item.remote] : []))];
    if (
      others.some(
        (remote) =>
          dnsName(remote.name) === action.record.name &&
          remote.type !== action.record.type &&
          (remote.type === 'CNAME' || action.record.type === 'CNAME') &&
          action.record.name !== zone.name,
      )
    )
      throw refused(`${action.record.name}: Cloudflare CNAME conflicts with another type`);
  }
  if (!options) return;
  for (const action of actions) {
    if (action.status === 'same') continue;
    if (action.status === 'different' && !options.update) {
      context.report.line(`WARN ${action.record.name}: use --update to change the existing record`);
      continue;
    }
    if (options.dryRun) {
      context.report.line(`dry-run ${action.status} ${action.record.name}`);
      continue;
    }
    const body = action.record as unknown as Json;
    if (action.remote) await api.patch(`/zones/${zone.id}/dns_records/${action.remote.id}`, body);
    else await api.post(`/zones/${zone.id}/dns_records`, body);
  }
}

function normalizedAnswers(type: DnsRecordType, answers: string[]): string[] {
  return answers
    .map((value) => {
      if (['CNAME', 'NS'].includes(type)) return dnsName(value);
      if (['MX', 'SRV'].includes(type)) {
        const parts = value.trim().split(/\s+/);
        parts[parts.length - 1] = dnsName(parts.at(-1)!);
        return parts.join(' ');
      }
      return value;
    })
    .sort();
}

export async function runDnsVerify(context: CloudContext): Promise<void> {
  const { sources, servers } = await sourceZone(context);
  const mapping = checkedMapping(context, sources);
  assertMapping(mapping, context);
  const { zone } = await dnsZone(context);
  if (zone.name_servers?.length !== 2) throw refused('Cloudflare must report two name servers');
  const authorities = [
    ...zone.name_servers.map((name) => ({ name, cloudflare: true })),
    ...servers.map((name) => ({ name, cloudflare: false })),
  ];
  const addresses = await Promise.all(
    authorities.map(async (authority) => {
      let ips = await context.deps.resolve(authority.name, 'A');
      if (!ips.length) ips = await context.deps.resolve(authority.name, 'AAAA');
      if (!ips.length) throw new CloudError(`cannot resolve name server ${authority.name}`);
      return { ...authority, ip: ips[0]! };
    }),
  );
  let failed = false;
  for (const source of sources.filter(
    (source) => !(dnsName(source.Name) === zone.name && ['NS', 'SOA'].includes(source.Type)),
  )) {
    const name = dnsName(source.Name),
      type = source.Type as DnsRecordType;
    const responses: string[][] = [];
    let unavailable = false;
    for (const authority of addresses) {
      try {
        const answers = normalizedAnswers(type, await context.deps.resolve(name, type, [authority.ip]));
        if (!answers.length && authority.cloudflare && zone.status === 'pending') {
          context.report.line(
            `FAIL ${name} ${type}: the Cloudflare name server does not answer for the pending zone (${authority.name}); use dns plan with every record same as fallback evidence`,
          );
          unavailable = true;
          failed = true;
        }
        responses.push(answers);
      } catch (error) {
        context.report.line(
          `FAIL ${name} ${type}: ${authority.cloudflare && zone.status === 'pending' ? 'the Cloudflare name server does not answer for the pending zone' : 'name server query failed'} (${authority.name}): ${(error as Error).message}`,
        );
        unavailable = true;
        failed = true;
      }
    }
    if (unavailable) continue;
    const equal = responses[0]!.length > 0 && responses.every((answer) => sameJson(answer, responses[0]));
    if (!equal && !source.AliasTarget) failed = true;
    context.report.line(
      `${equal ? 'same' : source.AliasTarget ? 'WARN alias' : 'FAIL'} ${name} ${type}: ${equal ? 'all authoritative answers agree' : 'authoritative answers differ'}`,
    );
  }
  if (failed) throw new CloudError('DNS verification failed');
}

const dohSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});
export async function publicDns(context: CloudContext, type: 'NS' | 'DS') {
  const answers: string[][] = [];
  for (const endpoint of ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve']) {
    const url = new URL(endpoint);
    url.searchParams.set('name', context.config.cloudflare.zone);
    url.searchParams.set('type', type);
    const response = await context.deps.fetch(url, {
      headers: { accept: 'application/dns-json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new CloudError(`DoH ${url.hostname} failed: HTTP ${response.status}`);
    const answer = dohSchema.parse(await response.json());
    if (answer.Status !== 0) throw new CloudError(`DoH ${url.hostname} returned DNS status ${answer.Status}`);
    const values = (answer.Answer ?? [])
      .filter((record) => record.type === (type === 'NS' ? 2 : 43))
      .map((record) => (type === 'NS' ? dnsName(record.data) : record.data))
      .sort();
    answers.push(values);
    context.report.line(`${type} ${url.hostname}: ${values.join(', ') || 'none'}`);
  }
  return answers;
}

export async function runDnsStatus(context: CloudContext) {
  const { api, zone } = await dnsZone(context, false);
  await publicDns(context, 'NS');
  if ((await publicDns(context, 'DS')).some((answer) => answer.length))
    context.report.line('WARN DNSSEC: disable DNSSEC at Route 53 Domains before changing name servers');
  try {
    reportDomain(context, await domainDetail(context));
  } catch (error) {
    context.report.line(`WARN Route 53 Domains status unavailable: ${(error as Error).message}`);
  }
  context.report.line(
    `Cloudflare zone ${zone.name}: ${zone.status}; name servers: ${zone.name_servers?.join(', ')}`,
  );
  if (zone.status === 'pending') {
    await api.put(`/zones/${zone.id}/activation_check`, {});
    context.report.line('requested Cloudflare activation check');
  }
}

const domainSchema = z.object({
  AutoRenew: z.boolean(),
  ExpirationDate: z.union([z.string(), z.number()]),
  Nameservers: z.array(z.object({ Name: z.string() })).min(1),
  DnssecKeys: z.array(z.unknown()).optional(),
});
function domainsCli(context: CloudContext) {
  return new AwsCli(context.deps, { profile: context.config.aws.profile, region: 'us-east-1' });
}
function domainDetail(context: CloudContext) {
  return domainsCli(context).callAs(
    ['route53domains', 'get-domain-detail', '--domain-name', context.config.cloudflare.zone],
    domainSchema,
  );
}
function reportDomain(context: CloudContext, domain: z.output<typeof domainSchema>) {
  const expires = new Date(
    typeof domain.ExpirationDate === 'number' ? domain.ExpirationDate * 1000 : domain.ExpirationDate,
  );
  if (!Number.isFinite(expires.getTime()))
    throw new CloudError('Route 53 Domains returned an invalid expiration date');
  context.report.line(
    `registrar name servers: ${domain.Nameservers.map((server) => server.Name).join(', ')}; DNSSEC keys: ${domain.DnssecKeys?.length ?? 0}`,
  );
  context.report.line(
    `domain expires ${expires.toISOString()}; auto-renew ${domain.AutoRenew ? 'on' : 'OFF'}`,
  );
  if (!domain.AutoRenew) context.report.line('WARN enable domain auto-renew in Route 53 Domains');
  if (expires.getTime() - context.deps.now().getTime() <= 30 * 86400000)
    context.report.line('WARN domain expires within 30 days; check renewal');
}

/** Delegation changes are explicit, and forward changes require verification in this very run. */
export async function runDnsSwitch(context: CloudContext, options: { back: boolean; dryRun: boolean }) {
  let domain: z.output<typeof domainSchema>;
  try {
    domain = await domainDetail(context);
  } catch (error) {
    if (error instanceof AwsCallError && error.awsCode?.startsWith('AccessDenied'))
      throw refused(`the AWS profile lacks route53domains:GetDomainDetail (${error.message})`);
    throw refused(
      `cannot read the domain through Route 53 Domains; changing delegation is a manual step at the registrar (${(error as Error).message})`,
    );
  }
  reportDomain(context, domain);
  const rawTargets = options.back
    ? (await sourceZone(context)).servers
    : (await dnsZone(context)).zone.name_servers;
  if (!rawTargets?.length || (!options.back && rawTargets.length < 2))
    throw refused('the target name servers are missing');
  const targets = rawTargets.map(dnsName);
  if (options.back)
    context.report.line(
      'WARN records changed in Cloudflare since the move are not present in Route 53; review them before rolling back',
    );
  if (
    sameJson(targets.map(dnsName).sort(), domain.Nameservers.map((server) => dnsName(server.Name)).sort())
  ) {
    context.report.line('unchanged domain name servers');
    return;
  }
  if (domain.DnssecKeys?.length || (await publicDns(context, 'DS')).some((answer) => answer.length))
    throw refused(
      'disable DNSSEC at Route 53 Domains and wait for public DS records to disappear before switching',
    );
  if (!options.back) {
    try {
      await runDnsVerify(context);
    } catch (error) {
      throw refused(`name server switch requires green dns verify in this run: ${(error as Error).message}`);
    }
  }
  context.report.line(
    `${options.dryRun ? 'dry-run: would set name servers to' : 'update domain name servers:'} ${targets.join(', ')}`,
  );
  if (options.dryRun) return;
  const result = await domainsCli(context).callAs(
    [
      'route53domains',
      'update-domain-nameservers',
      '--domain-name',
      context.config.cloudflare.zone,
      '--nameservers',
      ...targets.map((name) => `Name=${name}`),
    ],
    z.object({ OperationId: z.string() }),
  );
  context.report.line(
    `Route 53 Domains operation ${result.OperationId}; run dns status until delegation is active`,
  );
}
