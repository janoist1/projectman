import { z } from 'zod';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { CloudflareApi } from './cloudflare-api';
import {
  cloudflareApi,
  findTunnel,
  findZone,
  namesOf,
  recordSchema,
  resolveAccount,
  shape,
  verifyAccess,
  withRight,
  type DnsRecord,
  type Tunnel,
  type Zone,
} from './cloudflare';
import { withHost } from './host';
import type { StepResult } from './report';
import { readEnvFile } from './secrets';

/**
 * `publish` (PM-536): makes the board reachable, last, after everything that protects it is in place. Publishing
 * is one proxied CNAME record to the tunnel; nothing is created before the checks pass (docs/AWS.md "Publish").
 * With `--feedback` the feedback hostname is published too, and only when the guard of the feedback widget works
 * (PM-510: the machine answers the unknown hostname with 404 on both `Host` shapes).
 */

export interface PublishOptions {
  dryRun: boolean;
  feedback: boolean;
}

const guardCheckSchema = z.looseObject({ plain: z.string(), port: z.string() });

/** What `host.sh guard-check` reports: the status codes the board gives to the feedback hostname. */
export async function readGuardCheck(
  context: CloudContext,
  hostname: string,
): Promise<{ plain: string; port: string }> {
  return withHost(context, async (host) => {
    const text = await host.call('guard-check', [hostname]);
    try {
      return guardCheckSchema.parse(JSON.parse(text));
    } catch {
      throw new CloudError('the machine answered guard-check in an unexpected shape');
    }
  });
}

async function publishRecord(
  context: CloudContext,
  api: CloudflareApi,
  zone: Zone,
  tunnel: Tunnel,
  hostname: string,
  dryRun: boolean,
): Promise<StepResult> {
  const target = `${tunnel.id}.cfargotunnel.com`;
  const collection = `/zones/${zone.id}/dns_records`;
  const records = (await withRight('Zone / DNS / Edit', () => api.list(collection, { name: hostname }))).map(
    (item) => shape(recordSchema, item, 'DNS record'),
  );
  const same = records.filter((record) => record.name.toLowerCase() === hostname);
  if (same.length > 1)
    throw refused(`${hostname} has ${same.length} DNS records; remove the extra ones in the dashboard`);
  const body = { type: 'CNAME', name: hostname, content: target, proxied: true, ttl: 1 };
  const record: DnsRecord | undefined = same[0];
  if (!record) {
    if (dryRun)
      return {
        status: 'skipped',
        detail: `dry-run: would create the proxied CNAME ${hostname} -> ${target}`,
      };
    await withRight('Zone / DNS / Edit', () => api.post(collection, body));
    return { status: 'created', detail: `${hostname} -> ${target} (proxied)` };
  }
  if (record.type !== 'CNAME')
    throw refused(
      `${hostname} already has a ${record.type} record; it is not ours: remove it in the dashboard first`,
    );
  if (record.content.toLowerCase() !== target)
    throw refused(
      `${hostname} is a CNAME to ${record.content}, not to this tunnel; remove it in the dashboard first`,
    );
  if (record.proxied === true) return { status: 'unchanged', detail: `${hostname} -> ${target} (proxied)` };
  if (dryRun) return { status: 'skipped', detail: `dry-run: would make the CNAME ${hostname} proxied` };
  await withRight('Zone / DNS / Edit', () =>
    api.patch(`${collection}/${record.id}`, { proxied: true, ttl: 1 }),
  );
  return { status: 'updated', detail: `${hostname} is proxied now` };
}

export async function runPublish(context: CloudContext, options: PublishOptions): Promise<void> {
  const { config, report } = context;
  const { hostname, feedbackHostname } = config.cloudflare;
  if (options.feedback && !feedbackHostname)
    throw refused('--feedback needs cloudflare.feedbackHostname in the configuration');
  const api = cloudflareApi(context, options.dryRun);
  const names = namesOf(config);

  // Every precondition is checked before the first record is made.
  const account = await report.guard('cloudflare-account', async () => {
    const found = await resolveAccount(api, config);
    report.step('ok', 'cloudflare-account', found.name ?? found.id);
    return found;
  });
  const zone = await report.guard('zone', async () => {
    const found = await withRight('Zone / Zone / Edit (all zones from the account)', () =>
      findZone(api, config, account.id),
    );
    if (!found)
      throw refused(`the zone ${config.cloudflare.zone} does not exist; run "npm run cloud -- edge" first`);
    if (found.status !== 'active')
      throw refused(
        `the zone ${found.name} is ${found.status}, not active: move the DNS to Cloudflare first (docs/AWS.md "DNS move")`,
      );
    report.step('ok', 'zone', `${found.name} is active`);
    return found;
  });
  await report.run('access', async () => {
    // An application that is missing, or whose policy list is not exactly its own, must not be published.
    const problems = await verifyAccess(context, api, account.id);
    if (problems.length > 0)
      throw refused(`Access is not in place: ${problems.join('; ')}. Run "npm run cloud -- edge"`);
    return { status: 'ok', detail: 'both applications have exactly their own policies' };
  });
  const tunnel = await report.guard('tunnel', async () => {
    const found = await withRight('Account / Cloudflare Tunnel / Edit', () =>
      findTunnel(api, account.id, names.tunnel),
    );
    if (!found) throw refused(`the tunnel ${names.tunnel} does not exist; run "npm run cloud -- edge" first`);
    if (found.status !== 'healthy')
      throw refused(
        `the tunnel ${found.name} is ${found.status ?? 'of unknown status'}, not healthy: deploy the board and check "npm run cloud -- status"`,
      );
    report.step('ok', 'tunnel', `${found.name} is healthy`);
    return found;
  });

  const targets = [hostname];
  if (options.feedback && feedbackHostname) {
    await report.run('feedback-guard', async () => {
      const expected = `https://${feedbackHostname}`;
      if (readEnvFile(context.envFile).get('PROJECTMAN_FEEDBACK_PUBLIC_URL') !== expected)
        throw refused(
          `cloud.env does not have PROJECTMAN_FEEDBACK_PUBLIC_URL=${expected}; run "npm run cloud -- edge" and "npm run cloud -- deploy"`,
        );
      const answer = await readGuardCheck(context, feedbackHostname);
      if (answer.plain !== '404' || answer.port !== '404')
        throw refused(
          `the board answers the feedback hostname ${answer.plain} (plain) and ${answer.port} (with a port), not 404 twice: the feedback guard is not working on the machine; deploy the current release first`,
        );
      return { status: 'ok', detail: 'the machine answers 404 to the feedback hostname outside /feedback/' };
    });
    targets.push(feedbackHostname);
  }

  for (const target of targets)
    await report.run(`dns ${target}`, () =>
      publishRecord(context, api, zone, tunnel, target, options.dryRun),
    );
  if (!options.dryRun)
    report.line(`note: ${hostname} is public now; check it: "npm run cloud -- check --login-json <file>"`);
}
