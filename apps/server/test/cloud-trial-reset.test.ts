import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCloud } from '../../../scripts/cloud/commands';
import type { RunOptions, RunResult } from '../../../scripts/cloud/deps';
import {
  trialInventory,
  trialResetPlanSchema,
  trialResetResultSchema,
} from '../../../scripts/cloud/trial-reset';
import { ACCOUNT } from './helpers/fake-aws';
import { EC2_CONFIG } from './helpers/fake-ec2';
import { EC2_HOST_ID, Ec2HostWorld } from './helpers/fake-ec2-host';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const ok = (v: unknown = {}): RunResult => ({ code: 0, stdout: JSON.stringify(v), stderr: '' });
const error = (code: string): RunResult => ({
  code: 254,
  stdout: '',
  stderr: `An error occurred (${code}) when calling AWS: secret-key-name FAKE-CREDENTIAL https://sensitive.invalid`,
});
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
const db = 'acme-projectman-db';
const backup = 'acme-projectman-backup';
type Item = { Key: string; ETag: string; Size: number; LastModified: string };
const item = (key: string): Item => ({
  Key: key,
  ETag: `"${sha(key)}"`,
  Size: 10,
  LastModified: '2026-10-15T23:00:00+00:00',
});

let world: Ec2HostWorld;
let directory: string, plans: string, planFile: string;
let state: ReturnType<typeof trialInventory> & {
  unitInactive: boolean;
  unitDisabled: boolean;
  containerStopped: boolean;
  deployJsonSha256: string | null;
  imageEnvSha256: string | null;
};
let objects: Record<string, Item[]>;
let calls: { operation: string; args: string[]; options: RunOptions }[];
let hostCalls: string[];
let override: ((op: string, args: string[]) => RunResult | undefined) | undefined;
let hostOverride: ((op: string) => RunResult | undefined) | undefined;
let onArchive: (() => void) | undefined;
let archived: boolean;

beforeEach(() => {
  world = Ec2HostWorld.configured();
  directory = path.join(world.home, 'final-return');
  plans = path.join(world.home, 'reset-plans');
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.mkdirSync(plans, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'db.sqlite'), 'closed-database');
  fs.mkdirSync(path.join(directory, 'empty'));
  fs.mkdirSync(path.join(directory, 'files'));
  fs.writeFileSync(path.join(directory, 'files', 'árvíz\nfile'), 'payload');
  planFile = path.join(plans, 'reset.json');
  state = {
    ...trialInventory(directory),
    unitInactive: true,
    unitDisabled: true,
    containerStopped: true,
    deployJsonSha256: sha('deploy'),
    imageEnvSha256: sha('image'),
  };
  objects = { [db]: [item('secret-key-name'), item('z')], [backup]: [] };
  calls = [];
  hostCalls = [];
  override = undefined;
  hostOverride = undefined;
  onArchive = undefined;
  archived = false;
  const original = world.machine.handle.bind(world.machine);
  world.machine.handle = (op, args, input) => {
    if (!op.startsWith('trial-reset-')) return original(op, args, input);
    hostCalls.push(op);
    const injected = hostOverride?.(op);
    if (injected) return injected;
    if (op === 'trial-reset-inspect') return ok(state);
    expect(input).toBeUndefined();
    expect(args).toHaveLength(5);
    if (op === 'trial-reset-archive') {
      expect(archived).toBe(false);
      archived = true;
      onArchive?.();
    }
    if (op === 'trial-reset-verify') expect(archived).toBe(true);
    return ok({
      archiveDirectory: `/var/lib/projectman/trial-archive/${args[0]}`,
      inventorySha256: state.inventorySha256,
      dataEmpty: true,
      unitInactive: true,
      unitDisabled: true,
    });
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  world.cleanup();
});

