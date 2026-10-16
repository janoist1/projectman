import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { AwsCallError, AwsCli } from './aws-cli';
import { bucketName } from './config';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import { readEc2HostInstance } from './ec2-host';
import { withHost } from './host';
import type { HostSession, HostSubcommand } from './host';

const digest = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utc = z.iso.datetime();
const uuid = z.uuidv4();
const eventId = z.string().regex(/^evt_[a-z0-9]+$/);
const absolute = z.string().refine((s) => path.isAbsolute(s) && path.resolve(s) === s && !/[\0\r\n]/.test(s));
const archiveRoot = '/var/lib/projectman/trial-archive';
const archivePath = (id: string) => `${archiveRoot}/${id}`;
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const byteOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const utf8 = (s: string) => Buffer.from(s).toString('utf8') === s;

const objectSchema = z.strictObject({
  key: z
    .string()
    .min(1)
    .refine((s) => utf8(s) && !s.includes('\0') && Buffer.byteLength(s) <= 1024),
  etag: z
    .string()
    .min(1)
    .refine(
      (s) =>
        s.trim().length > 0 &&
        s.trim() !== '*' &&
        s.trim() !== '"*"' &&
        !/[\0\r\n]/.test(s) &&
        !/^fileb?:\/\//.test(s),
    ),
  size: count,
  lastModified: utc,
});
const bucketSchema = z
  .strictObject({
    role: z.enum(['database', 'backup']),
    name: bucketName,
    objectCount: count,
    bytes: count,
    objects: z.array(objectSchema),
  })
  .refine(
    (b) =>
      b.objects.length === b.objectCount &&
      b.objects.reduce((sum, o) => sum + o.size, 0) === b.bytes &&
      b.objects.every((o, i) => i === 0 || byteOrder(b.objects[i - 1]!.key, o.key) < 0),
  );

export const trialResetPlanSchema = z
  .strictObject({
    version: z.literal(1),
    kind: z.literal('trial-reset'),
    taskKey: z.literal('PM-675'),
    planId: uuid,
    createdAt: utc,
    target: z.strictObject({
      profile: z
        .string()
        .regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/)
        .refine((s) => s !== 'i'),
      accountId: z.string().regex(/^\d{12}$/),
      region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/),
      instanceId: z.string().regex(/^i-(?:[0-9a-f]{8}|[0-9a-f]{17})$/),
      instanceName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,49}$/),
      databaseBucket: bucketName,
      backupBucket: bucketName,
    }),
    rollback: z.strictObject({
      eventId,
      returnDirectory: absolute,
      databaseSha256: digest,
      inventorySha256: digest,
    }),
    host: z.strictObject({
      inventorySha256: digest,
      files: count,
      directories: count,
      bytes: count,
      deployJsonSha256: digest.nullable(),
      imageEnvSha256: digest.nullable(),
      archiveDirectory: absolute,
    }),
    buckets: z.array(bucketSchema).length(2),
  })
  .refine(
    (p) =>
      p.target.databaseBucket !== p.target.backupBucket &&
      p.host.archiveDirectory === archivePath(p.planId) &&
      p.rollback.inventorySha256 === p.host.inventorySha256 &&
      ['database', 'backup'].every(
        (role) =>
          p.buckets.filter(
            (b) =>
              b.role === role &&
              b.name === (role === 'database' ? p.target.databaseBucket : p.target.backupBucket),
          ).length === 1,
      ),
  );
export type TrialResetPlan = z.output<typeof trialResetPlanSchema>;

export const trialResetResultSchema = z.strictObject({
  version: z.literal(1),
  planId: uuid,
  planSha256: digest,
  status: z.enum(['started', 'host-archived', 'failed', 'complete']),
  updatedAt: utc,
  deleted: z.strictObject({ database: count, backup: count }),
});
type Result = z.output<typeof trialResetResultSchema>;
const inspectSchema = z.strictObject({
  unitInactive: z.boolean(),
  unitDisabled: z.boolean(),
  containerStopped: z.boolean(),
  inventorySha256: digest,
  files: count,
  directories: count,
  bytes: count,
  databaseSha256: digest,
  deployJsonSha256: digest.nullable(),
  imageEnvSha256: digest.nullable(),
});
const archivedSchema = z.strictObject({
  archiveDirectory: absolute,
  inventorySha256: digest,
  dataEmpty: z.literal(true),
  unitInactive: z.literal(true),
  unitDisabled: z.literal(true),
});

