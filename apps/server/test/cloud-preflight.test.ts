import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { ACCOUNT } from './helpers/fake-aws';
import { CloudflareWorld } from './helpers/fake-cloudflare';
import { EC2_CONFIG } from './helpers/fake-ec2';

/** `npm run cloud -- preflight`: the AWS part (PM-534) and the Cloudflare part (PM-536). */

let world: CloudflareWorld;
beforeEach(() => {
  world = new CloudflareWorld();
  world.writeConfig();
  world.writeBundle();
  world.writeToken();
});
afterEach(() => world.cleanup());

const preflight = () => runCloud(['preflight'], world.deps());

const AWS_LINES = (secretsDir: string) => [
  expect.stringMatching(
    /^ok image: source=\w{40} platform=linux\/arm64 archiveSha256=\w{64} imageId=sha256:\w{64}$/,
  ),
  'ok aws-cli: aws-cli/2.17.1',
  `ok aws-login: profile aroom, account ${ACCOUNT} (arn:aws:iam::${ACCOUNT}:user/aroom), region eu-west-1`,
  `available Ubuntu 24.04 arm64: ${EC2_CONFIG.amiId} ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-arm64-server-20261001`,
  `available subnet: ${EC2_CONFIG.subnetId} eu-west-1b, VPC ${EC2_CONFIG.vpcId}, state available`,
  `ok ec2-environment: ${EC2_CONFIG.amiId}, ${EC2_CONFIG.vpcId}/${EC2_CONFIG.subnetId}, eu-west-1b, direct public IPv4 egress`,
  'cost instance: t4g.small, Linux On-Demand in eu-west-1; running hours (730 hours/month if always on)',
  'cost EBS: encrypted gp3 40 GiB, baseline 3000 IOPS/125 MiB/s; charged while stopped too',
  'cost IPv4: one auto-assigned public IPv4, billed while allocated; no Elastic IP, NAT, load balancer or second machine',
  'cost other: internet data transfer, S3 storage/requests; burstable CPU credits are standard, with no unlimited-credit surcharge',
  'Review current regional rates before approval: https://aws.amazon.com/ec2/pricing/on-demand/ https://aws.amazon.com/ebs/pricing/ https://aws.amazon.com/vpc/pricing/',
  'ok aws-ec2: Ubuntu 24.04 arm64, public subnet, outbound only',
  `ok secrets-store: ${secretsDir} (directory 700, files 600)`,
];

describe('preflight', () => {
  it('lists Ubuntu 24.04 images, subnet choices and costs with no EC2 or DNS writes', async () => {
    expect(await preflight()).toBe(0);
    expect(world.output).toContain(`available Ubuntu 24.04 arm64: ${EC2_CONFIG.amiId}`);
    expect(world.output).toContain(`available subnet: ${EC2_CONFIG.subnetId} eu-west-1b`);
    expect(world.output).toContain('cost instance: t4g.small');
    expect(world.output).toContain('cost EBS: encrypted gp3 40 GiB');
    expect(world.output).toContain('cost IPv4: one');
    expect(world.aws.mutations()).toEqual([]);
    expect(world.cf.mutations()).toEqual([]);
    expect(world.aws.calls.some((call) => call.args[0] === 'route53domains')).toBe(false);
  });

  it('passes, prints the account and changes nothing', async () => {
    expect(await preflight()).toBe(0);
    expect(world.lines).toEqual([
      ...AWS_LINES(world.secretsDir),
      'ok cloudflare-token: active',
      'ok cloudflare-account: Owner account',
      'ok cloudflare-zero-trust: team janoist1',
      'ok cloudflare-tunnel: Account / Cloudflare Tunnel / Edit',
      'ok cloudflare-access-apps: Account / Access: Apps and Policies / Edit',
      'ok cloudflare-access-policies: Account / Access: Apps and Policies / Edit',
      'ok cloudflare-service-tokens: Account / Access: Service Tokens / Edit',
      'ok cloudflare-identity-providers: Account / Access: Organizations, Identity Providers, and Groups / Edit',
      'ok cloudflare-zones: Zone / Zone / Edit (all zones from the account)',
      'skipped cloudflare-dns: the zone example.com does not exist yet (edge creates it)',
      'skipped cloudflare-zone-settings: the zone example.com does not exist yet (edge creates it)',
      'skipped cloudflare-transform-rules: the zone example.com does not exist yet (edge creates it)',
      'note: a reading call proves a right to read only; edge names the right when a change is refused (docs/AWS.md)',
    ]);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.cf.mutations()).toEqual([]);
  });

  it('exits 2 when the aws CLI is version 1', async () => {
    world.aws.version = 'aws-cli/1.32.0 Python/3.11.0 Darwin/23.6.0 botocore/1.34.0';
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL aws-cli: the aws CLI must be version 2');
    expect(world.aws.calls.map((call) => call.args[0])).toEqual(['--version']);
  });

  it('exits 2 when the profile cannot log in, and asks no more AWS questions', async () => {
    world.aws.loginError =
      'Unable to locate credentials. You can configure credentials by running "aws configure".';
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL aws-login');
    expect(world.output).toContain('Unable to locate credentials');
    expect(world.aws.callsTo('get-regions')).toEqual([]);
    expect(world.output).toContain('ok secrets-store');
  });

  it('exits 2 when the secrets store has the wrong modes', async () => {
    chmodSync(world.secretsDir, 0o755);
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL secrets-store');
    expect(world.output).toContain('must be 700');
    expect(world.lines.filter((line) => line.startsWith('ok aws-'))).toHaveLength(3);
  });

  it('checks the Cloudflare token file too', async () => {
    const token = path.join(world.secretsDir, 'cloudflare-token');
    writeFileSync(token, 'token', { mode: 0o644 });
    chmodSync(token, 0o644);
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('cloudflare-token has mode 644');
  });
});