const deps = () => {
  const base = world.deps();
  return {
    ...base,
    run: async (command: string, args: string[], options: RunOptions = {}) => {
      if (command !== 'aws') return base.run(command, args, options);
      const service = args.findIndex((a) => ['s3api', 'sts', 'ec2'].includes(a));
      if (service === -1) return base.run(command, args, options);
      const operation = args[service + 1]!;
      calls.push({ operation, args, options });
      const injected = override?.(operation, args);
      if (injected) return injected;
      if (operation === 'describe-instances' && args.includes('--instance-ids'))
        return ok({
          Reservations: [
            {
              OwnerId: ACCOUNT,
              Instances: [
                {
                  InstanceId: EC2_HOST_ID,
                  VpcId: EC2_CONFIG.vpcId,
                  SubnetId: EC2_CONFIG.subnetId,
                  State: { Name: 'running' },
                },
              ],
            },
          ],
        });
      if (operation === 'describe-vpcs')
        return ok({ Vpcs: [{ VpcId: EC2_CONFIG.vpcId, OwnerId: ACCOUNT, State: 'available' }] });
      if (operation === 'describe-subnets')
        return ok({
          Subnets: [
            {
              SubnetId: EC2_CONFIG.subnetId,
              VpcId: EC2_CONFIG.vpcId,
              OwnerId: ACCOUNT,
              State: 'available',
              AvailabilityZone: 'eu-west-1b',
            },
          ],
        });
      if (args[service] !== 's3api') return base.run(command, args, options);
      if (operation === 'delete-object' && args.includes('--generate-cli-skeleton'))
        return ok({ Bucket: '', Key: '', ExpectedBucketOwner: '', IfMatch: '' });
      expect(flag(args, '--expected-bucket-owner')).toBe(ACCOUNT);
      const bucket = flag(args, '--bucket');
      expect([db, backup]).toContain(bucket);
      switch (operation) {
        case 'head-bucket':
        case 'get-bucket-versioning':
          return ok();
        case 'get-object-lock-configuration':
          return error('ObjectLockConfigurationNotFoundError');
        case 'get-bucket-replication':
          return error('ReplicationConfigurationNotFoundError');
        case 'list-multipart-uploads':
          return ok({ IsTruncated: false });
        case 'list-objects-v2': {
          expect(args).toContain('--no-paginate');
          const start = args.includes('--continuation-token')
            ? Number(flag(args, '--continuation-token'))
            : 0;
          const list = objects[bucket]!.slice(start, start + 1);
          const more = start + list.length < objects[bucket]!.length;
          return ok({
            Contents: list,
            KeyCount: list.length,
            IsTruncated: more,
            ...(more ? { NextContinuationToken: String(start + 1) } : {}),
          });
        }
        case 'delete-object': {
          expect(archived).toBe(true);
          expect(options.env).toMatchObject({ AWS_MAX_ATTEMPTS: '1', AWS_RETRY_MODE: 'standard' });
          const key = (JSON.parse(flag(args, '--cli-input-json')) as { Key: string }).Key,
            etag = flag(args, '--if-match');
          expect(etag).not.toBe('*');
          const found = objects[bucket]!.find((o) => o.Key === key && o.ETag === etag);
          if (!found) return error('PreconditionFailed');
          objects[bucket] = objects[bucket]!.filter((o) => o !== found);
          return ok();
        }
        default:
          throw new Error(`unexpected AWS operation ${operation}`);
      }
    },
  };
};
const plan = () =>
  runCloud(
    [
      'trial-reset-plan',
      '--from',
      directory,
      '--rollback-event',
      'evt_test123',
      '--out',
      planFile,
      '--config',
      world.configFile,
    ],
    deps(),
  );
const apply = (dryRun = false, confirm = sha(fs.readFileSync(planFile))) =>
  runCloud(
    [
      'trial-reset-apply',
      '--plan',
      planFile,
      '--confirm-sha256',
      confirm,
      ...(dryRun ? ['--dry-run'] : []),
      '--config',
      world.configFile,
    ],
    deps(),
  );
const readPlan = () => trialResetPlanSchema.parse(JSON.parse(fs.readFileSync(planFile, 'utf8')));
const result = () =>
  trialResetResultSchema.parse(JSON.parse(fs.readFileSync(`${planFile}.result.json`, 'utf8')));
const noWrites = () => {
  expect(archived).toBe(false);
  expect(
    calls.filter((c) => c.operation === 'delete-object' && c.args.includes('--cli-input-json')),
  ).toHaveLength(0);
  expect(fs.existsSync(`${planFile}.result.json`)).toBe(false);
};