function parse<S extends z.ZodType>(schema: S, value: unknown, message: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw refused(message);
  return parsed.data;
}
function json(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CloudError('invalid reset protocol JSON');
  }
}
function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw refused(message);
}
const fingerprint = (s: fs.BigIntStats) => [s.dev, s.ino, s.mode, s.size, s.mtimeNs, s.ctimeNs].join(':');
const within = (file: string, root: string) => file === root || file.startsWith(`${root}${path.sep}`);

/** Walk every ancestor without following symlinks. Errors never print a data entry's name. */
function ancestors(file: string): void {
  let current = path.resolve(file);
  for (;;) {
    const s = fs.lstatSync(current);
    if (!s.isDirectory() || s.isSymbolicLink()) throw refused('reset path has an unsafe ancestor');
    const next = path.dirname(current);
    if (next === current) return;
    current = next;
  }
}
function privateDirectory(directory: string): void {
  ancestors(directory);
  const s = fs.lstatSync(directory);
  if ((s.mode & 0o777) !== 0o700 || (process.getuid && s.uid !== process.getuid()))
    throw refused('reset directory must be owned by the caller with mode 0700');
}
function outsideSources(context: CloudContext, directory: string): void {
  if (
    within(directory, fs.realpathSync(context.deps.repoRoot)) ||
    within(directory, path.join(context.deps.homeDir, '.projectman'))
  )
    throw refused('reset files must be outside the repository and the Mac live source');
  let current = directory;
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) throw refused('reset files must be outside git worktrees');
    const next = path.dirname(current);
    if (next === current) return;
    current = next;
  }
}

function fileDigest(file: string, expectedDevice?: bigint): { sha256: string; bytes: number; stamp: string } {
  const before = fs.lstatSync(file, { bigint: true });
  if (!before.isFile() || (expectedDevice !== undefined && before.dev !== expectedDevice))
    throw refused('reset inventory contains a symlink, special file or mount');
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw refused('reset file is too large');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (fingerprint(before) !== fingerprint(fs.fstatSync(fd, { bigint: true })))
      throw refused('reset file changed before hashing');
    const h = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const n = fs.readSync(fd, buffer);
      if (!n) break;
      h.update(buffer.subarray(0, n));
      bytes += n;
      if (
        BigInt(bytes) > before.size ||
        fingerprint(before) !== fingerprint(fs.fstatSync(fd, { bigint: true }))
      )
        throw refused('reset file changed during hashing');
    }
    if (
      BigInt(bytes) !== before.size ||
      fingerprint(before) !== fingerprint(fs.fstatSync(fd, { bigint: true })) ||
      fingerprint(before) !== fingerprint(fs.lstatSync(file, { bigint: true }))
    )
      throw refused('reset file changed during hashing');
    return { sha256: h.digest('hex'), bytes, stamp: fingerprint(before) };
  } finally {
    fs.closeSync(fd);
  }
}

