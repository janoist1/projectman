import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { defaultConfigPath, loadConfig, parseConfig } from '../../../scripts/cloud/config';
import { baseConfig, CloudWorld } from './helpers/fake-aws';
import { EC2_CONFIG } from './helpers/fake-ec2';

/** The configuration file of the cloud commands (PM-534). */

const HOME = '/home/owner';

function config(patch: (value: Record<string, any>) => void): unknown {
  const value = structuredClone(baseConfig()) as Record<string, any>;
  patch(value);
  return value;
}

/** The message of the refusal, with the field paths in it. */
function refusal(raw: unknown): string {
  try {
    parseConfig(raw, HOME);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the configuration was accepted');
}

describe('the defaults', () => {
  it('fills in everything that is not given', () => {
    const parsed = parseConfig(baseConfig(), HOME);
    expect(parsed).toEqual({
      version: 1,
      aws: {
        compute: 'ec2',
        profile: 'aroom',
        region: 'eu-west-1',
        availabilityZone: 'eu-west-1a',
        instanceName: 'projectman-cloud',
        ec2: { ...EC2_CONFIG, architecture: 'arm64' },
        databaseBucket: 'acme-projectman-db',
        backupBucket: 'acme-projectman-backup',
      },
      deployment: { imageSource: 'bundle', imageBundle: expect.stringMatching(/\/bundle$/) },
      repository: { url: 'https://github.com/janoist1/projectman.git' },
      cloudflare: {
        tokenFile: '/home/owner/.config/projectman/cloud/cloudflare-token',
        zone: 'example.com',
        hostname: 'board.example.com',
        tunnelName: 'projectman-cloud',
      },
      access: {
        emails: ['owner@example.com'],
        owners: [],
        sessionDuration: '24h',
        integratorServiceToken: false,
        boardMode: 'private',
      },
      route53: { profile: 'aroom' },
    });
  });

  it('refuses a stored Lightsail compute with a message that says what to set', () => {
    const message = refusal(
      config((value) => {
        value.aws.compute = 'lightsail';
      }),
    );
    expect(message).toContain('aws.compute');
    expect(message).toContain('Lightsail is no longer supported');
    expect(message).toContain('"ec2"');
  });

  it('refuses any other compute value', () => {
    const message = refusal(
      config((value) => {
        value.aws.compute = 'fargate';
      }),
    );
    expect(message).toContain('aws.compute');
    expect(message).toContain('must be "ec2"');
  });

  it('takes the tunnel name from the instance name, and expands ~/ in the token file', () => {
    const parsed = parseConfig(
      config((value) => {
        value.aws.instanceName = 'board';
        value.cloudflare.tokenFile = '~/secrets/cf';
      }),
      HOME,
    );
    expect(parsed.cloudflare.tunnelName).toBe('board');
    expect(parsed.cloudflare.tokenFile).toBe('/home/owner/secrets/cf');
  });

  it('keeps the file in the secrets directory by default', () => {
    expect(defaultConfigPath(HOME)).toBe('/home/owner/.config/projectman/cloud/config.json');
  });
});

describe('the validation', () => {
  it('requires explicit, distinct integrator hostnames and a service token', () => {
    const configured = config((value) => {
      value.cloudflare.integratorHostname = 'machine.example.com';
      value.access.integratorServiceToken = true;
    });
    expect(parseConfig(configured, HOME).cloudflare.integratorHostname).toBe('machine.example.com');
    for (const hostname of [
      'board.example.com',
      '*.example.com',
      'x.y.example.com',
      'machine.example.com:443',
      'MACHINE.example.com',
    ])
      expect(
        refusal(
          config((value) => {
            value.cloudflare.integratorHostname = hostname;
            value.access.integratorServiceToken = true;
          }),
        ),
      ).toContain('cloudflare.integratorHostname');
    expect(
      refusal(
        config((value) => {
          value.cloudflare.integratorHostname = 'machine.example.com';
        }),
      ),
    ).toContain('access.integratorServiceToken');
    expect(
      refusal(
        config((value) => {
          value.access.integratorServiceToken = true;
          value.access.boardMode = 'public';
        }),
      ),
    ).toContain('cloudflare.integratorHostname');
  });
  it('requires a bundle for the machine without requiring built files during config parsing', () => {
    const raw = config((value) => {
      delete value.deployment;
    });
    expect(refusal(raw)).toContain('deployment.imageBundle');
    const withBundle = { ...(raw as object), deployment: { imageBundle: './not-built-yet' } };
    expect(parseConfig(withBundle, HOME, '/config/cloud').deployment?.imageBundle).toBe(
      '/config/cloud/not-built-yet',
    );
    expect(refusal({ ...withBundle, deployment: { imageBundle: ' ' } })).toContain('deployment.imageBundle');
    expect(refusal({ ...withBundle, deployment: { imageBundle: 'bundle', registry: 'refused' } })).toContain(
      'deployment',
    );
  });
  it('takes the image from GitHub without a local bundle, and keeps the bundle source the default (PM-1154)', () => {
    const raw = config((value) => {
      delete value.deployment;
    });
    const github = parseConfig({ ...(raw as object), deployment: { imageSource: 'github' } }, HOME, '/c');
    expect(github.deployment).toEqual({ imageSource: 'github' });
    expect(refusal({ ...(raw as object), deployment: { imageSource: 'bundle' } })).toContain(
      'deployment.imageBundle',
    );
    expect(refusal({ ...(raw as object), deployment: { imageSource: 'registry' } })).toContain(
      'deployment.imageSource',
    );
  });
  it.each([undefined, 'i', ''])('refuses EC2 profile %s before any AWS call', async (profile) => {
    const world = new CloudWorld();
    try {
      world.writeConfig({
        aws: { ...(baseConfig().aws as object), compute: 'ec2', profile, ec2: EC2_CONFIG },
      });
      expect(await runCloud(['aws'], world.deps())).toBe(2);
      expect(world.output).toContain('aws.profile');
      expect(world.aws.calls).toEqual([]);
    } finally {
      world.cleanup();
    }
  });

  it('accepts explicit EC2 settings and independent registrar credentials', () => {
    const parsed = parseConfig(
      config((value) => {
        value.aws = { ...value.aws, compute: 'ec2', profile: 'aroom', ec2: EC2_CONFIG };
        value.route53 = { profile: 'i' };
      }),
      HOME,
    );
    expect(parsed.aws.ec2).toEqual({ ...EC2_CONFIG, architecture: 'arm64' });
    expect(parsed.route53.profile).toBe('i');
    expect(
      parseConfig(
        config((value) => {
          value.aws = { ...value.aws, compute: 'ec2', profile: 'central-test', ec2: EC2_CONFIG };
        }),
        HOME,
      ).aws.profile,
    ).toBe('central-test');
    expect(
      parseConfig(
        config((value) => {
          value.aws.profile = 'another';
        }),
        HOME,
      ).route53.profile,
    ).toBe('another');
  });

  it('requires the entire EC2 choice with no implicit size, AMI, network or disk defaults', () => {
    expect(
      refusal(
        config((value) => {
          delete value.aws.ec2;
        }),
      ),
    ).toContain('aws.ec2');
    for (const field of Object.keys(EC2_CONFIG)) {
      const message = refusal(
        config((value) => {
          value.aws.compute = 'ec2';
          value.aws.profile = 'aroom';
          value.aws.ec2 = { ...EC2_CONFIG };
          delete value.aws.ec2[field];
        }),
      );
      expect(message).toContain(`aws.ec2.${field}`);
    }
  });

  it.each([
    ['instanceType', 't3.small --debug'],
    ['instanceType', 'a'.repeat(65)],
    ['amiId', 'ami-NOTHEX123'],
    ['vpcId', 'vpc-123'],
    ['subnetId', 'subnet-123456789'],
    ['volumeGiB', 19],
    ['volumeGiB', 1025],
    ['volumeGiB', 40.5],
  ])('refuses malformed EC2 %s: %s', (field, value) => {
    expect(
      refusal(
        config((raw) => {
          raw.aws.compute = 'ec2';
          raw.aws.profile = 'aroom';
          raw.aws.ec2 = { ...EC2_CONFIG, [field]: value };
        }),
      ),
    ).toContain(`aws.ec2.${field}`);
  });

  it('names the path of every wrong field', () => {
    const message = refusal(
      config((value) => {
        value.aws.region = 'Europe';
        value.aws.databaseBucket = 'has.dots.in.it';
        value.cloudflare.accountId = 'xyz';
        value.access.sessionDuration = 'forever';
      }),
    );
    expect(message).toContain('aws.region');
    expect(message).toContain('aws.databaseBucket');
    expect(message).toContain('cloudflare.accountId');
    expect(message).toContain('access.sessionDuration');
  });

  it('needs the region, the buckets, the zone, the hostname and one e-mail address', () => {
    const message = refusal({ version: 1, aws: {}, cloudflare: {}, access: { emails: [] } });
    for (const field of [
      'aws.region',
      'aws.databaseBucket',
      'aws.backupBucket',
      'cloudflare.zone',
      'cloudflare.hostname',
      'access.emails',
    ])
      expect(message).toContain(field);
  });

  it('takes an optional release target (PM-749), and a file without one parses as before', () => {
    expect(parseConfig(baseConfig(), HOME)).not.toHaveProperty('releaseTarget');
    const target = { projectKey: 'PM', repo: 'projectman' };
    expect(
      parseConfig(
        config((value) => (value.releaseTarget = target)),
        HOME,
      ).releaseTarget,
    ).toEqual(target);
  });

  it.each([
    ['a lowercase project key', { projectKey: 'pm', repo: 'projectman' }],
    ['a project key with a slash', { projectKey: 'P/M', repo: 'projectman' }],
    ['a repository with a slash', { projectKey: 'PM', repo: 'a/b' }],
    ['a repository with upper case', { projectKey: 'PM', repo: 'ProjectMan' }],
    ['a repository with a space', { projectKey: 'PM', repo: 'project man' }],
    ['a line break', { projectKey: 'PM', repo: 'projectman\nEVIL=1' }],
    ['an empty repository', { projectKey: 'PM', repo: '' }],
    ['a missing repository', { projectKey: 'PM' }],
    ['another field', { projectKey: 'PM', repo: 'projectman', branch: 'main' }],
    ['a string', 'PM/projectman'],
  ])('refuses a release target with %s', (_name, target) => {
    expect(refusal(config((value) => (value.releaseTarget = target)))).toContain('releaseTarget');
  });

  it('takes an optional hybrid binding (PM-752) for compatibility', () => {
    const target = { projectKey: 'PM', repo: 'projectman' };
    const hybrid = { engineId: 'eng_abcdefghijkl', targetHash: 'a'.repeat(64) };
    expect(parseConfig(baseConfig(), HOME)).not.toHaveProperty('hybrid');
    expect(
      parseConfig(
        config((value) => {
          value.releaseTarget = target;
          value.hybrid = hybrid;
        }),
        HOME,
      ).hybrid,
    ).toEqual(hybrid);
    expect(
      parseConfig(
        config((value) => (value.hybrid = hybrid)),
        HOME,
      ).hybrid,
    ).toEqual(hybrid);
    for (const bad of [
      { ...hybrid, engineId: 'local' },
      { ...hybrid, targetHash: 'abc' },
      { ...hybrid, extra: 1 },
      { engineId: hybrid.engineId },
    ])
      expect(
        refusal(
          config((value) => {
            value.releaseTarget = target;
            value.hybrid = bad;
          }),
        ),
      ).toContain('hybrid');
  });

  it('refuses an unknown field and a wrong version', () => {
    expect(refusal(config((value) => (value.aws.size = 'large')))).toContain('aws');
    expect(refusal(config((value) => (value.extra = true)))).toContain('extra');
    expect(refusal(config((value) => (value.version = 2)))).toContain('version');
  });

  it('wants two different buckets, without dots, by the S3 rules', () => {
    expect(refusal(config((value) => (value.aws.backupBucket = value.aws.databaseBucket)))).toContain(
      'aws.backupBucket: must differ',
    );
    for (const name of [
      'ab',
      'Upper-case',
      'dotted.name',
      '-leading',
      'trailing-',
      'xn--punycode',
      '192-168-1-1',
      'a'.repeat(64),
    ])
      expect(refusal(config((value) => (value.aws.databaseBucket = name)))).toContain('aws.databaseBucket');
  });

  it('wants the zone in the region and the names to fit AWS', () => {
    expect(refusal(config((value) => (value.aws.availabilityZone = 'us-east-1a')))).toContain(
      'availabilityZone',
    );
    expect(refusal(config((value) => (value.aws.instanceName = 'has space')))).toContain('instanceName');
    expect(refusal(config((value) => (value.aws.instanceName = 'x'.repeat(51))))).toContain('instanceName');
    expect(
      refusal(config((value) => (value.repository = { url: 'http://insecure.example/x.git' }))),
    ).toContain('repository.url');
  });

  it('wants a first-level hostname in the zone, and a different feedback hostname', () => {
    expect(refusal(config((value) => (value.cloudflare.hostname = 'a.b.example.com')))).toContain(
      'cloudflare.hostname',
    );
    expect(refusal(config((value) => (value.cloudflare.hostname = 'board.other.org')))).toContain(
      'cloudflare.hostname',
    );
    expect(refusal(config((value) => (value.cloudflare.hostname = 'example.com')))).toContain(
      'cloudflare.hostname',
    );
    expect(refusal(config((value) => (value.cloudflare.feedbackHostname = 'board.example.com')))).toContain(
      'feedbackHostname: must differ',
    );
    expect(refusal(config((value) => (value.cloudflare.feedbackHostname = 'x.y.example.com')))).toContain(
      'feedbackHostname',
    );
    expect(() =>
      parseConfig(
        config((value) => (value.cloudflare.feedbackHostname = 'feedback.example.com')),
        HOME,
      ),
    ).not.toThrow();
  });

  it('wants exact e-mail addresses, lowercased and unique', () => {
    expect(
      parseConfig(
        config((value) => (value.access.emails = [' A@Example.com ', 'b@example.com'])),
        HOME,
      ).access.emails,
    ).toEqual(['a@example.com', 'b@example.com']);
    expect(refusal(config((value) => (value.access.emails = ['*@example.com'])))).toContain(
      'access.emails.0',
    );
    expect(refusal(config((value) => (value.access.emails = ['not-an-address'])))).toContain(
      'access.emails.0',
    );
    expect(refusal(config((value) => (value.access.emails = ['a@example.com', 'A@EXAMPLE.com'])))).toContain(
      'access.emails.1: a@example.com is listed twice',
    );
  });

  describe('the further owners (PM-1065)', () => {
    const withOwners = (owners: unknown[], patch: (value: Record<string, any>) => void = () => undefined) =>
      config((value) => {
        value.cloudflare.integratorHostname = 'machine.example.com';
        value.access.integratorServiceToken = true;
        value.access.owners = owners;
        patch(value);
      });
    const alpha = { id: 'alpha', name: 'Alpha Ltd', email: 'Alpha@Example.com' };

    it('takes an owner with an id, a name and a lowercased e-mail address', () => {
      expect(parseConfig(withOwners([alpha]), HOME).access.owners).toEqual([
        { id: 'alpha', name: 'Alpha Ltd', email: 'alpha@example.com' },
      ]);
    });

    it.each([
      [
        'an id listed twice',
        [alpha, { ...alpha, name: 'Other' }],
        undefined,
        'access.owners.1.id: alpha is listed twice',
      ],
      ['an id that is not a handle', [{ ...alpha, id: 'Alpha_1' }], undefined, 'access.owners.0.id'],
      [
        'a private board without the owner’s address',
        [{ id: 'alpha', name: 'Alpha Ltd' }],
        undefined,
        'access.owners.0.email: required in private board mode',
      ],
      [
        'no integrator hostname',
        [alpha],
        (value: Record<string, any>) => {
          delete value.cloudflare.integratorHostname;
          value.access.integratorServiceToken = false;
        },
        'cloudflare.integratorHostname: required with access.owners',
      ],
    ])('refuses %s', (_what, owners, patch, message) => {
      expect(refusal(withOwners(owners, patch))).toContain(message);
    });
  });

  it('takes the board mode (PM-672): private by default, public only with the ses block', () => {
    expect(
      parseConfig(
        config((value) => {
          value.aws.profile = 'aroom';
          value.ses = { region: 'eu-west-1', domain: 'example.com', from: 'board@example.com' };
          value.access.boardMode = 'public';
        }),
        HOME,
      ).access.boardMode,
    ).toBe('public');
    expect(refusal(config((value) => (value.access.boardMode = 'public')))).toContain('access.boardMode');
    expect(refusal(config((value) => (value.access.boardMode = 'open')))).toContain('access.boardMode');
  });

  describe('the SES profile (PM-729)', () => {
    const ses = { region: 'eu-west-1', domain: 'example.com', from: 'board@example.com' };
    const withSes = (profile: unknown, awsProfile?: string) =>
      config((value) => {
        if (awsProfile) value.aws.profile = awsProfile;
        value.ses = profile === undefined ? ses : { ...ses, profile };
      });

    it('falls back to aws.profile, so an old configuration resolves to the same target', () => {
      expect(parseConfig(withSes(undefined, 'aroom'), HOME).ses).toEqual({ ...ses, profile: 'aroom' });
      expect(parseConfig(withSes(undefined), HOME).ses).toEqual({ ...ses, profile: 'aroom' });
    });

    it('takes an explicit profile, including the registrar profile i beside another aws.profile', () => {
      expect(parseConfig(withSes('i', 'aroom'), HOME).ses?.profile).toBe('i');
      expect(parseConfig(withSes('other', 'aroom'), HOME).ses?.profile).toBe('other');
      expect(parseConfig(withSes('i', 'aroom'), HOME).aws.profile).toBe('aroom');
    });

    it.each(['', '   ', null, 7])('refuses the profile %j on its own path', (profile) => {
      expect(refusal(withSes(profile, 'aroom'))).toContain('ses.profile');
    });

    it('keeps SES off without a block and keeps the EC2 compute profile rule', () => {
      expect(parseConfig(baseConfig(), HOME).ses).toBeUndefined();
      const ec2 = (profile: string | undefined) =>
        config((value) => {
          value.aws = { ...value.aws, compute: 'ec2', profile, ec2: EC2_CONFIG };
          value.ses = { ...ses, profile: 'i' };
        });
      expect(refusal(ec2(undefined))).toContain('aws.profile');
      expect(refusal(ec2('i'))).toContain('aws.profile');
      expect(parseConfig(ec2('aroom'), HOME).ses?.profile).toBe('i');
    });
  });

  it('checks the hosted zone id and the session duration', () => {
    expect(refusal(config((value) => (value.route53 = { hostedZoneId: 'nope' })))).toContain(
      'route53.hostedZoneId',
    );
    expect(
      parseConfig(
        config((value) => (value.route53 = { hostedZoneId: 'Z0123456789ABC' })),
        HOME,
      ).route53.hostedZoneId,
    ).toBe('Z0123456789ABC');
    expect(
      parseConfig(
        config((value) => (value.access.sessionDuration = '30m')),
        HOME,
      ).access.sessionDuration,
    ).toBe('30m');
  });
});

describe('the command line', () => {
  let world: CloudWorld;
  beforeEach(() => {
    world = new CloudWorld();
  });
  afterEach(() => world.cleanup());

  it('exits 2 when there is no configuration file, and says where it looked', async () => {
    expect(await runCloud(['preflight'], world.deps())).toBe(2);
    expect(world.output).toContain(world.configFile);
    expect(world.aws.calls).toEqual([]);
  });

  it('exits 2 on a wrong field and names its path; nothing is called', async () => {
    const file = world.writeConfig({
      aws: { region: 'nowhere', databaseBucket: 'a-b-c', backupBucket: 'd-e-f' },
    });
    expect(await runCloud(['aws', '--config', file], world.deps())).toBe(2);
    expect(world.output).toContain('aws.region');
    expect(world.aws.calls).toEqual([]);
  });

  it('exits 2 on a file that is not JSON', async () => {
    world.writeConfig();
    writeFileSync(world.configFile, '{ nope');
    expect(await runCloud(['preflight'], world.deps())).toBe(2);
    expect(world.output).toContain('not valid JSON');
  });

  it('reads the file --config names, with or without =', async () => {
    const elsewhere = path.join(world.home, 'elsewhere.json');
    writeFileSync(elsewhere, JSON.stringify(baseConfig()));
    expect(loadConfig(elsewhere, world.home).aws.region).toBe('eu-west-1');
    expect(await runCloud(['aws', '--dry-run', '--config', elsewhere], world.deps())).toBe(0);
    expect(await runCloud(['aws', '--dry-run', `--config=${elsewhere}`], world.deps())).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('exits 64 on bad usage', async () => {
    world.writeConfig();
    for (const argv of [
      [],
      ['unknown'],
      ['aws', '--nope'],
      ['aws', 'extra'],
      ['preflight', '--dry-run'],
      ['preflight', '--rotate-keys'],
      ['aws', '--config'],
      ['aws', '--dry-run=yes'],
    ]) {
      world.errors.length = 0;
      expect(await runCloud(argv, world.deps()), argv.join(' ')).toBe(64);
      expect(world.errors.join('\n')).toContain('usage:');
    }
    expect(world.aws.calls).toEqual([]);
  });

  it('prints the usage for help and exits 0', async () => {
    expect(await runCloud(['--help'], world.deps())).toBe(0);
    expect(world.output).toContain('npm run cloud');
  });
});