describe('preflight, the Cloudflare part', () => {
  const cloudflareLines = () => world.lines.filter((line) => /cloudflare-/.test(line));

  it('probes the zone rights too when the zone exists', async () => {
    world.cf.addZone('example.com');
    expect(await preflight()).toBe(0);
    expect(cloudflareLines().slice(-4)).toEqual([
      'ok cloudflare-zones: Zone / Zone / Edit (all zones from the account)',
      'ok cloudflare-dns: Zone / DNS / Edit',
      'ok cloudflare-zone-settings: Zone / Zone Settings / Edit',
      'ok cloudflare-transform-rules: Zone / Transform Rules / Edit',
    ]);
    expect(world.cf.mutations()).toEqual([]);
  });

  it('exits 2 without a token file, and asks Cloudflare nothing', async () => {
    const { rmSync } = await import('node:fs');
    rmSync(path.join(world.secretsDir, 'cloudflare-token'));
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL cloudflare-token');
    expect(world.output).toContain('skipped cloudflare-account: the token check failed');
    expect(world.cf.calls).toEqual([]);
  });

  it('exits 2 for a token that is not active', async () => {
    world.cf.tokenStatus = 'expired';
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL cloudflare-token: the API token is expired');
  });

  it('exits 2 for a token that Cloudflare does not accept', async () => {
    world.cf.expectedToken = 'another-token-0123456789';
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL cloudflare-token');
    expect(world.output).not.toContain('cf-api-token-value');
  });

  it('exits 2 when the account is not chosen and the token sees two', async () => {
    world.cf.accounts.push({ id: 'b'.repeat(32), name: 'Other' });
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL cloudflare-account: the API token sees 2 accounts');
    expect(world.output).toContain('skipped cloudflare-zero-trust');
  });

  it('exits 2 and describes the manual step when Zero Trust is not turned on', async () => {
    world.cf.organization = null;
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL cloudflare-zero-trust: this account has no Zero Trust organization');
    expect(world.output).toContain('docs/AWS.md');
    expect(world.output).toContain('ok cloudflare-tunnel');
  });

  it.each([
    ['cloudflare-tunnel', /\/cfd_tunnel/, 'Account / Cloudflare Tunnel / Edit'],
    ['cloudflare-service-tokens', /\/service_tokens/, 'Account / Access: Service Tokens / Edit'],
    ['cloudflare-zones', /^\/zones$/, 'Zone / Zone / Edit (all zones from the account)'],
  ])('names the right that is missing for %s', async (step, pattern, right) => {
    world.cf.denied = [pattern];
    expect(await preflight()).toBe(2);
    expect(world.output).toContain(`FAIL ${step}: the API token lacks the right "${right}"`);
  });
});
