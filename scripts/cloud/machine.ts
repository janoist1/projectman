import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { forbiddenEntries } from '../migrate/hybrid-entries';
import { expandHome } from './config';
import type { CloudContext, DeployContext } from './context';
import { CloudError, refused } from './errors';
import type { HostSession, HostStatus } from './host';
import { readHostStatus, readUnitFile, withHost } from './host';
import type { StepResult } from './report';
import { readSecret } from './secrets';
import { readEc2HostInstance } from './ec2-host';
import { receiveImage, receiveStagedImage, selectedImage } from './images';
import type { ReceivedImage, SelectedImage } from './images';
import { locateGithubImage, stageGithubImage, usesGithubImage } from './image-github';
import type { GithubImage } from './image-github';
import { runNumber } from './compute-job-run';

/**
 * The commands that manage the machine (PM-535): `deploy`, `rollback`, `status`, `logs`, `ssh`, `stop`,
 * `start`, `rehearse` and `pull-data`. They talk to the machine through a `withHost` session
 * (docs/AWS.md, "The machine and the installation") and to `deploy/aws/host.sh` on it.
 */

const HEALTH_ATTEMPTS = 36;
const HEALTH_INTERVAL_MS = 5_000;
const HEALTH_SECONDS = (HEALTH_ATTEMPTS * HEALTH_INTERVAL_MS) / 1000;
const BOOTSTRAP_TIMEOUT_MS = 20 * 60_000;
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
async function resolveTarget(context: CloudContext, ref: string | null): Promise<Target> {
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
  return text
    .split('\n')
    .filter((line) => !/^PROJECTMAN_RELEASE_(?:TARGET|ENGINE_ID|TARGET_HASH)=/.test(line))
    .join('\n');
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

async function showLogs(context: DeployContext, host: HostSession, lines: number): Promise<void> {
  const text = await host.call('logs', [String(lines)], { timeoutMs: 120_000 });
  for (const line of text.replace(/\n$/, '').split('\n')) context.report.line(`  | ${line}`);
}

interface HealthResult {
  healthy: boolean;
  status: HostStatus;
}

/** Polls the machine's status up to HEALTH_SECONDS for the container of `sha` to report `healthy`. */
async function waitHealthy(
  context: DeployContext,
  host: HostSession,
  sha: string,
  imageId?: string,
  platform?: string,
): Promise<HealthResult> {
  const { deps, report } = context;
  const expected = `projectman-cloud:${sha}`;
  let lastLine = '';
  let status: HostStatus | null = null;
  for (let attempt = 0; attempt < HEALTH_ATTEMPTS; attempt += 1) {
    status = await readHostStatus(host);
    const line = `unit ${status.unit}, container ${status.container}, health ${status.health}`;
    const matches = imageId
      ? status.imageId === imageId &&
        status.deploy?.current?.sha === sha &&
        status.deploy.current.imageId === imageId &&
        (!platform || status.deploy.current.platform === platform)
      : status.image === expected;
    if (status.container === 'running' && status.health === 'healthy' && matches)
      return { healthy: true, status };
    if (line !== lastLine) report.line(`  waiting: ${line}`);
    lastLine = line;
    if (attempt < HEALTH_ATTEMPTS - 1) await deps.sleep(HEALTH_INTERVAL_MS);
  }
  return { healthy: false, status: status! };
}

/** The warning that goes with every return to an older image (the migration problem). */
function migrationWarning(context: DeployContext, ref: string, stoppedAt: string | null | undefined): void {
  context.report.line(
    `note: an older build refuses a database that a newer build has migrated. If ${ref} does not become healthy, ` +
      `restore the database to ${stoppedAt ?? 'the time the board stopped before the update'} from the Litestream replica ` +
      `(point-in-time restore; ${RESTORE_DOC}).`,
  );
}

export function reportedFailure(message: string): CloudError {
  const error = new CloudError(message, 1);
  error.reported = true;
  return error;
}

// ---- deploy and rollback ----

/** Where the image comes from: a bundle on this computer, or the artifact of a GitHub run (PM-1154). */
export type ImageSource = { kind: 'bundle'; image: SelectedImage } | { kind: 'github'; github: GithubImage };

function receivedDetail(sha: string, image: ReceivedImage): string {
  return `source=${sha} platform=${image.platform} archiveSha256=${image.archiveSha256} imageId=${image.imageId}`;
}

/** Brings the image onto the machine, whichever way, and returns what was verified and imported. */
async function receiveFromSource(
  context: DeployContext,
  host: HostSession,
  target: Target,
  source: ImageSource,
): Promise<ReceivedImage> {
  const { report } = context;
  if (source.kind === 'bundle') {
    await report.run('receive-image', async (): Promise<StepResult> => {
      await receiveImage(context, host, source.image);
      return { status: 'ok', detail: receivedDetail(target.sha, source.image) };
    });
    return source.image;
  }
  const { artifact, run } = source.github;
  let staged: Awaited<ReturnType<typeof stageGithubImage>> | undefined;
  await report.run('stage-image', async (): Promise<StepResult> => {
    staged = await stageGithubImage(context, host, { sha: target.sha, github: source.github });
    return { status: 'ok', detail: `artifact=${artifact.name} bytes=${artifact.bytes} run=${run.url}` };
  });
  await report.run('receive-image', async (): Promise<StepResult> => {
    await receiveStagedImage(host, staged!.image, staged!.stage);
    return { status: 'ok', detail: receivedDetail(target.sha, staged!.image) };
  });
  return staged!.image;
}

/**
 * Where cloud.env comes from: this computer sends it (`receive-env`), or the machine's own copy is only checked
 * (`env-check`; the deploy from a GitHub runner, which holds no secrets, PM-1197).
 */
type EnvSource = { kind: 'send'; text: string } | { kind: 'machine' };

/** What a deploy left behind. `healthy` false with `rolledBack` true: the earlier image runs again (or not). */
export interface DeployOutcome {
  target: Target;
  image: ReceivedImage;
  /** The imageId running before this deploy, or null on a first deploy. */
  previousImageId: string | null;
  healthy: boolean;
  rolledBack: boolean;
  /** The tags removed by `prune-images` after a healthy deploy. */
  pruned: string[];
}

const prunedSchema = z.looseObject({ removed: z.array(z.string()) });

/** Removes the images and bundles that a rollback no longer needs; a failure here is a note, never a failed deploy. */
async function pruneImages(context: DeployContext, host: HostSession): Promise<string[]> {
  const { report } = context;
  try {
    const answer = prunedSchema.parse(
      JSON.parse(await host.call('prune-images', [], { timeoutMs: 300_000 })),
    );
    report.step(
      answer.removed.length > 0 ? 'updated' : 'unchanged',
      'prune-images',
      answer.removed.length > 0
        ? `removed ${answer.removed.map((tag) => tag.slice(0, 12)).join(', ')}`
        : 'only the current and the previous image remain',
    );
    return answer.removed;
  } catch (error) {
    report.line(
      `note: the old images were not removed (${error instanceof Error ? error.message : String(error)}); the next deploy tries again`,
    );
    return [];
  }
}

/**
 * (check env,) bootstrap, receive-image, receive-env, start; then waits for health and goes back to the earlier image
 * if it never comes. After a healthy start only the current and the previous image stay on the machine.
 */
export async function deployOnHost(
  context: DeployContext,
  host: HostSession,
  target: Target,
  env: EnvSource,
  source: ImageSource,
): Promise<DeployOutcome> {
  const { report, deps } = context;
  if (env.kind === 'machine')
    await report.run('env-check', async (): Promise<StepResult> => {
      const names = (await host.call('env-check')).trim().split('\n').filter(Boolean);
      return { status: 'ok', detail: `/etc/projectman/cloud.env has ${names.join(', ')}` };
    });
  await report.run('bootstrap', async (): Promise<StepResult> => {
    await host.call('bootstrap', [], { input: readUnitFile(deps.repoRoot), timeoutMs: BOOTSTRAP_TIMEOUT_MS });
    return { status: 'ok', detail: 'Docker, git, swap, directories, systemd unit' };
  });
  const image = await receiveFromSource(context, host, target, source);
  if (env.kind === 'send')
    await report.run('receive-env', async (): Promise<StepResult> => {
      await host.call('receive-env', [], { input: env.text });
      return { status: 'updated', detail: '/etc/projectman/cloud.env' };
    });
  const before = (await readHostStatus(host)).deploy?.current ?? null;
  const outcome = { target, image, previousImageId: before?.imageId ?? null };
  await report.run('start', async (): Promise<StepResult> => {
    await host.call('start', [target.sha, target.ref, image.imageId]);
    return { status: 'updated', detail: `${target.ref} (${target.sha.slice(0, 12)})` };
  });
  const result = await waitHealthy(context, host, target.sha, image.imageId, image.platform);
  if (result.healthy) {
    report.step('ok', 'health', `${target.ref} is healthy`);
    return { ...outcome, healthy: true, rolledBack: false, pruned: await pruneImages(context, host) };
  }
  const stoppedAt = result.status.deploy?.lastStoppedAt;
  report.line(
    `FAIL health: ${target.ref} did not become healthy in ${HEALTH_SECONDS} s (unit ${result.status.unit}, container ${result.status.container}, health ${result.status.health}); the last 200 log lines:`,
  );
  await showLogs(context, host, 200).catch((error: unknown) =>
    report.line(`  (the log could not be read: ${error instanceof Error ? error.message : String(error)})`),
  );
  let rolledBack = false;
  if (before && (before.sha !== target.sha || before.imageId !== image.imageId)) {
    report.line(`going back to ${before.ref} (${before.sha.slice(0, 12)})`);
    await report.run('rollback', async (): Promise<StepResult> => {
      await host.call('start', recordedStart(context, before));
      return { status: 'updated', detail: `${before.ref} (${before.sha.slice(0, 12)})` };
    });
    rolledBack = true;
    const restored = await waitHealthy(context, host, before.sha, before.imageId, before.platform);
    if (restored.healthy) report.step('ok', 'health', `${before.ref} is healthy again`);
    else report.line(`FAIL health: ${before.ref} is not healthy either`);
    migrationWarning(context, before.ref, stoppedAt);
  } else {
    report.line(
      'there is no earlier image to go back to; the unit keeps restarting the new one (look: npm run cloud -- logs)',
    );
  }
  return { ...outcome, healthy: false, rolledBack, pruned: [] };
}

interface DeployOptions {
  ref: string | null;
  dryRun: boolean;
  /** The GitHub run number of the image (`--run`; only with `deployment.imageSource` "github"). */
  run?: string;
}

function recordedStart(
  context: DeployContext,
  entry: NonNullable<NonNullable<HostStatus['deploy']>['current']>,
): string[] {
  if (!entry.imageId || entry.platform !== 'linux/arm64')
    throw refused('ARM start/rollback requires a recorded image ID and platform');
  return [entry.sha, entry.ref, entry.imageId];
}

export async function runDeploy(context: CloudContext, options: DeployOptions): Promise<void> {
  const { report, config } = context;
  const run = options.run === undefined ? undefined : runNumber('deploy', options.run);
  if (run !== undefined && !usesGithubImage(context))
    throw refused('deploy --run needs deployment.imageSource "github"');
  const target = await resolveTarget(context, options.ref);
  let source: ImageSource;
  let imageText: string;
  if (usesGithubImage(context)) {
    const github = await context.report.guard('image', async () => {
      const found = await locateGithubImage(context, {
        sha: target.sha,
        ...(run === undefined ? {} : { run }),
      });
      report.step(
        'ok',
        'image',
        `source=${target.sha} artifact=${found.artifact.name} bytes=${found.artifact.bytes} run=${found.run.url}`,
      );
      return found;
    });
    source = { kind: 'github', github };
    imageText = `the GitHub artifact ${github.artifact.name} (${formatBytes(github.artifact.bytes)}) that the machine downloads itself`;
  } else {
    const image = selectedImage(context, target.sha);
    source = { kind: 'bundle', image };
    imageText = `verified image ${image.imageId}`;
  }
  const envText = cloudEnvText(context);
  if (!/^TUNNEL_TOKEN=./m.test(envText))
    report.line(
      'note: cloud.env has no TUNNEL_TOKEN yet (the Cloudflare part writes it); the board is not reachable until it has one',
    );
  if (options.dryRun) {
    report.step(
      'skipped',
      'deploy',
      `dry-run: would connect by SSH through SSM, bootstrap ${config.aws.instanceName}, receive ${imageText}, send cloud.env, start it and wait up to ${HEALTH_SECONDS} s for health (back to the earlier image if it never comes)`,
    );
    return;
  }
  const outcome = await withHost(context, (host) =>
    deployOnHost(context, host, target, { kind: 'send', text: envText }, source),
  );
  if (!outcome.healthy) throw reportedFailure(`${target.ref} did not become healthy`);
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
      await host.call('start', recordedStart(context, previous));
      return { status: 'updated', detail: `${previous.ref} (${previous.sha.slice(0, 12)})` };
    });
    const result = await waitHealthy(context, host, previous.sha, previous.imageId, previous.platform);
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
      await host.call('start', recordedStart(context, current));
      return { status: 'updated', detail: `${current.ref} (${current.sha.slice(0, 12)})` };
    });
    const result = await waitHealthy(context, host, current.sha, current.imageId, current.platform);
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
  const { config, report } = context;
  const state = await report.guard('machine', async () => {
    const instance = await readEc2HostInstance(context);
    report.step(
      'ok',
      'machine',
      `${config.aws.instanceName} (${instance.InstanceId}): ${instance.State.Name}`,
    );
    return instance.State.Name;
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

interface PullOptions {
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
        const lost = result.code !== 0 ? host.transportError('send-data', result) : null;
        if (lost) throw lost;
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
