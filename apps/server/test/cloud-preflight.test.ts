import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { ACCOUNT, CloudWorld } from './helpers/fake-aws';

/** `npm run cloud -- preflight`, the AWS part (PM-534). */

let world: CloudWorld;
beforeEach(() => {
  world = new CloudWorld();
  world.writeConfig();
});
afterEach(() => world.cleanup());

const preflight = () => runCloud(['preflight'], world.deps());

describe('preflight', () => {
  it('passes, prints the account and changes nothing', async () => {
    expect(await preflight()).toBe(0);
    expect(world.lines).toEqual([
      'ok aws-cli: aws-cli/2.17.1',
      `ok aws-login: profile i, account ${ACCOUNT} (arn:aws:iam::${ACCOUNT}:user/i)`,
      'ok aws-region: eu-west-1, eu-west-1a',
      'ok aws-bundle: small_3_0',
      'ok aws-blueprint: ubuntu_24_04',
      `ok secrets-store: ${world.secretsDir} (directory 700, files 600)`,
    ]);
    expect(world.aws.mutations()).toEqual([]);
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

  it('exits 2 for a region, a zone, a bundle or an image that does not exist or is not active', async () => {
    world.aws.regions = [{ name: 'eu-central-1', zones: ['eu-central-1a'] }];
    world.aws.bundles = [{ bundleId: 'small_3_0', isActive: false }];
    world.aws.blueprints = [];
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL aws-region: Lightsail has no region eu-west-1');
    expect(world.output).toContain('FAIL aws-bundle');
    expect(world.output).toContain('FAIL aws-blueprint');
  });

  it('exits 2 for an availability zone the region does not have', async () => {
    world.writeConfig({
      aws: {
        region: 'eu-west-1',
        availabilityZone: 'eu-west-1c',
        databaseBucket: 'aa-bb-cc',
        backupBucket: 'dd-ee-ff',
      },
    });
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL aws-region: eu-west-1c is not an availability zone');
  });

  it('exits 2 when the secrets store has the wrong modes', async () => {
    chmodSync(world.secretsDir, 0o755);
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('FAIL secrets-store');
    expect(world.output).toContain('must be 700');
    expect(world.lines.filter((line) => line.startsWith('ok '))).toHaveLength(5);
  });

  it('checks the Cloudflare token file too', async () => {
    const token = path.join(world.secretsDir, 'cloudflare-token');
    writeFileSync(token, 'token', { mode: 0o644 });
    chmodSync(token, 0o644);
    expect(await preflight()).toBe(2);
    expect(world.output).toContain('cloudflare-token has mode 644');
  });
});
