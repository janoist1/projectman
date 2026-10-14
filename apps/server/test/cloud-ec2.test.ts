import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import { ACCOUNT, baseConfig, CloudWorld, FOREIGN_ACCOUNT } from './helpers/fake-aws';
import { EC2_CONFIG } from './helpers/fake-ec2';

let world: CloudWorld;
const config = () => ({
  ...(baseConfig().aws as object),
  compute: 'ec2',
  profile: 'aroom',
  ec2: { ...EC2_CONFIG },
});
beforeEach(() => {
  world = new CloudWorld();
  world.aws.accounts.set('aroom', ACCOUNT);
  world.aws.accounts.set('i', FOREIGN_ACCOUNT);
  world.writeConfig({ aws: config(), route53: { profile: 'i' } });
});
afterEach(() => world.cleanup());
const run = (...args: string[]) => runCloud(['aws', ...args], world.deps());

describe('EC2 provisioning and the account boundary', () => {
  it('creates one protected EC2 instance in the central profile with a private backup scope', async () => {
    expect(await run()).toBe(0);
    expect(world.output).toContain(`profile aroom, account ${ACCOUNT}`);
    expect(
      world.aws.calls.every(
        (call) => call.argv.slice(0, 6).join(' ') === '--profile aroom --region eu-west-1 --output json',
      ),
    ).toBe(true);
    expect(world.aws.calls.some((call) => call.args[0] === 'lightsail')).toBe(false);
    const request = world.aws.ec2.request!;
    expect(request).toMatchObject({
      MinCount: 1,
      MaxCount: 1,
      InstanceType: 't3.small',
      ImageId: EC2_CONFIG.amiId,
      DisableApiTermination: true,
      InstanceInitiatedShutdownBehavior: 'stop',
      MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, HttpEndpoint: 'enabled' },
      CreditSpecification: { CpuCredits: 'standard' },
      NetworkInterfaces: [
        { AssociatePublicIpAddress: true, SubnetId: EC2_CONFIG.subnetId, Groups: ['sg-0123456789abcdef0'] },
      ],
      BlockDeviceMappings: [
        { Ebs: { Encrypted: true, VolumeType: 'gp3', VolumeSize: 40, Iops: 3000, Throughput: 125 } },
      ],
    });
    expect(request.ClientToken).toMatch(/^[a-f0-9]{64}$/);
    expect(request.TagSpecifications.map((entry: any) => entry.ResourceType)).toEqual([
      'instance',
      'volume',
      'network-interface',
    ]);
    expect(world.aws.ec2.groups[0]!.IpPermissions).toEqual([]);
    expect(world.aws.ec2.attached).toEqual(['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore']);
    expect(world.aws.ec2.profile!.Roles.map((role: any) => role.RoleName)).toEqual(['projectman-cloud-host']);
    for (const [name, bucket] of world.aws.buckets) {
      expect(bucket.owner).toBe(ACCOUNT);
      expect(Object.values(bucket.publicAccessBlock!)).toEqual([true, true, true, true]);
      expect(bucket.encryption).toMatchObject({
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
      });
      const suffix = name.endsWith('-db') ? 'litestream' : 'restic';
      const policy = world.aws.users.get(`projectman-cloud-${suffix}`)!.inline.get('bucket-access') as any;
      expect(policy.Statement.map((statement: any) => statement.Resource)).toEqual([
        `arn:aws:s3:::${name}`,
        `arn:aws:s3:::${name}/*`,
      ]);
    }
  });

  it('prints the three cost components before the expensive launch, and passes only public bootstrap in UserData', async () => {
    const original = world.deps();
    let previewAtLaunch = '';
    expect(
      await runCloud(
        ['aws'],
        world.deps({
          run: async (command, args, options) => {
            if (args[7] === 'run-instances') previewAtLaunch = world.output;
            return original.run(command, args, options);
          },
        }),
      ),
    ).toBe(0);
    expect(previewAtLaunch).toContain('cost instance: t3.small');
    expect(previewAtLaunch).toContain('cost EBS: encrypted gp3 40 GiB');
    expect(previewAtLaunch).toContain('cost IPv4: one');
    const data = world.aws.ec2.request!.UserData as string;
    // The CLI encodes this once on the wire. Pre-encoding would prevent cloud-init from seeing a script.
    expect(data.startsWith('#!/bin/bash\n')).toBe(true);
    expect(data).toContain('openssh-server ec2-instance-connect');
    expect(data).toContain('snap start --enable amazon-ssm-agent');
    for (const secret of [
      ...world.aws.issuedSecrets,
      'cloud.env',
      'ACCESS_KEY',
      'RESTIC_PASSWORD',
      'TUNNEL_TOKEN',
      'engine.key',
    ])
      expect(data).not.toContain(secret);
    expect(
      world.aws.calls.some(
        (call) =>
          call.args[0] === 'ssm' || /authorize-security-group-ingress|create-nat-gateway/.test(call.args[1]!),
      ),
    ).toBe(false);
  });

  it('converges after a process restart without writing again or creating a second instance', async () => {
    expect(await run()).toBe(0);
    const env = readFileSync(world.envFile, 'utf8');
    world.aws.clearCalls();
    expect(await run()).toBe(0);
    expect(world.aws.ec2.instances).toHaveLength(1);
    expect(world.aws.mutations()).toEqual([]);
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
    world.aws.ec2.instances[0]!.State.Name = 'stopped';
    delete world.aws.ec2.instances[0]!.PublicIpAddress;
    world.aws.clearCalls();
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('recovers a launch whose CLI response was lost by rediscovering the tagged instance', async () => {
    world.aws.ec2.loseLaunchResponse = true;
    expect(await run()).toBe(1);
    expect(world.aws.ec2.instances).toHaveLength(1);
    world.aws.clearCalls();
    expect(await run()).toBe(0);
    expect(world.aws.callsTo('run-instances')).toHaveLength(0);
    expect(world.aws.ec2.instances).toHaveLength(1);
  });

  it('retries IAM propagation with exactly the same deterministic token and launch request', async () => {
    world.aws.ec2.profilePropagationFailures = 2;
    expect(await run()).toBe(0);
    const calls = world.aws.callsTo('run-instances');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.args.at(-1))).size).toBe(1);
    expect(world.aws.ec2.instances).toHaveLength(1);
  });

  it('accepts Canonical AMI ephemeral mappings in any order and launches one persistent root EBS disk', async () => {
    world.aws.ec2.image.BlockDeviceMappings.reverse();
    expect(await run()).toBe(0);
    expect(world.aws.ec2.request!.BlockDeviceMappings).toHaveLength(1);
    expect(world.aws.ec2.request!.BlockDeviceMappings[0]).toMatchObject({
      DeviceName: '/dev/sda1',
      Ebs: { VolumeSize: 40, Encrypted: true, VolumeType: 'gp3' },
    });
    world.aws.clearCalls();
    expect(await run()).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('waits for the tagged security group to be visible before launching, without creating it twice', async () => {
    world.aws.ec2.groupVisibilityPolls = 3;
    expect(await run()).toBe(0);
    expect(world.aws.callsTo('create-security-group')).toHaveLength(1);
    expect(world.aws.callsTo('run-instances')).toHaveLength(1);
    const calls = world.aws.calls;
    const created = calls.findIndex((call) => call.args[1] === 'create-security-group');
    const launched = calls.findIndex((call) => call.args[1] === 'run-instances');
    expect(
      calls.slice(created + 1, launched).filter((call) => call.args[1] === 'describe-security-groups'),
    ).toHaveLength(4);
  });

  it('stops safely if the new security group stays invisible and rediscovers it on a later run', async () => {
    world.aws.ec2.groupVisibilityPolls = 100;
    expect(await run()).toBe(1);
    expect(world.output).toContain('security group is not visible yet');
    expect(world.aws.callsTo('run-instances')).toHaveLength(0);
    world.aws.ec2.groupVisibilityPolls = 0;
    expect(await run()).toBe(0);
    expect(world.aws.callsTo('create-security-group')).toHaveLength(1);
    expect(world.aws.ec2.instances).toHaveLength(1);
  });

  it('retries launch-time security group propagation with an identical request and ClientToken', async () => {
    world.aws.ec2.groupPropagationFailures = 2;
    expect(await run()).toBe(0);
    const calls = world.aws.callsTo('run-instances');
    expect(calls).toHaveLength(3);
    expect(new Set(calls.map((call) => call.args.at(-1))).size).toBe(1);
    expect(world.aws.ec2.instances).toHaveLength(1);
  });

  it('waits for a pending launch to reveal disk drift before filling missing IAM permissions', async () => {
    expect(await run()).toBe(0);
    world.aws.ec2.instances[0]!.State.Name = 'pending';
    world.aws.ec2.pendingPolls = 2;
    world.aws.ec2.attached = [];
    world.aws.ec2.volume!.Size = 80;
    world.aws.clearCalls();
    expect(await run()).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.aws.callsTo('describe-instances').length).toBeGreaterThan(1);
  });

  it.each([
    'create-instance-profile',
    'add-role-to-instance-profile',
    'create-security-group',
    'run-instances',
    'create-bucket',
  ])('recovers an interruption at %s', async (operation) => {
    if (operation === 'create-bucket') {
      const original = world.deps();
      let failed = false;
      expect(
        await runCloud(
          ['aws'],
          world.deps({
            run: async (command, args, options) => {
              if (!failed && args[7] === operation) {
                failed = true;
                return { code: 254, stdout: '', stderr: 'injected failure' };
              }
              return original.run(command, args, options);
            },
          }),
        ),
      ).toBe(1);
    } else {
      world.aws.ec2.failOnce = operation;
      expect(await run()).toBe(1);
    }
    expect(await run()).toBe(0);
    expect(world.aws.ec2.instances).toHaveLength(1);
    expect(world.aws.users.size).toBe(2);
  });

  it('dry-run performs no AWS or local writes, for missing and already existing resources', async () => {
    expect(await run('--dry-run')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(existsSync(world.envFile)).toBe(false);
    expect(await run()).toBe(0);
    writeFileSync(world.envFile, `${readFileSync(world.envFile, 'utf8')}OTHER_SECRET=keep-this-private\n`);
    const env = readFileSync(world.envFile, 'utf8');
    world.aws.clearCalls();
    expect(await run('--dry-run', '--rotate-keys')).toBe(0);
    expect(world.aws.mutations()).toEqual([]);
    expect(readFileSync(world.envFile, 'utf8')).toBe(env);
    expect(world.output).not.toContain('keep-this-private');
  });

  it.each([
    [
      'wrong AMI owner',
      (fake: typeof world.aws.ec2) => {
        fake.image.OwnerId = FOREIGN_ACCOUNT;
      },
    ],
    [
      'missing root EBS mapping',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings.shift();
      },
    ],
    [
      'extra persistent AMI disk',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings.push({ DeviceName: '/dev/sdd', Ebs: { VolumeSize: 20 } });
      },
    ],
    [
      'duplicate root AMI mapping',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings.push(structuredClone(fake.image.BlockDeviceMappings[0]!));
      },
    ],
    [
      'oversized AMI root disk',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings[0]!.Ebs!.VolumeSize = 80;
      },
    ],
    [
      'unknown AMI virtual device',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings[1]!.VirtualName = 'unexpected';
      },
    ],
    [
      'ambiguous EBS/ephemeral mapping',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings[0]!.VirtualName = 'ephemeral2';
      },
    ],
    [
      'duplicate ephemeral AMI device',
      (fake: typeof world.aws.ec2) => {
        fake.image.BlockDeviceMappings[2]!.VirtualName = 'ephemeral0';
      },
    ],
    [
      'foreign network owner',
      (fake: typeof world.aws.ec2) => {
        fake.networkOwner = FOREIGN_ACCOUNT;
      },
    ],
    [
      'ARM AMI',
      (fake: typeof world.aws.ec2) => {
        fake.image.Architecture = 'arm64';
      },
    ],
    [
      'wrong OS',
      (fake: typeof world.aws.ec2) => {
        fake.image.Name = 'ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-20261001';
      },
    ],
    [
      'another VPC',
      (fake: typeof world.aws.ec2) => {
        fake.subnet.VpcId = 'vpc-fffffffffffffffff';
      },
    ],
    [
      'NAT route',
      (fake: typeof world.aws.ec2) => {
        fake.route.GatewayId = 'nat-0123456789abcdef0';
      },
    ],
    [
      'blackhole route',
      (fake: typeof world.aws.ec2) => {
        fake.route.State = 'blackhole';
      },
    ],
    [
      'detached gateway',
      (fake: typeof world.aws.ec2) => {
        fake.gatewayAttached = false;
      },
    ],
    [
      'blocked ACL',
      (fake: typeof world.aws.ec2) => {
        fake.aclAllowsInternet = false;
      },
    ],
    [
      'no DNS',
      (fake: typeof world.aws.ec2) => {
        fake.dnsSupport = false;
      },
    ],
    [
      'ARM type',
      (fake: typeof world.aws.ec2) => {
        fake.architecture = 'arm64';
      },
    ],
    [
      'type unavailable in AZ',
      (fake: typeof world.aws.ec2) => {
        fake.offerings = false;
      },
    ],
  ])('refuses %s before any writes', async (_name, alter) => {
    alter(world.aws.ec2);
    expect(await run()).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
  });

  it.each([
    [
      'ambiguous instance',
      (fake: typeof world.aws.ec2) => {
        fake.instances.push(structuredClone(fake.instances[0]!));
      },
    ],
    [
      'foreign reservation owner',
      (fake: typeof world.aws.ec2) => {
        fake.reservationOwner = FOREIGN_ACCOUNT;
      },
    ],
    [
      'unmanaged instance',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.Tags = [];
      },
    ],
    [
      'different instance VPC',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.VpcId = 'vpc-fffffffffffffffff';
      },
    ],
    [
      'different image',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.ImageId = 'ami-fffffffffffffffff';
      },
    ],
    [
      'different disk size',
      (fake: typeof world.aws.ec2) => {
        fake.volume!.Size = 80;
      },
    ],
    [
      'unencrypted disk',
      (fake: typeof world.aws.ec2) => {
        fake.volume!.Encrypted = false;
      },
    ],
    [
      'wrong disk type',
      (fake: typeof world.aws.ec2) => {
        fake.volume!.VolumeType = 'gp2';
      },
    ],
    [
      'paid extra performance',
      (fake: typeof world.aws.ec2) => {
        fake.volume!.Iops = 6000;
      },
    ],
    [
      'wide ingress',
      (fake: typeof world.aws.ec2) => {
        fake.groups[0]!.IpPermissions = [{ IpProtocol: '-1', IpRanges: [{ CidrIp: '0.0.0.0/0' }] }];
      },
    ],
    [
      'foreign group',
      (fake: typeof world.aws.ec2) => {
        fake.groups[0]!.OwnerId = FOREIGN_ACCOUNT;
      },
    ],
    [
      'duplicate group',
      (fake: typeof world.aws.ec2) => {
        fake.groups.push(structuredClone(fake.groups[0]!));
      },
    ],
    [
      'unmanaged role',
      (fake: typeof world.aws.ec2) => {
        fake.role!.Tags = [];
      },
    ],
    [
      'other trust',
      (fake: typeof world.aws.ec2) => {
        fake.role!.AssumeRolePolicyDocument.Statement[0].Principal = { AWS: '*' };
      },
    ],
    [
      'extra host policy',
      (fake: typeof world.aws.ec2) => {
        fake.attached.push('arn:aws:iam::aws:policy/AdministratorAccess');
      },
    ],
    [
      'inline host policy',
      (fake: typeof world.aws.ec2) => {
        fake.inline.push('unexpected');
      },
    ],
    [
      'other instance profile role',
      (fake: typeof world.aws.ec2) => {
        fake.profile!.Roles = [{ ...fake.role!, Arn: `arn:aws:iam::${FOREIGN_ACCOUNT}:role/stranger` }];
      },
    ],
    [
      'IMDSv1',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.MetadataOptions.HttpTokens = 'optional';
      },
    ],
    [
      'extra network interface',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.NetworkInterfaces.push(structuredClone(fake.instances[0]!.NetworkInterfaces[0]));
      },
    ],
    [
      'terminated instance',
      (fake: typeof world.aws.ec2) => {
        fake.instances[0]!.State.Name = 'terminated';
      },
    ],
    [
      'no termination protection',
      (fake: typeof world.aws.ec2) => {
        fake.terminationProtection = false;
      },
    ],
  ])('refuses existing resource drift: %s, with no repair or replacement', async (_name, alter) => {
    expect(await run()).toBe(0);
    alter(world.aws.ec2);
    world.aws.clearCalls();
    expect(await run()).toBe(2);
    expect(world.aws.mutations()).toEqual([]);
  });

  it('rejects malformed AWS JSON before creation', async () => {
    const original = world.deps();
    expect(
      await runCloud(
        ['aws'],
        world.deps({
          run: async (command, args, options) =>
            args[7] === 'describe-instances'
              ? {
                  code: 0,
                  stdout: JSON.stringify({ Reservations: [{ Instances: [{ InstanceId: 'unexpected' }] }] }),
                  stderr: '',
                }
              : original.run(command, args, options),
        }),
      ),
    ).toBe(1);
    expect(world.aws.mutations()).toEqual([]);
    expect(world.output).toContain('unexpected shape');
  });
});