describe('trial reset owner plan and apply over the EC2 transport', () => {
  it('plans all pages including an empty backup; hashes the exact private bytes and preserves the copy', async () => {
    expect(await plan(), world.output).toBe(0);
    const p = readPlan();
    expect(p.buckets.map((b) => b.objectCount)).toEqual([2, 0]);
    expect(p.host).toMatchObject({ inventorySha256: state.inventorySha256, files: 2, directories: 2 });
    expect(p.rollback.databaseSha256).toBe(sha('closed-database'));
    expect(fs.statSync(planFile).mode & 0o777).toBe(0o600);
    expect(world.output).toContain(sha(fs.readFileSync(planFile)));
    expect(world.output).not.toMatch(/secret-key-name|FAKE-CREDENTIAL|sensitive.invalid/);
    noWrites();
  });
  it('revalidates dry-run without creating a receipt and applies once with conditional single-attempt deletes', async () => {
    expect(await plan()).toBe(0);
    expect(await apply(true), world.output).toBe(0);
    noWrites();
    expect(await apply(), world.output).toBe(0);
    expect(result()).toMatchObject({ status: 'complete', deleted: { database: 2, backup: 0 } });
    expect(fs.statSync(`${planFile}.result.json`).mode & 0o777).toBe(0o600);
    expect(hostCalls.at(-1)).toBe('trial-reset-verify');
    expect(objects).toEqual({ [db]: [], [backup]: [] });
    expect(trialInventory(directory)).toMatchObject({ inventorySha256: state.inventorySha256 });
    expect(await apply()).toBe(2);
    expect(hostCalls.filter((c) => c === 'trial-reset-archive')).toHaveLength(1);
    expect(hostCalls).not.toEqual(expect.arrayContaining(['start', 'receive-data', 'bootstrap']));
  });
  it('accepts two empty buckets', async () => {
    objects = { [db]: [], [backup]: [] };
    expect(await plan()).toBe(0);
    expect(await apply()).toBe(0);
    expect(result().deleted).toEqual({ database: 0, backup: 0 });
  });
  it('treats file URI and option-looking object keys as literal JSON data', async () => {
    objects[db] = [
      item('file:///private/credential'),
      item('fileb:///private/credential'),
      item('--other-bucket'),
    ];
    expect(await plan()).toBe(0);
    expect(await apply()).toBe(0);
    const deletes = calls.filter(
      (c) => c.operation === 'delete-object' && c.args.includes('--cli-input-json'),
    );
    expect(deletes).toHaveLength(3);
    for (const c of deletes) {
      expect(c.args).not.toContain('--key');
      expect(c.args).toContain('--if-match');
      expect(c.args).toContain('--expected-bucket-owner');
    }
  });
  it.each(['Enabled', 'Suspended'])('refuses %s versioning before writing a plan', async (Status) => {
    override = (op) => (op === 'get-bucket-versioning' ? ok({ Status }) : undefined);
    expect(await plan()).toBe(2);
    expect(fs.existsSync(planFile)).toBe(false);
    noWrites();
  });
  it.each(['unitInactive', 'unitDisabled', 'containerStopped'] as const)(
    'refuses host %s=false',
    async (field) => {
      state[field] = false;
      expect(await plan()).toBe(2);
      noWrites();
    },
  );
  it.each(['get-object-lock-configuration', 'get-bucket-replication', 'list-multipart-uploads'])(
    'refuses %s protections or writers',
    async (op) => {
      override = (operation) =>
        operation === op
          ? ok(
              op === 'list-multipart-uploads'
                ? { IsTruncated: false, Uploads: [{ Key: 'secret-key-name', UploadId: 'upload' }] }
                : {},
            )
          : undefined;
      expect(await plan()).toBe(2);
      noWrites();
    },
  );
  it.each(['AccessDenied', 'RequestTimeout', 'NoSuchBucket'])(
    'does not interpret %s as an absent protection',
    async (code) => {
      override = (op) => (op === 'get-object-lock-configuration' ? error(code) : undefined);
      expect(await plan()).toBe(1);
      noWrites();
      expect(world.output).not.toMatch(/secret-key-name|FAKE-CREDENTIAL|sensitive.invalid/);
    },
  );
  it.each([
    { IsTruncated: true, KeyCount: 1, Contents: [item('one')] },
    { IsTruncated: true, KeyCount: 1, Contents: [item('one')], NextContinuationToken: 'same' },
    { IsTruncated: false, KeyCount: 3, Contents: [] },
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...item('one'), ETag: '*' }] },
    { IsTruncated: false, KeyCount: 1, Contents: [{ ...item('one'), Size: -1 }] },
  ])('stops malformed or repeated page %#', async (page) => {
    override = (op) => (op === 'list-objects-v2' ? ok(page) : undefined);
    expect([1, 2]).toContain(await plan());
    noWrites();
  });
  it('rejects duplicate object keys across pages', async () => {
    objects[db] = [item('same'), item('same')];
    expect(await plan()).toBe(2);
    noWrites();
  });
  it.each(['Key', 'ETag', 'Size', 'LastModified'] as const)(
    'refuses a changed object %s before archival',
    async (field) => {
      expect(await plan()).toBe(0);
      objects[db]![0]![field] = (
        field === 'Size' ? 11 : field === 'LastModified' ? '2026-10-16T00:00:00Z' : 'changed'
      ) as never;
      expect(await apply()).toBe(2);
      noWrites();
    },
  );
  it('refuses changed host metadata, final copy or confirmation', async () => {
    expect(await plan()).toBe(0);
    expect(await apply(false, '0'.repeat(64))).toBe(2);
    noWrites();
    state.deployJsonSha256 = sha('other');
    expect(await apply()).toBe(2);
    noWrites();
    state.deployJsonSha256 = sha('deploy');
    fs.writeFileSync(path.join(directory, 'files', 'árvíz\nfile'), 'changed');
    expect(await apply()).toBe(2);
    noWrites();
  });
  it.each(['account', 'profile', 'instance', 'tags', 'network', 'ssm'])(
    'refuses a foreign or unavailable %s',
    async (which) => {
      expect(await plan()).toBe(0);
      if (which === 'account') world.aws.accounts.set('aroom', '999999999999');
      if (which === 'profile') {
        const c = JSON.parse(fs.readFileSync(world.configFile, 'utf8'));
        c.aws.profile = 'other';
        world.writeConfig(c);
      }
      if (which === 'instance') world.instances[0]!.InstanceId = 'i-11111111111111111';
      if (which === 'tags') world.instances[0]!.Tags[1]!.Value = 'false';
      if (which === 'network') override = (op) => (op === 'describe-vpcs' ? ok({ Vpcs: [] }) : undefined);
      if (which === 'ssm') world.online = 'Offline';
      expect(await apply()).toBe(2);
      noWrites();
    },
  );
  it('requires conditional-delete support before archival', async () => {
    expect(await plan()).toBe(0);
    override = (op, args) =>
      op === 'delete-object' && args.includes('--generate-cli-skeleton')
        ? ok({ Bucket: '', Key: '', ExpectedBucketOwner: '' })
        : undefined;
    expect([1, 2]).toContain(await apply());
    noWrites();
  });
  it('preserves a failed receipt after host refusal without deleting S3', async () => {
    expect(await plan()).toBe(0);
    hostOverride = (op) =>
      op === 'trial-reset-archive'
        ? { code: 3, stdout: 'secret-key-name', stderr: 'FAKE-CREDENTIAL' }
        : undefined;
    expect(await apply()).toBe(2);
    expect(result().status).toBe('failed');
    expect(calls.filter((c) => c.args.includes('--cli-input-json'))).toHaveLength(0);
    expect(world.output).toContain('partial result');
    expect(world.output).not.toMatch(/secret-key-name|FAKE-CREDENTIAL/);
  });
  it('stops if S3 changes after archival and preserves both the return copy and receipt', async () => {
    expect(await plan()).toBe(0);
    onArchive = () => {
      objects[backup]!.push(item('new'));
    };
    expect(await apply()).toBe(2);
    expect(archived).toBe(true);
    expect(result().status).toBe('failed');
    expect(calls.filter((c) => c.args.includes('--cli-input-json'))).toHaveLength(0);
    expect(fs.readFileSync(path.join(directory, 'db.sqlite'), 'utf8')).toBe('closed-database');
  });
  it.each(['PreconditionFailed', 'AccessDenied', 'transport', 'interruption'])(
    'stops after a partial delete on %s; never retries or replays',
    async (reason) => {
      expect(await plan()).toBe(0);
      let deletes = 0;
      override = (op, args) => {
        if (op !== 'delete-object' || !args.includes('--cli-input-json')) return;
        if (++deletes !== 2) return;
        if (reason === 'interruption') {
          world.interrupt();
          return { code: 130, stdout: '', stderr: 'secret-key-name' };
        }
        return reason === 'transport' ? { code: 124, stdout: '', stderr: 'secret-key-name' } : error(reason);
      };
      expect(await apply()).toBe(1);
      expect(deletes).toBe(2);
      expect(result()).toMatchObject({ status: 'failed', deleted: { database: 1, backup: 0 } });
      expect(objects[db]).toHaveLength(1);
      expect(archived).toBe(true);
      expect(await apply()).toBe(2);
      expect(deletes).toBe(2);
      expect(world.output).not.toMatch(/secret-key-name|FAKE-CREDENTIAL|sensitive.invalid/);
    },
  );
  it('requires final archive verification before complete', async () => {
    expect(await plan()).toBe(0);
    hostOverride = (op) =>
      op === 'trial-reset-verify' ? { code: 3, stdout: '', stderr: 'changed' } : undefined;
    expect(await apply()).toBe(2);
    expect(result().status).toBe('failed');
  });
  it('never overwrites a concurrent apply receipt when exclusive publication loses the race', async () => {
    expect(await plan()).toBe(0);
    const original = fs.linkSync;
    const foreign = 'another apply owns this marker';
    vi.spyOn(fs, 'linkSync').mockImplementation((source, destination) => {
      if (String(destination) === `${planFile}.result.json`)
        fs.writeFileSync(destination, foreign, { flag: 'wx', mode: 0o600 });
      return original(source, destination);
    });
    expect(await apply()).toBe(2);
    expect(fs.readFileSync(`${planFile}.result.json`, 'utf8')).toBe(foreign);
    expect(archived).toBe(false);
  });
  it('rejects unknown plan fields, foreign buckets and duplicate roles', async () => {
    expect(await plan()).toBe(0);
    const p = readPlan();
    expect(trialResetPlanSchema.safeParse({ ...p, force: true }).success).toBe(false);
    expect(trialResetPlanSchema.safeParse({ ...p, buckets: [p.buckets[0], p.buckets[0]] }).success).toBe(
      false,
    );
    expect(
      trialResetPlanSchema.safeParse({ ...p, target: { ...p.target, backupBucket: 'foreign-bucket' } })
        .success,
    ).toBe(false);
    expect(
      trialResetPlanSchema.safeParse({ ...p, host: { ...p.host, archiveDirectory: '/other' } }).success,
    ).toBe(false);
  });
  it('requires explicit config and all CLI arguments, with no force or retry escape hatch', async () => {
    for (const args of [
      [],
      ['--force'],
      ['--plan', planFile, '--confirm-sha256', '0'.repeat(64)],
      ['--retry'],
    ])
      expect(await runCloud(['trial-reset-apply', ...args], deps())).toBe(64);
    noWrites();
  });
});