/** Canonical NUL-separated inventory shared with the Ubuntu host implementation. Never opens SQLite. */
export function trialInventory(directory: string) {
  try {
    ancestors(directory);
    const root = fs.lstatSync(directory, { bigint: true });
    // Same-device bind mounts need the mount table as well as st_dev on Linux.
    if (process.platform === 'linux') {
      for (const line of fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')) {
        const field = line.split(' ')[4];
        if (!field) throw refused('cannot verify reset mounts');
        const mount = field.replace(/\\([0-7]{3})/g, (_, n: string) => String.fromCharCode(parseInt(n, 8)));
        if (within(mount, directory)) throw refused('reset source contains a mount');
      }
    }
    const entries: { name: string; type: 'file' | 'directory'; bytes: number; sha: string; stamp: string }[] =
      [];
    const walk = (dir: string, prefix: string) => {
      const before = fs.lstatSync(dir, { bigint: true });
      if (!before.isDirectory() || before.dev !== root.dev)
        throw refused('reset source contains a mount or symlink');
      for (const raw of fs.readdirSync(dir, { encoding: 'buffer' })) {
        const name = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
        const relative = prefix ? `${prefix}/${name}` : name;
        const full = path.join(dir, name);
        const s = fs.lstatSync(full, { bigint: true });
        if (s.isDirectory()) {
          entries.push({ name: relative, type: 'directory', bytes: 0, sha: '', stamp: fingerprint(s) });
          walk(full, relative);
        } else {
          const d = fileDigest(full, root.dev);
          entries.push({ name: relative, type: 'file', bytes: d.bytes, sha: d.sha256, stamp: d.stamp });
        }
      }
      if (fingerprint(before) !== fingerprint(fs.lstatSync(dir, { bigint: true })))
        throw refused('reset directory changed during inventory');
    };
    walk(directory, '');
    entries.sort((a, b) => byteOrder(a.name, b.name));
    const h = createHash('sha256');
    let files = 0,
      directories = 0,
      bytes = 0;
    for (const entry of entries) {
      if (entry.stamp !== fingerprint(fs.lstatSync(path.join(directory, entry.name), { bigint: true })))
        throw refused('reset tree changed during inventory');
      h.update(`${entry.name}\0${entry.type}\0${entry.bytes}\0${entry.sha}\0`);
      if (entry.type === 'file') {
        files++;
        bytes += entry.bytes;
      } else directories++;
    }
    if (!Number.isSafeInteger(bytes)) throw refused('reset inventory is too large');
    if (fingerprint(root) !== fingerprint(fs.lstatSync(directory, { bigint: true })))
      throw refused('reset root changed during inventory');
    const database = entries.find((e) => e.name === 'db.sqlite' && e.type === 'file');
    if (!database) throw refused('reset source requires a regular db.sqlite');
    return { inventorySha256: h.digest('hex'), files, directories, bytes, databaseSha256: database.sha };
  } catch (e) {
    if (e instanceof CloudError) throw e;
    throw refused('reset inventory cannot be read safely');
  }
}

function rollbackInventory(context: CloudContext, directory: string) {
  privateDirectory(directory);
  outsideSources(context, directory);
  return trialInventory(directory);
}

function privateFile(file: string): Buffer {
  privateDirectory(path.dirname(file));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || (process.getuid && stat.uid !== process.getuid()))
    throw refused('reset plan must be a regular caller-owned mode 0600 file');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    const bytes = fs.readFileSync(fd);
    if (
      fingerprint(before) !== fingerprint(fs.fstatSync(fd, { bigint: true })) ||
      fingerprint(before) !== fingerprint(fs.lstatSync(file, { bigint: true }))
    )
      throw refused('reset plan changed while reading');
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

/** Exclusive first write, atomic subsequent writes; a durable marker is never removed on failure. */
function writeReceipt(file: string, value: unknown, initial: boolean): void {
  privateDirectory(path.dirname(file));
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (initial) {
    // Link publishes fully written bytes exclusively; a concurrent apply cannot replace the marker.
    try {
      fs.linkSync(tmp, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw refused('reset output already exists');
      throw e;
    } finally {
      fs.unlinkSync(tmp);
    }
  } else fs.renameSync(tmp, file);
  const parent = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(parent);
  } finally {
    fs.closeSync(parent);
  }
}

