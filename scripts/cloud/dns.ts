import { z } from 'zod';
import { AwsCli } from './aws-cli';
import { cloudflareApi, findZone, resolveAccount, shape } from './cloudflare';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';

// The one-off Route 53 → Cloudflare migration commands (plan, import, verify, switch) were retired with the
// cutover (PM-1116); the last commit that has them is tagged `retired-migrate-dns`. What stays is the read-only status.

function unescape(value: string): string {
  return value.replace(/\\([0-7]{3}|["\\])/g, (_match, escaped: string) =>
    /^[0-7]{3}$/.test(escaped) ? String.fromCharCode(parseInt(escaped, 8)) : escaped,
  );
}
function dnsName(value: string): string {
  return unescape(value).replace(/\.$/, '').toLowerCase();
}

async function dnsZone(context: CloudContext, readOnly = true) {
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

const dohSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});
async function publicDns(context: CloudContext, type: 'NS' | 'DS') {
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
  return new AwsCli(context.deps, { profile: context.config.route53.profile, region: 'us-east-1' });
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
