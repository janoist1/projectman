import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { forbiddenEntries } from '../migrate/hybrid-entries';
import { AwsCli } from './aws-cli';
import { expandHome } from './config';
import type { CloudContext } from './context';
import { CloudError, refused } from './errors';
import type { HostSession, HostStatus } from './host';
import { readHostStatus, readUnitFile, withHost } from './host';
import type { StepResult } from './report';
import { readSecret } from './secrets';
import { readEc2HostInstance } from './ec2-host';

/**
 * The commands that manage the machine (PM-535): `deploy`, `rollback`, `status`, `logs`, `ssh`, `stop`,
 * `start`, `rehearse`, `seed` and `pull-data`. They talk to the machine through a `withHost` session
 * (docs/AWS.md, "The machine and the installation") and to `deploy/aws/host.sh` on it.
 */

const HEALTH_ATTEMPTS = 36;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_SECONDS = (HEALTH_ATTEMPTS * HEALTH_INTERVAL_MS) / 1000;
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;
const BUILD_TIMEOUT_MS = 60 * 60_000;
const REHEARSE_TIMEOUT_MS = 30 * 60_000;
const SHA = /^[0-9a-f]{40}$/;
const TAG_NAME = /^[A-Za-z0-9._-]{1,100}$/;
/** `vYYYY.M.D`, `.N` for the second and later release of a day (docs/DEPLOY.md). */
const RELEASE_TAG = /^v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/;
const RESTORE_DOC = 'docs/AWS.md, "Restoring the database to a point in time"';