async function target(context: CloudContext, cli: AwsCli): Promise<TrialResetPlan['target']> {
  const a = context.config.aws;
  if (a.compute !== 'ec2' || a.profile === 'i' || !a.ec2 || a.databaseBucket === a.backupBucket)
    throw refused('trial reset requires EC2 and distinct buckets in the explicit central profile');
  const identity = await cli.callAs(
    ['sts', 'get-caller-identity'],
    z.looseObject({ Account: z.string().regex(/^\d{12}$/) }),
  );
  const instance = await readEc2HostInstance(context);
  const answer = await cli.callAs(
    ['ec2', 'describe-instances', '--instance-ids', instance.InstanceId],
    z.looseObject({
      Reservations: z.array(
        z.looseObject({
          OwnerId: z.string(),
          Instances: z.array(
            z.looseObject({
              InstanceId: z.string(),
              VpcId: z.string(),
              SubnetId: z.string(),
              State: z.looseObject({ Name: z.string() }),
            }),
          ),
        }),
      ),
    }),
  );
  const all = answer.Reservations.flatMap((r) => r.Instances);
  if (
    answer.Reservations.some((r) => r.OwnerId !== identity.Account) ||
    all.length !== 1 ||
    all[0]!.InstanceId !== instance.InstanceId ||
    all[0]!.State.Name !== 'running' ||
    all[0]!.VpcId !== a.ec2.vpcId ||
    all[0]!.SubnetId !== a.ec2.subnetId
  )
    throw refused('reset EC2 account, instance or network differs');
  const vpcs = await cli.callAs(
    ['ec2', 'describe-vpcs', '--vpc-ids', a.ec2.vpcId],
    z.looseObject({
      Vpcs: z.array(z.looseObject({ VpcId: z.string(), OwnerId: z.string(), State: z.string() })),
    }),
  );
  if (
    vpcs.Vpcs.length !== 1 ||
    vpcs.Vpcs[0]!.VpcId !== a.ec2.vpcId ||
    vpcs.Vpcs[0]!.OwnerId !== identity.Account ||
    vpcs.Vpcs[0]!.State !== 'available'
  )
    throw refused('reset VPC ownership or state differs');
  const subnets = await cli.callAs(
    ['ec2', 'describe-subnets', '--subnet-ids', a.ec2.subnetId],
    z.looseObject({
      Subnets: z.array(
        z.looseObject({
          SubnetId: z.string(),
          VpcId: z.string(),
          OwnerId: z.string(),
          State: z.string(),
          AvailabilityZone: z.string(),
        }),
      ),
    }),
  );
  if (
    subnets.Subnets.length !== 1 ||
    subnets.Subnets[0]!.SubnetId !== a.ec2.subnetId ||
    subnets.Subnets[0]!.VpcId !== a.ec2.vpcId ||
    subnets.Subnets[0]!.OwnerId !== identity.Account ||
    subnets.Subnets[0]!.State !== 'available' ||
    subnets.Subnets[0]!.AvailabilityZone !== instance.Placement.AvailabilityZone
  )
    throw refused('reset subnet ownership or state differs');
  return parse(
    trialResetPlanSchema.shape.target,
    {
      profile: a.profile,
      accountId: identity.Account,
      region: a.region,
      instanceId: instance.InstanceId,
      instanceName: a.instanceName,
      databaseBucket: a.databaseBucket,
      backupBucket: a.backupBucket,
    },
    'invalid reset target',
  );
}

// AWS uses offsets such as +00:00; plans use normalized UTC timestamps only.
const awsDate = z
  .string()
  .refine(
    (s) =>
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|\+00:00)$/.test(s) && Number.isFinite(Date.parse(s)),
  )
  .transform((s) => new Date(s).toISOString());
const pageSchema = z.looseObject({
  IsTruncated: z.boolean(),
  KeyCount: count,
  Contents: z
    .array(
      z.looseObject({
        Key: objectSchema.shape.key,
        ETag: objectSchema.shape.etag,
        Size: count,
        LastModified: awsDate,
      }),
    )
    .optional(),
  NextContinuationToken: z.string().min(1).max(8192).optional(),
});