describe('canonical return-copy inventory', () => {
  it('matches an independently built UTF-8 byte-sorted NUL representation including empty directories', () => {
    const expected = [
      `db.sqlite\0file\0${Buffer.byteLength('closed-database')}\0${sha('closed-database')}\0`,
      ['empty', 'directory', '0', '', ''].join('\0'),
      ['files', 'directory', '0', '', ''].join('\0'),
      ['files/árvíz\nfile', 'file', '7', sha('payload'), ''].join('\0'),
    ].join('');
    expect(state.inventorySha256).toBe(sha(expected));
  });
  it('rejects symlink entries, symlink roots, missing DBs and permissive plan directories', async () => {
    fs.symlinkSync('db.sqlite', path.join(directory, 'linked'));
    expect(await plan()).toBe(2);
    noWrites();
    fs.unlinkSync(path.join(directory, 'linked'));
    fs.unlinkSync(path.join(directory, 'db.sqlite'));
    expect(await plan()).toBe(2);
    fs.writeFileSync(path.join(directory, 'db.sqlite'), 'closed-database');
    fs.chmodSync(plans, 0o755);
    expect(await plan()).toBe(2);
    noWrites();
  });
  it('rejects invalid UTF-8 names without printing their bytes', () => {
    const original = fs.readdirSync;
    vi.spyOn(fs, 'readdirSync').mockImplementation(((file: fs.PathLike, options: unknown) => {
      if (String(file) === directory) return [Buffer.from([0xff])];
      return Reflect.apply(original, fs, [file, options]);
    }) as typeof fs.readdirSync);
    expect(() => trialInventory(directory)).toThrow('cannot be read safely');
  });
  it('detects a file changed during hashing and an earlier entry changed later in the walk', () => {
    const original = fs.readSync;
    let once = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const n = Reflect.apply(original, fs, args) as number;
      if (!once && n > 0) {
        once = true;
        fs.appendFileSync(path.join(directory, 'db.sqlite'), 'changed');
      }
      return n;
    }) as typeof fs.readSync);
    expect(() => trialInventory(directory)).toThrow(/changed/);
  });
  it('rejects a nested device or bind mount snapshot', () => {
    const original = fs.lstatSync;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options: unknown) => {
      const s = Reflect.apply(original, fs, [file, options]);
      if (String(file) === path.join(directory, 'files') && typeof s.dev === 'bigint')
        return { ...s, dev: s.dev + 1n, isDirectory: () => true };
      return s;
    }) as typeof fs.lstatSync);
    expect(() => trialInventory(directory)).toThrow(/mount/);
  });
});