const seedCheckSchema = z.looseObject({
  container: z.enum(['running', 'stopped']),
  dataEmpty: z.boolean(),
});
const seedDigestSchema = z.strictObject({
  databaseSha256: z.string().regex(/^[0-9a-f]{64}$/),
  databaseBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

/** Read a closed package without opening SQLite; detect replacement and writes during hashing. */
function sourceDigest(directory: string, initial: boolean): z.output<typeof seedDigestSchema> {
  const invalid = (message: string, precondition = initial): never => {
    throw precondition ? refused(message) : new CloudError(message);
  };
  const database = path.join(directory, 'db.sqlite');
  const check = (precondition: boolean) => {
    const stat = fs.lstatSync(database, { throwIfNoEntry: false, bigint: true });
    if (!stat?.isFile())
      invalid('the source has no db.sqlite regular file (symlinks are refused)', precondition);
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (fs.lstatSync(`${database}${suffix}`, { throwIfNoEntry: false }))
        invalid(`the source has a db.sqlite${suffix} sidecar; the package must be closed`, precondition);
    }
    return stat!;
  };
  const fingerprint = (stat: fs.BigIntStats) =>
    [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  const before = check(initial);
  if (before.size <= 0n || before.size > BigInt(Number.MAX_SAFE_INTEGER))
    invalid('the source database size must be a positive safe integer');
  const fd = fs.openSync(database, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    if (fingerprint(fs.fstatSync(fd, { bigint: true })) !== fingerprint(before))
      throw new CloudError('the source database changed before hashing');
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let bytes = 0;
    for (;;) {
      const count = fs.readSync(fd, buffer);
      if (count === 0) break;
      hash.update(buffer.subarray(0, count));
      bytes += count;
    }
    if (
      fingerprint(before) !== fingerprint(check(false)) ||
      fingerprint(before) !== fingerprint(fs.fstatSync(fd, { bigint: true })) ||
      BigInt(bytes) !== before.size
    )
      throw new CloudError('the source database changed during hashing');
    return { databaseSha256: hash.digest('hex'), databaseBytes: bytes };
  } finally {
    fs.closeSync(fd);
  }
}
const objectsSchema = z.looseObject({
  Contents: z.array(z.looseObject({})).optional(),
  KeyCount: z.number().optional(),
});
const instanceStateSchema = z.looseObject({
  state: z.looseObject({ name: z.string() }),
});

// ---- what to deploy ----

export interface Target {
  sha: string;
  /** The tag, or the commit id when a commit id was asked for. */
  ref: string;
}

interface TagEntry {
  name: string;
  sha: string;
}

/** The tags of `git ls-remote --tags`, each with the commit it points to (the peeled `^{}` line wins). */
export function parseTags(output: string): TagEntry[] {
  const tags = new Map<string, string>();
  const peeled = new Map<string, string>();
  for (const line of output.split('\n')) {
    const match = /^([0-9a-f]{40})\s+refs\/tags\/(\S+?)(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    (match[3] ? peeled : tags).set(match[2]!, match[1]!);
  }
  return [...tags.keys()].map((name) => ({ name, sha: peeled.get(name) ?? tags.get(name)! }));
}

function releaseOrder(name: string): number[] | null {
  const match = RELEASE_TAG.exec(name);
  return match ? [match[1], match[2], match[3], match[4] ?? '0'].map(Number) : null;
}

function compareRelease(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The commit and ref to deploy: `--ref` (a tag or a 40-digit commit id) or the newest release tag. */
export async function resolveTarget(context: CloudContext, ref: string | null): Promise<Target> {
  const { deps, config, report } = context;
  return report.guard('ref', async () => {
    let target: Target;
    if (ref !== null && SHA.test(ref)) {
      target = { sha: ref, ref };
    } else {
      if (ref !== null && !TAG_NAME.test(ref))
        throw refused(`"${ref}" is neither a tag nor a 40-digit commit id`);
      const result = await deps.run('git', ['ls-remote', '--tags', config.repository.url], {
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeoutMs: 60_000,
      });
      if (result.code !== 0)
        throw new CloudError(
          `git ls-remote --tags ${config.repository.url} failed: ${result.stderr.trim().split('\n').slice(-1)[0] ?? result.code}`,
        );
      const tags = parseTags(result.stdout);
      if (ref !== null) {
        const found = tags.find((tag) => tag.name === ref);
        if (!found) throw refused(`${config.repository.url} has no tag ${ref}`);
        target = { sha: found.sha, ref };
      } else {
        const releases = tags
          .map((tag) => ({ tag, order: releaseOrder(tag.name) }))
          .filter((item): item is { tag: TagEntry; order: number[] } => item.order !== null)
          .sort((a, b) => compareRelease(b.order, a.order));
        const newest = releases[0]?.tag;
        if (!newest) throw refused(`${config.repository.url} has no release tag (vYYYY.M.D); give --ref`);
        target = { sha: newest.sha, ref: newest.name };
      }
    }
    report.step('ok', 'ref', `${target.ref} (${target.sha})`);
    return target;
  });
}

// ---- reading and showing the machine ----

function cloudEnvText(context: CloudContext): string {
  const text = readSecret(context.envFile);
  if (text === null) throw refused(`no ${context.envFile}; run \`npm run cloud -- aws\` first`);
  const names = new Set(
    text
      .split('\n')
      .map((line) => line.slice(0, Math.max(line.indexOf('='), 0)))
      .filter(Boolean),
  );
  for (const required of [
    'LITESTREAM_BUCKET',
    'LITESTREAM_ACCESS_KEY_ID',
    'RESTIC_REPOSITORY',
    'RESTIC_PASSWORD',
  ])
    if (!names.has(required))
      throw refused(`${context.envFile} has no ${required}; run \`npm run cloud -- aws\` first`);
  for (const line of text.split('\n')) {
    const equals = line.indexOf('=');
    if (equals > 0 && /SECRET|PASSWORD|TOKEN/.test(line.slice(0, equals)))
      context.report.protect(line.slice(equals + 1));
  }
  return text;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function describeStatus(context: CloudContext, status: HostStatus): void {
  const { report } = context;
  const deploy = status.deploy;
  const entry = (item: { sha: string; ref: string; at: string } | null | undefined) =>
    item ? `${item.ref} (${item.sha.slice(0, 12)}), ${item.at}` : 'none';
  report.line(`unit: ${status.unit}`);
  report.line(
    `container: ${status.container}${status.health !== 'none' ? `, ${status.health}` : ''}${status.image ? `, ${status.image}` : ''}`,
  );
  report.line(`current: ${entry(deploy?.current)}`);
  report.line(`previous: ${entry(deploy?.previous)}`);
  report.line(`last stopped: ${deploy?.lastStoppedAt ?? 'never recorded'}`);
  report.line(
    `data: ${formatBytes(status.disk.dataBytes)}, free disk: ${formatBytes(status.disk.freeBytes)}`,
  );
  const memory = status.memory;
  if (memory.totalBytes !== undefined && memory.availableBytes !== undefined)
    report.line(
      `memory: ${formatBytes(memory.availableBytes)} available of ${formatBytes(memory.totalBytes)}, swap ${formatBytes(memory.swapUsedBytes ?? 0)} of ${formatBytes(memory.swapTotalBytes ?? 0)}`,
    );
}

async function showLogs(context: CloudContext, host: HostSession, lines: number): Promise<void> {
  const text = await host.call('logs', [String(lines)], { timeoutMs: 120_000 });
  for (const line of text.replace(/\n$/, '').split('\n')) context.report.line(`  | ${line}`);
}

interface HealthResult {
  healthy: boolean;
  status: HostStatus;
}

/** Polls the machine's status up to HEALTH_SECONDS for the container of `sha` to report `healthy`. */
async function waitHealthy(context: CloudContext, host: HostSession, sha: string): Promise<HealthResult> {
  const { deps, report } = context;
  const expected = `projectman-cloud:${sha}`;
  let lastLine = '';
  let status: HostStatus | null = null;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    status = await readHostStatus(host);
    const line = `unit ${status.unit}, container ${status.container}, health ${status.health}`;
    if (status.container === 'running' && status.health === 'healthy' && status.image === expected)
      return { healthy: true, status };
    if (line !== lastLine) report.line(`  waiting: ${line}`);
    lastLine = line;
    if (attempt < HEALTH_ATTEMPTS - 1) await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return { healthy: false, status: status! };
}

/** The warning that goes with every return to an older image (the migration problem). */
function migrationWarning(context: CloudContext, ref: string, stoppedAt: string | null | undefined): void {
  context.report.line(
    `note: an older build refuses a database that a newer build has migrated. If ${ref} does not become healthy, ` +
      `restore the database to ${stoppedAt ?? 'the time the board stopped before the update'} from the Litestream replica ` +
      `(point-in-time restore; ${RESTORE_DOC}).`,
  );
}

function reportedFailure(message: string): CloudError {
  const error = new CloudError(message, 1);
  error.reported = true;
  return error;
}

// ---- deploy and rollback ----

/** bootstrap, receive-env, build, start; then waits for health and goes back to the earlier image if it never comes. */
async function deployOnHost(
  context: CloudContext,
  host: HostSession,
  target: Target,
  envText: string,
): Promise<void> {
  const { config, report, deps } = context;
  await report.run('bootstrap', async (): Promise<StepResult> => {
    await host.call('bootstrap', [], { input: readUnitFile(deps.repoRoot), timeoutMs: BOOTSTRAP_TIMEOUT_MS });
    return { status: 'ok', detail: 'Docker, git, swap, directories, systemd unit' };
  });
  await report.run('receive-env', async (): Promise<StepResult> => {
    await host.call('receive-env', [], { input: envText });
    return { status: 'updated', detail: '/etc/projectman/cloud.env' };
  });
  const before = (await readHostStatus(host)).deploy?.current ?? null;
  await report.run('build', async (): Promise<StepResult> => {
    await host.call('build', [target.sha, config.repository.url], {
      timeoutMs: BUILD_TIMEOUT_MS,
      stdio: 'inherit',
    });
    return { status: 'created', detail: `projectman-cloud:${target.sha.slice(0, 12)}` };
  });
  await report.run('start', async (): Promise<StepResult> => {
    await host.call('start', [target.sha, target.ref]);
    return { status: 'updated', detail: `${target.ref} (${target.sha.slice(0, 12)})` };
  });
  const result = await waitHealthy(context, host, target.sha);
  if (result.healthy) {
    report.step('ok', 'health', `${target.ref} is healthy`);
    return;
  }
  const stoppedAt = result.status.deploy?.lastStoppedAt;
  report.line(
    `FAIL health: ${target.ref} did not become healthy in ${HEALTH_SECONDS} s (unit ${result.status.unit}, container ${result.status.container}, health ${result.status.health}); the last 200 log lines:`,
  );
  await showLogs(context, host, 200).catch((error: unknown) =>
    report.line(`  (the log could not be read: ${error instanceof Error ? error.message : String(error)})`),
  );
  if (before && before.sha !== target.sha) {
    report.line(`going back to ${before.ref} (${before.sha.slice(0, 12)})`);
    await report.run('rollback', async (): Promise<StepResult> => {
      await host.call('start', [before.sha, before.ref]);
      return { status: 'updated', detail: `${before.ref} (${before.sha.slice(0, 12)})` };
    });
    const restored = await waitHealthy(context, host, before.sha);
    if (restored.healthy) report.step('ok', 'health', `${before.ref} is healthy again`);
    else report.line(`FAIL health: ${before.ref} is not healthy either`);
    migrationWarning(context, before.ref, stoppedAt);
  } else {
    report.line(
      'there is no earlier image to go back to; the unit keeps restarting the new one (look: npm run cloud -- logs)',
    );
  }
  throw reportedFailure(`${target.ref} did not become healthy`);
}

export interface DeployOptions {
  ref: string | null;
  dryRun: boolean;
}

export async function runDeploy(context: CloudContext, options: DeployOptions): Promise<void> {
  const { report, config } = context;
  const target = await resolveTarget(context, options.ref);
  const envText = cloudEnvText(context);
  if (!/^TUNNEL_TOKEN=./m.test(envText))
    report.line(
      'note: cloud.env has no TUNNEL_TOKEN yet (the Cloudflare part writes it); the board is not reachable until it has one',
    );
  if (options.dryRun) {
    report.step(
      'skipped',
      'deploy',
      `dry-run: would ${config.aws.compute === 'ec2' ? 'connect by SSH through SSM' : 'open the SSH port for your address'}, bootstrap ${config.aws.instanceName}, send cloud.env, build ${target.sha} there, start it and wait up to ${HEALTH_SECONDS} s for health (back to the earlier image if it never comes)`,
    );
    return;
  }
  await withHost(context, (host) => deployOnHost(context, host, target, envText));
}

export async function runRollback(context: CloudContext, options: { dryRun: boolean }): Promise<void> {
  const { report } = context;
  if (options.dryRun) {
    report.step(
      'skipped',
      'rollback',
      'dry-run: would start the previous image of deploy.json and wait for health',
    );
    return;
  }
  await withHost(context, async (host) => {
    const status = await readHostStatus(host);
    const previous = status.deploy?.previous ?? null;
    if (!previous) throw refused('there is no previous image to go back to (deploy.json has none)');
    const stoppedAt = status.deploy?.lastStoppedAt;
    await report.run('start', async (): Promise<StepResult> => {
      await host.call('start', [previous.sha, previous.ref]);
      return { status: 'updated', detail: `${previous.ref} (${previous.sha.slice(0, 12)})` };
    });
    const result = await waitHealthy(context, host, previous.sha);
    migrationWarning(context, previous.ref, stoppedAt);
    if (!result.healthy) {
      report.line(
        `FAIL health: ${previous.ref} did not become healthy in ${HEALTH_SECONDS} s; the last 200 log lines:`,
      );
      await showLogs(context, host, 200).catch(() => undefined);
      throw reportedFailure(`${previous.ref} did not become healthy`);
    }
    report.step('ok', 'health', `${previous.ref} is healthy`);
  });
}

// ---- the unit ----

export async function runStart(context: CloudContext, options: { dryRun: boolean }): Promise<void> {
  const { report } = context;
  if (options.dryRun) {
    report.step(
      'skipped',
      'start',
      'dry-run: would start the current image of deploy.json and wait for health',
    );
    return;
  }
  await withHost(context, async (host) => {
    const status = await readHostStatus(host);
    const current = status.deploy?.current ?? null;
    if (!current) throw refused('nothing has been deployed yet; run `npm run cloud -- deploy`');
    await report.run('start', async (): Promise<StepResult> => {
      await host.call('start', [current.sha, current.ref]);
      return { status: 'updated', detail: `${current.ref} (${current.sha.slice(0, 12)})` };
    });
    const result = await waitHealthy(context, host, current.sha);
    if (!result.healthy) {
      report.line(
        `FAIL health: ${current.ref} did not become healthy in ${HEALTH_SECONDS} s; the last 100 log lines:`,
      );
      await showLogs(context, host, 100).catch(() => undefined);
      throw reportedFailure(`${current.ref} did not become healthy`);
    }
    report.step('ok', 'health', `${current.ref} is healthy`);
  });
}

export async function runStop(context: CloudContext, options: { dryRun: boolean }): Promise<void> {
  const { report } = context;
  if (options.dryRun) {
    report.step('skipped', 'stop', 'dry-run: would stop and disable the unit and record when it stopped');
    return;
  }
  await withHost(context, async (host) => {
    await report.run('stop', async (): Promise<StepResult> => {
      await host.call('stop', [], { timeoutMs: 5 * 60_000 });
      return { status: 'updated', detail: 'the board is stopped (the data stays); `start` brings it back' };
    });
  });
}

// ---- looking at the machine ----

export async function runStatus(context: CloudContext): Promise<void> {
  const { config, report, deps } = context;
  const cli = new AwsCli(deps, config.aws);
  const state = await report.guard('machine', async () => {
    if (config.aws.compute === 'ec2') {
      const instance = await readEc2HostInstance(context);
      report.step(
        'ok',
        'machine',
        `${config.aws.instanceName} (${instance.InstanceId}): ${instance.State.Name}`,
      );
      return instance.State.Name;
    }
    const answer = await cli.callAsOrNull(
      ['lightsail', 'get-instance-state', '--instance-name', config.aws.instanceName],
      ['NotFoundException'],
      instanceStateSchema,
    );
    if (!answer)
      throw refused(`there is no machine ${config.aws.instanceName}; run \`npm run cloud -- aws\` first`);
    report.step('ok', 'machine', `${config.aws.instanceName}: ${answer.state.name}`);
    return answer.state.name;
  });
  if (state !== 'running') {
    report.step('skipped', 'host', `the machine is ${state}`);
    return;
  }
  await withHost(context, async (host) => {
    describeStatus(context, await readHostStatus(host));
  });
}

export async function runLogs(context: CloudContext, options: { lines: number }): Promise<void> {
  await withHost(context, async (host) => {
    const text = await host.call('logs', [String(options.lines)], { timeoutMs: 120_000 });
    for (const line of text.replace(/\n$/, '').split('\n')) context.report.line(line);
  });
}

export async function runSsh(context: CloudContext): Promise<void> {
  await withHost(context, async (host) => {
    const result = await host.shell();
    // 255 is ssh's own failure; any other status is the last command typed in the shell.
    if (result.code === 255) throw new CloudError('ssh could not connect to the machine');
    if (result.code === 130) throw new CloudError('interrupted');
  });
}

export async function runRehearse(context: CloudContext): Promise<void> {
  const { report } = context;
  await withHost(context, async (host) => {
    const result = await host.run('rehearse', [], { timeoutMs: REHEARSE_TIMEOUT_MS });
    if (host.signal.aborted) throw new CloudError('interrupted');
    const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => line.trim() !== '');
    for (const line of lines.slice(-40)) report.line(`  | ${line}`);
    if (result.code !== 0 && !lines.some((line) => line.includes('REHEARSAL PASSED')))
      throw new CloudError(`the rehearsal failed (status ${result.code})`);
    if (!lines.some((line) => line.includes('REHEARSAL PASSED')))
      throw new CloudError('the rehearsal printed no REHEARSAL PASSED line');
    report.step(
      'ok',
      'rehearse',
      'REHEARSAL PASSED (the replica and the snapshot restored in a scratch container)',
    );
  });
}

// ---- moving the data ----

async function readSeedCheck(host: HostSession): Promise<z.output<typeof seedCheckSchema>> {
  const text = await host.call('seed-check');
  try {
    return seedCheckSchema.parse(JSON.parse(text));
  } catch {
    throw new CloudError('the machine answered seed-check in an unexpected shape');
  }
}

export interface SeedOptions {
  from: string;
  ref: string | null;
  dryRun: boolean;
}

export async function runSeed(context: CloudContext, options: SeedOptions): Promise<void> {
  const { config, report, deps } = context;
  const directory = path.resolve(expandHome(options.from, deps.homeDir));
  const cli = new AwsCli(deps, config.aws);

  const before = await report.guard('seed-source', async () => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(directory);
    } catch {
      throw refused(`${directory} does not exist`);
    }
    if (!stat.isDirectory()) throw refused(`${directory} is not a directory`);
    const digest = await report.guard('seed-integrity', async () => sourceDigest(directory, true));
    const forbidden = forbiddenEntries(directory);
    if (forbidden.length > 0)
      throw refused(
        `${directory} holds what the cloud must not get: ${forbidden.map((item) => `${item.name} (${item.why})`).join('; ')}`,
      );
    report.step('ok', 'seed-source', directory);
    return digest;
  });
  const target = await resolveTarget(context, options.ref);
  const envText = cloudEnvText(context);
  for (const bucket of [config.aws.databaseBucket, config.aws.backupBucket]) {
    await report.run(`bucket-empty ${bucket}`, async (): Promise<StepResult> => {
      const answer = await cli.callAsOrNull(
        ['s3api', 'list-objects-v2', '--bucket', bucket, '--max-keys', '1'],
        ['NoSuchBucket'],
        objectsSchema,
      );
      if (!answer) throw refused(`the bucket ${bucket} does not exist; run \`npm run cloud -- aws\` first`);
      if ((answer.Contents?.length ?? 0) > 0 || (answer.KeyCount ?? 0) > 0)
        throw refused(
          `the bucket ${bucket} is not empty, so the cloud already has (or had) a replica; a seed would collide with it`,
        );
      return { status: 'ok', detail: 'nothing in it' };
    });
  }
  report.line(
    'note: the instance on the Mac must be stopped before the seed, or its changes since the package are lost (docs/HYBRID.md)',
  );
  if (options.dryRun) {
    report.step(
      'skipped',
      'seed',
      `dry-run: would check over ssh that the board is not running and the data directory is empty, upload ${directory}, require seed-integrity (source before/after and host database sha256/bytes), then deploy ${target.ref}`,
    );
    return;
  }
  await withHost(context, async (host) => {
    await report.run('bootstrap', async (): Promise<StepResult> => {
      await host.call('bootstrap', [], {
        input: readUnitFile(deps.repoRoot),
        timeoutMs: BOOTSTRAP_TIMEOUT_MS,
      });
      return { status: 'ok' };
    });
    await report.run('seed-check', async (): Promise<StepResult> => {
      const check = await readSeedCheck(host);
      if (check.container === 'running')
        throw refused('the board is running on the machine; a seed goes in before the first start');
      if (!check.dataEmpty)
        throw refused(
          '/var/lib/projectman/data on the machine is not empty; a seed fills an empty machine only',
        );
      return { status: 'ok', detail: 'the board is stopped and the data directory is empty' };
    });
    await report.run('seed-upload', async (): Promise<StepResult> => {
      const receive = await host.command('receive-data');
      const result = await deps.pipe(
        { command: 'tar', args: ['-C', directory, '-c', '.'], env: { COPYFILE_DISABLE: '1' } },
        receive,
      );
      if (host.signal.aborted) throw new CloudError('interrupted');
      if (result.code === 3)
        throw refused('the host refused receive-data; the target state no longer permits a seed');
      if (result.code !== 0)
        throw new CloudError(
          `the upload failed (status ${result.code}): ${result.stderr.trim().split('\n').slice(-2).join(' | ')}`,
        );
      return { status: 'created', detail: `${directory} to /var/lib/projectman/data` };
    });
    await report.run('seed-integrity', async (): Promise<StepResult> => {
      const text = await host.call('seed-digest');
      let remote: z.output<typeof seedDigestSchema>;
      try {
        remote = seedDigestSchema.parse(JSON.parse(text));
      } catch {
        throw new CloudError('the machine answered seed-digest in an unexpected shape');
      }
      const after = sourceDigest(directory, false);
      for (const digest of [after, remote]) {
        if (digest.databaseSha256 !== before.databaseSha256 || digest.databaseBytes !== before.databaseBytes)
          throw new CloudError(
            'database hash or size changed or differs from the uploaded package; STOP and request owner recovery',
          );
      }
      return {
        status: 'ok',
        detail: `database sha256=${before.databaseSha256} bytes=${before.databaseBytes} (before first start)`,
      };
    });
    await deployOnHost(context, host, target, envText);
  });
}

export interface PullOptions {
  to: string;
  dryRun: boolean;
}

function insideGitWorkTree(directory: string): string | null {
  let current = path.dirname(directory);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function runPullData(context: CloudContext, options: PullOptions): Promise<void> {
  const { report, deps } = context;
  const directory = path.resolve(expandHome(options.to, deps.homeDir));
  await report.run('pull-target', async (): Promise<StepResult> => {
    if (fs.existsSync(directory) || fs.lstatSync(directory, { throwIfNoEntry: false }))
      throw refused(`${directory} already exists; give a new directory`);
    let parent: fs.Stats;
    try {
      parent = fs.statSync(path.dirname(directory));
    } catch {
      throw refused(`${path.dirname(directory)} does not exist`);
    }
    if (!parent.isDirectory()) throw refused(`${path.dirname(directory)} is not a directory`);
    const tree = insideGitWorkTree(directory);
    if (tree)
      throw refused(
        `${directory} is inside the git work tree ${tree}; the data must not land in a repository`,
      );
    return { status: 'ok', detail: directory };
  });
  if (options.dryRun) {
    report.step(
      'skipped',
      'pull-data',
      `dry-run: would check over ssh that the board is stopped, then download /var/lib/projectman/data to ${directory} (mode 700)`,
    );
    return;
  }
  await withHost(context, async (host) => {
    await report.run('seed-check', async (): Promise<StepResult> => {
      const check = await readSeedCheck(host);
      if (check.container === 'running')
        throw refused(
          'the board is running; stop it first (`npm run cloud -- stop`): a copy of a live database is no copy',
        );
      return { status: 'ok', detail: 'the board is stopped' };
    });
    let created = false;
    try {
      await report.run('pull-data', async (): Promise<StepResult> => {
        fs.mkdirSync(directory, { mode: 0o700 });
        created = true;
        fs.chmodSync(directory, 0o700);
        const send = await host.command('send-data');
        const result = await deps.pipe(send, {
          command: 'tar',
          args: ['-x', '-p', '-f', '-', '-C', directory],
        });
        if (host.signal.aborted) throw new CloudError('interrupted');
        if (result.code !== 0)
          throw new CloudError(
            `the download failed (status ${result.code}): ${result.stderr.trim().split('\n').slice(-2).join(' | ')}`,
          );
        return { status: 'created', detail: directory };
      });
    } catch (error) {
      // What came is partial and ours to remove: the directory did not exist before.
      if (created) fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    const forbidden = forbiddenEntries(directory, { cloudData: true });
    if (forbidden.length === 0)
      report.step('ok', 'check-entries', 'nothing the way back (PM-318) would refuse');
    else
      for (const item of forbidden)
        report.line(
          `note: ${item.name} in the copy: ${item.why} (the way back, \`npm run migrate -- hybrid back\`, will refuse it)`,
        );
  });
}