async function bucketInventory(cli: AwsCli, t: TrialResetPlan['target'], role: 'database' | 'backup') {
  const name = role === 'database' ? t.databaseBucket : t.backupBucket;
  const base = ['--bucket', name, '--expected-bucket-owner', t.accountId];
  await cli.callAs(['s3api', 'head-bucket', ...base], z.looseObject({}));
  const version = await cli.callAs(
    ['s3api', 'get-bucket-versioning', ...base],
    z.strictObject({
      Status: z.enum(['Enabled', 'Suspended']).optional(),
      MFADelete: z.enum(['Enabled', 'Disabled']).optional(),
    }),
  );
  if (version.Status || version.MFADelete) throw refused('trial reset requires a never-versioned bucket');
  for (const [operation, missing] of [
    ['get-object-lock-configuration', 'ObjectLockConfigurationNotFoundError'],
    ['get-bucket-replication', 'ReplicationConfigurationNotFoundError'],
  ]) {
    try {
      await cli.call(['s3api', operation!, ...base]);
    } catch (e) {
      if (e instanceof AwsCallError && e.awsCode === missing) continue;
      throw e;
    }
    throw refused('trial reset refuses bucket retention or replication configuration');
  }
  const uploads = await cli.callAs(
    ['s3api', 'list-multipart-uploads', ...base, '--no-paginate', '--max-uploads', '1'],
    z.looseObject({
      IsTruncated: z.boolean(),
      Uploads: z.array(z.looseObject({ Key: z.string(), UploadId: z.string() })).optional(),
    }),
  );
  if (uploads.IsTruncated || uploads.Uploads?.length) throw refused('trial reset refuses multipart uploads');
  const objects: z.output<typeof objectSchema>[] = [];
  const tokens = new Set<string>();
  let token: string | undefined;
  for (;;) {
    const page = await cli.callAs(
      [
        's3api',
        'list-objects-v2',
        ...base,
        '--no-paginate',
        '--max-keys',
        '1000',
        ...(token ? ['--continuation-token', token] : []),
      ],
      pageSchema,
    );
    if (page.KeyCount !== (page.Contents?.length ?? 0)) throw refused('inconsistent S3 page count');
    for (const o of page.Contents ?? [])
      objects.push({ key: o.Key, etag: o.ETag, size: o.Size, lastModified: o.LastModified });
    if (!page.IsTruncated) {
      if (page.NextContinuationToken !== undefined) throw refused('unexpected S3 continuation token');
      break;
    }
    token = page.NextContinuationToken;
    if (!token || tokens.has(token) || !page.KeyCount)
      throw refused('invalid or repeated S3 continuation token');
    tokens.add(token);
  }
  objects.sort((a, b) => byteOrder(a.key, b.key));
  return parse(
    bucketSchema,
    { role, name, objectCount: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0), objects },
    'invalid S3 inventory',
  );
}
async function buckets(cli: AwsCli, t: TrialResetPlan['target']) {
  return [await bucketInventory(cli, t, 'database'), await bucketInventory(cli, t, 'backup')];
}

/** Use run instead of call so remote filenames and command stderr never reach the report. */
async function hostJson<S extends z.ZodType>(
  host: HostSession,
  command: HostSubcommand,
  args: string[],
  schema: S,
): Promise<z.output<S>> {
  const result = await host.run(command, args, { timeoutMs: 30 * 60_000 });
  if (host.signal.aborted) throw new CloudError('interrupted');
  if (result.code === 3)
    throw refused(`host ${command} refused; inspect the protected state before recovery`);
  if (result.code !== 0) throw new CloudError(`host ${command} failed (status ${result.code})`);
  return parse(schema, json(result.stdout), 'invalid host reset response');
}
async function inspect(host: HostSession) {
  const h = await hostJson(host, 'trial-reset-inspect', [], inspectSchema);
  if (!h.unitInactive || !h.unitDisabled || !h.containerStopped)
    throw refused('reset host must be stopped and disabled without backup writers');
  return h;
}
function checkCopy(context: CloudContext, directory: string, h: z.output<typeof inspectSchema>) {
  const copy = rollbackInventory(context, directory);
  for (const key of ['inventorySha256', 'databaseSha256', 'files', 'directories', 'bytes'] as const)
    same(copy[key], h[key], 'final return copy differs from the stopped host');
  return copy;
}
function archiveArgs(p: TrialResetPlan, sha: string) {
  return [
    p.planId,
    sha,
    p.host.inventorySha256,
    p.host.deployJsonSha256 ?? 'none',
    p.host.imageEnvSha256 ?? 'none',
  ];
}
function checkArchived(p: TrialResetPlan, value: z.output<typeof archivedSchema>) {
  if (value.archiveDirectory !== p.host.archiveDirectory || value.inventorySha256 !== p.host.inventorySha256)
    throw refused('host archive differs from the approved plan');
}

/** The CLI model is probed locally; generating a skeleton makes no AWS request. */
async function conditionalDeleteSupport(cli: AwsCli) {
  const model = await cli.call(['s3api', 'delete-object', '--generate-cli-skeleton', 'input']);
  if (
    !z
      .looseObject({
        Bucket: z.string(),
        Key: z.string(),
        ExpectedBucketOwner: z.string(),
        IfMatch: z.string(),
      })
      .safeParse(model).success
  )
    throw refused('AWS CLI does not support conditional delete');
}

/** No outside error may include raw stderr, a key, an ETag, a URL or data contents. */
async function protectedOperation(body: () => Promise<void>) {
  try {
    await body();
  } catch (e) {
    if (e instanceof AwsCallError)
      throw new CloudError(`aws ${e.operation} failed (${e.awsCode ?? 'API or transport error'})`);
    if (e instanceof CloudError) throw e;
    throw new CloudError('trial reset failed; inspect the protected local files');
  }
}

export async function runTrialResetPlan(
  context: CloudContext,
  from: string,
  rollbackEvent: string,
  out: string,
): Promise<void> {
  await protectedOperation(async () => {
    const directory = parse(absolute, from, 'final return directory must be absolute');
    parse(eventId, rollbackEvent, 'invalid rollback event id');
    const output = path.resolve(out);
    privateDirectory(path.dirname(output));
    outsideSources(context, path.dirname(output));
    if (within(output, directory)) throw refused('plan must be outside the final return copy');
    if (fs.lstatSync(output, { throwIfNoEntry: false })) throw refused('reset plan output already exists');
    rollbackInventory(context, directory);
    const cli = new AwsCli(context.deps, context.config.aws, { redactErrors: true });
    const t = await target(context, cli);
    await conditionalDeleteSupport(cli);
    await withHost(context, async (host) => {
      if (host.address !== t.instanceId) throw refused('SSM target changed');
      const h = await inspect(host);
      const copy = checkCopy(context, directory, h);
      const inventory = await buckets(cli, t);
      // Recheck local/host state after the paginated cloud reads.
      same(await inspect(host), h, 'host changed while planning reset');
      same(rollbackInventory(context, directory), copy, 'return copy changed while planning reset');
      const planId = randomUUID();
      const plan = parse(
        trialResetPlanSchema,
        {
          version: 1,
          kind: 'trial-reset',
          taskKey: 'PM-675',
          planId,
          createdAt: context.deps.now().toISOString(),
          target: t,
          rollback: {
            eventId: rollbackEvent,
            returnDirectory: directory,
            databaseSha256: copy.databaseSha256,
            inventorySha256: copy.inventorySha256,
          },
          host: {
            inventorySha256: h.inventorySha256,
            files: h.files,
            directories: h.directories,
            bytes: h.bytes,
            deployJsonSha256: h.deployJsonSha256,
            imageEnvSha256: h.imageEnvSha256,
            archiveDirectory: archivePath(planId),
          },
          buckets: inventory,
        },
        'invalid generated reset plan',
      );
      writeReceipt(output, plan, true);
    });
    context.report.step(
      'created',
      'trial-reset-plan',
      `sha256=${hash(privateFile(output))}; protected plan=${output}`,
    );
  });
}

export async function runTrialResetApply(
  context: CloudContext,
  planFile: string,
  confirm: string,
  dryRun: boolean,
): Promise<void> {
  await protectedOperation(async () => {
    const file = path.resolve(planFile);
    const bytes = privateFile(file);
    const sha = hash(bytes);
    if (!digest.safeParse(confirm).success || confirm !== sha)
      throw refused('confirmation differs from the exact plan file SHA-256');
    const p = parse(trialResetPlanSchema, json(bytes.toString('utf8')), 'invalid trial reset plan');
    outsideSources(context, path.dirname(file));
    if (within(file, p.rollback.returnDirectory)) throw refused('plan must be outside the final return copy');
    const resultFile = `${file}.result.json`;
    if (fs.lstatSync(resultFile, { throwIfNoEntry: false }))
      throw refused('reset result already exists; automatic reapply is refused');
    const controller = new AbortController();
    const unsubscribe = context.deps.onInterrupt(() => controller.abort());
    const cli = new AwsCli(context.deps, context.config.aws, {
      redactErrors: true,
      signal: controller.signal,
    });
    const deletion = new AwsCli(context.deps, context.config.aws, {
      redactErrors: true,
      signal: controller.signal,
      singleAttempt: true,
    });
    let result: Result | undefined;
    const record = (status: Result['status']) => {
      const initial = !result;
      const next = parse(
        trialResetResultSchema,
        {
          version: 1,
          planId: p.planId,
          planSha256: sha,
          status,
          updatedAt: context.deps.now().toISOString(),
          deleted: result?.deleted ?? { database: 0, backup: 0 },
        },
        'invalid reset result',
      );
      writeReceipt(resultFile, next, initial);
      result = next;
    };
    try {
      for (const field of ['profile', 'region', 'instanceName', 'databaseBucket', 'backupBucket'] as const)
        same(
          context.config.aws[field],
          p.target[field],
          'reset configuration differs from the approved plan',
        );
      same(
        await target(context, cli),
        p.target,
        'reset config, account or instance differs from the approved plan',
      );
      await conditionalDeleteSupport(cli);
      await withHost(context, async (host) => {
        if (host.address !== p.target.instanceId) throw refused('SSM target differs from the approved plan');
        const h = await inspect(host);
        for (const key of [
          'inventorySha256',
          'files',
          'directories',
          'bytes',
          'deployJsonSha256',
          'imageEnvSha256',
        ] as const)
          same(h[key], p.host[key], 'host differs from the approved plan');
        same(h.databaseSha256, p.rollback.databaseSha256, 'database differs from the approved plan');
        const copy = checkCopy(context, p.rollback.returnDirectory, h);
        same(await buckets(cli, p.target), p.buckets, 'S3 inventory differs from the approved plan');
        same(await inspect(host), h, 'host changed during reset validation');
        same(
          rollbackInventory(context, p.rollback.returnDirectory),
          copy,
          'return copy changed during reset validation',
        );
        same(hash(privateFile(file)), sha, 'plan file changed during reset validation');
        if (controller.signal.aborted || host.signal.aborted) throw new CloudError('interrupted');
        if (dryRun) {
          context.report.step('ok', 'trial-reset-dry-run', `sha256=${sha}; no archive, deletion or receipt`);
          return;
        }
        record('started');
        checkArchived(p, await hostJson(host, 'trial-reset-archive', archiveArgs(p, sha), archivedSchema));
        record('host-archived');
        same(
          await buckets(cli, p.target),
          p.buckets,
          'S3 changed after host archival; STOP for owner recovery',
        );
        for (const b of p.buckets)
          for (const object of b.objects) {
            if (host.signal.aborted) throw new CloudError('interrupted');
            await deletion.call([
              's3api',
              'delete-object',
              '--bucket',
              b.name,
              // JSON strings prevent the CLI from treating file:// or fileb:// keys as local files.
              '--cli-input-json',
              JSON.stringify({ Key: object.key }),
              '--expected-bucket-owner',
              p.target.accountId,
              '--if-match',
              object.etag,
            ]);
            result!.deleted[b.role]++;
            record('host-archived');
          }
        const empty = await buckets(cli, p.target);
        if (empty.some((b) => b.objectCount !== 0))
          throw refused('reset buckets are not empty; STOP for owner recovery');
        // Final host verification is deliberately read-only, after all S3 operations.
        checkArchived(p, await hostJson(host, 'trial-reset-verify', archiveArgs(p, sha), archivedSchema));
      });
      if (!dryRun) {
        record('complete');
        context.report.step(
          'ok',
          'trial-reset-complete',
          `database=${result!.deleted.database}, backup=${result!.deleted.backup}; receipt=${resultFile}; archive=${p.host.archiveDirectory}`,
        );
      }
    } catch (e) {
      if (result) {
        try {
          record('failed');
        } catch {
          /* Keep the last durable receipt on a storage failure. */
        }
        context.report.line(
          `FAIL trial-reset: partial result; host or S3 may have changed; protected receipt=${resultFile}; STOP for separately approved recovery`,
        );
      }
      throw e;
    } finally {
      unsubscribe();
    }
  });
}
