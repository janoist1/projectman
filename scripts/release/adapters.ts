import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ControlResponse,
  parseControlRequestInput,
  RELEASE_TAG_PATTERN,
  ReleaseImageRef,
  releaseTagName,
} from '@projectman/shared';
import type {
  ControlRequest,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseEngineStatus,
} from '@projectman/shared';
import { z } from 'zod';
import { engineFiles } from '../../apps/server/src/engine-link/engine-config';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import { acquireHeavyLock, defaultHeavyLockDir, HeavyLockError } from '../../apps/server/src/full-test';
import { AwsCli } from '../cloud/aws-cli';
import type { CloudContext } from '../cloud/context';
import { CloudError, CloudTransportError, refused } from '../cloud/errors';
import { readEc2HostInstance } from '../cloud/ec2-host';
import { readHostStatus, withHost } from '../cloud/host';
import type { HostSession } from '../cloud/host';
import { receiveImage } from '../cloud/images';
import { probeReleaseImage, startPreparedImage, waitImageHealthy } from '../cloud/machine';
import { installService, installedServiceFor, SERVICE_LABEL, servicePathEnv } from '../engine/service';
import type { LaunchctlResult } from '../engine/service';
import { bootout, bootstrap, isLoaded, launchctl, waitUntil } from '../live/launchd';
import type { LaunchdDeps } from '../live/launchd';
import { agentsDir, domainTarget, githubSlug, GITHUB_REMOTE_PATTERN, plistFile } from '../live/paths';
import { installedProgramArguments } from '../live/plist';
import { unescapeXml } from '../live/plist';
import { assertCleanAt } from './checkout';
import { isWithin } from './config';
import type { LoadedHybridConfig } from './config';
import { oldLiveJournalExists } from './journal';
import type { JournalPort } from './journal';
import { prepareHybridRelease } from './prepare';
import { ControlError } from './ports';
import type {
  Clock,
  CloudControl,
  CloudImageProbe,
  CloudMachine,
  CoordinatorPorts,
  DeployView,
  EngineControl,
  EngineState,
  HeavyLockPort,
  PreparePort,
  PublishPort,
} from './ports';
import { RECEIPT_FILE } from './receipt';
import { verifyPreparedRelease } from './verify';

/**
 * The real ports of the hybrid coordinator (PM-751): AWS and the machine over the verified SSH-over-SSM session,
 * the board's control socket through the machine's fixed relay, launchd and git on this Mac. Every outside
 * effect arrives through the `HybridWorld` the commands build, so a test drives the same code against fakes.
 * Nothing here decides anything: a port reports what it saw (or what it could not prove) and the coordinator
 * chooses the next step.
 */

/** The relay answers within the client's own 30 s; the rest is the connection through SSH/SSM. */
const RELAY_TIMEOUT_MS = 90_000;
const GIT_TIMEOUT_MS = 300_000;
const ENGINE_STOP_WAIT_MS = 60_000;
const ENGINE_BOOTSTRAP_TRIES = 61;
const ACCOUNT_ID = /^\d{12}$/;
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };

/** What the real ports need from the outside; the tests give fakes of the same shape. */
export interface HybridWorld {
  context: CloudContext;
  launchd: LaunchdDeps;
  /** `launchctl` without waiting for a promise: the engine service helper installs with it. */
  launchctlSync(args: string[]): LaunchctlResult;
  isPidAlive(pid: number): boolean;
  /** The admin checkout the watcher runs from. */
  root: string;
  nodePath: string;
  platform: NodeJS.Platform;
  out(text: string): void;
}

// ---- the board's control socket through the machine's relay ---------------------------------------

const answerLine = (stdout: string): string | null => {
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  return body && !body.includes('\n') ? body : null;
};

/** Sends one control request; the three kinds of `ControlError` tell the coordinator what may have happened. */
export async function relayRequest(context: CloudContext, request: ControlRequest): Promise<ControlResponse> {
  const input = parseControlRequestInput(Buffer.from(`${JSON.stringify(request)}\n`));
  if (!input.ok) throw new ControlError('unavailable', 'request_invalid', input.reason);
  let started = false;
  let answer: ControlResponse | null = null;
  try {
    await withHost(context, async (host) => {
      started = true;
      const result = await host.run('release-control', [], {
        input: `${input.line}\n`,
        timeoutMs: RELAY_TIMEOUT_MS,
      });
      if (host.signal.aborted)
        throw new ControlError('uncertain', 'interrupted', 'the request was interrupted');
      if (result.code === 3)
        throw new ControlError('unavailable', 'board_not_running', 'the machine did not run the request');
      if (result.code !== 0) {
        const lost = host.transportError('release-control', result);
        if (lost instanceof CloudTransportError && lost.commandStarted === 'no')
          throw new ControlError('unavailable', 'cloud_transport', 'the request never reached the machine');
        throw new ControlError('uncertain', 'cloud_transport', 'the answer of the machine was lost');
      }
      const line = answerLine(result.stdout);
      const parsed = line === null ? null : parseAnswer(line);
      if (!parsed)
        throw new ControlError('uncertain', 'bad_answer', 'the board answered in an unexpected shape');
      answer = parsed;
    });
  } catch (error) {
    if (error instanceof ControlError) throw error;
    // The answer is in hand: a failure of the session's teardown does not change what the board said.
    if (answer === null) {
      if (!started)
        throw new ControlError('unavailable', 'cloud_unreachable', 'the machine could not be reached');
      throw new ControlError('uncertain', 'cloud_transport', 'the answer of the machine was lost');
    }
  }
  const response = answer as ControlResponse | null;
  if (!response) throw new ControlError('uncertain', 'bad_answer', 'the board did not answer');
  if (!response.ok) throw new ControlError('refused', response.error.code, response.error.message);
  return response;
}

function parseAnswer(line: string): ControlResponse | null {
  try {
    const parsed = ControlResponse.safeParse(JSON.parse(line));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const view = (answer: ControlResponse): DeployView => {
  if (!answer.ok || !answer.release || !answer.drain || answer.databaseSchemaVersion === undefined)
    throw new ControlError(
      'uncertain',
      'bad_answer',
      'the board answered the deployment in an unexpected shape',
    );
  return {
    release: answer.release,
    deployment: answer.deployment ?? null,
    drain: answer.drain,
    databaseSchemaVersion: answer.databaseSchemaVersion,
  };
};

export function relayControl(context: CloudContext): CloudControl {
  const send = (request: ControlRequest) => relayRequest(context, request);
  return {
    async releaseNext() {
      const answer = await send({ op: 'release_next' });
      return answer.ok ? (answer.release ?? null) : null;
    },
    async deployGet(releaseId: string) {
      return view(await send({ op: 'release_deploy_get', releaseId }));
    },
    async begin(body: ReleaseDeployBegin) {
      return view(await send({ op: 'release_deploy_begin', ...body }));
    },
    async change(body: ReleaseDeployChange) {
      return view(await send({ op: 'release_deploy_change', ...body }));
    },
    async engines() {
      const answer = await send({ op: 'engine_status' });
      const engines: ReleaseEngineStatus[] = answer.ok ? (answer.engines ?? []) : [];
      return { appVersion: answer.ok ? (answer.appVersion ?? null) : null, engines };
    },
  };
}

// ---- the cloud machine ----------------------------------------------------------------------------

const callerSchema = z.looseObject({ Account: z.string() });

/** The image the machine's deploy record names as current, when it is a valid linux/arm64 image reference. */
const currentOf = (status: Awaited<ReturnType<typeof readHostStatus>>) => {
  const current = status.deploy?.current;
  if (!current) return null;
  const parsed = ReleaseImageRef.safeParse({
    commit: current.sha,
    imageId: current.imageId,
    platform: current.platform,
  });
  return parsed.success ? parsed.data : null;
};

export function machinePort(
  context: CloudContext,
  expected: { accountId: string; instanceId: string },
): CloudMachine {
  const onHost = <T>(body: (host: HostSession) => Promise<T>) => withHost(context, body);
  return {
    async verifyTarget() {
      const identity = await new AwsCli(context.deps, context.config.aws).callAs(
        ['sts', 'get-caller-identity'],
        callerSchema,
      );
      if (!ACCOUNT_ID.test(identity.Account) || identity.Account !== expected.accountId)
        throw refused('the AWS account is not the configured one');
      const instance = await readEc2HostInstance(context);
      if (instance.InstanceId !== expected.instanceId)
        throw refused('the managed EC2 instance is not the configured one');
      if (instance.State.Name !== 'running') throw refused('the cloud machine is not running');
    },
    current: () => onHost(async (host) => currentOf(await readHostStatus(host))),
    probe: (image) =>
      onHost(async (host): Promise<CloudImageProbe> => {
        const probe = await probeReleaseImage(context, host, image);
        const current = currentOf(probe.status);
        return {
          current,
          healthy:
            current !== null &&
            probe.status.container === 'running' &&
            probe.status.health === 'healthy' &&
            probe.status.imageId === current.imageId,
          imagePresent: probe.imagePresent,
          imageVerified: probe.imageVerified,
          lockHeld: probe.imageLockHeld,
          schemaVersion: probe.databaseSchemaVersion,
        };
      }),
    importImage: (image) => onHost((host) => receiveImage(context, host, image)),
    start: (image) => onHost((host) => startPreparedImage(context, host, image)),
    waitHealthy: (image) => onHost(async (host) => (await waitImageHealthy(context, host, image)).healthy),
  };
}

// ---- the engine on this Mac -----------------------------------------------------------------------

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function plistString(plist: string, key: string): string | null {
  const match = new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`).exec(plist);
  return match ? unescapeXml(match[1]!) : null;
}

export interface EngineOptions {
  engineHome: string;
  stateDir: string;
}

export function enginePort(world: HybridWorld, options: EngineOptions): EngineControl {
  const { launchd } = world;
  const installedPlist = () => installedServiceFor(options.engineHome, agentsDir(launchd.homeDir));
  const readInstalled = (): { file: string; bytes: Buffer } | null => {
    const file = installedPlist();
    if (!file) return null;
    return { file, bytes: fs.readFileSync(file) };
  };
  const pidOf = (printed: string): number | null => {
    const match = /^\s*pid = (\d+)/m.exec(printed);
    return match ? Number(match[1]) : null;
  };
  return {
    async state(): Promise<EngineState> {
      const printed = await launchctl(launchd, ['print', domainTarget(launchd.uid, SERVICE_LABEL)]);
      const loaded = printed.status === 0;
      const pid = loaded ? pidOf(printed.stdout) : null;
      const installed = readInstalled();
      const status = readEngineStatus(engineFiles(options.engineHome).status);
      return {
        loaded,
        root: installed ? plistString(installed.bytes.toString('utf8'), 'WorkingDirectory') : null,
        plistSha256: installed ? sha256(installed.bytes) : null,
        pid,
        pidAlive: pid !== null && world.isPidAlive(pid),
        status: status
          ? { pid: status.pid, bootId: status.bootId, connected: status.connection === 'connected' }
          : null,
      };
    },
    async rootCommit(root) {
      const git = (args: string[]) =>
        world.context.deps.run('git', ['-C', root, ...args], { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
      const head = await git(['rev-parse', 'HEAD']);
      if (head.code !== 0) return null;
      const status = await git(['status', '--porcelain', '--untracked-files=all']);
      if (status.code !== 0 || status.stdout.trim()) return null;
      return head.stdout.trim();
    },
    async snapshotPlist(attemptId) {
      if (!ATTEMPT_ID.test(attemptId)) throw refused('the attempt id is not a UUID');
      const installed = readInstalled();
      if (!installed) throw refused('no engine service is installed for the configured engine home');
      const target = path.join(options.stateDir, `engine-plist-${attemptId}.plist`);
      try {
        fs.writeFileSync(target, installed.bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (sha256(fs.readFileSync(target)) !== sha256(installed.bytes))
          throw refused('an engine service snapshot of this attempt exists and differs');
      }
      return { path: target, sha256: sha256(installed.bytes) };
    },
    async stop(pid) {
      const stopped = await bootout(launchd, SERVICE_LABEL);
      if (stopped.status !== 0) return false;
      const gone = await waitUntil(launchd, ENGINE_STOP_WAIT_MS, async () => !world.isPidAlive(pid), 500);
      return gone && !(await isLoaded(launchd, SERVICE_LABEL));
    },
    async start(root) {
      const installed = readInstalled();
      if (!installed) throw refused('no engine service is installed for the configured engine home');
      const text = installed.bytes.toString('utf8');
      const node = installedProgramArguments(text)?.[0] ?? null;
      const pathEnv = plistString(text, 'PATH');
      if (!node || !pathEnv) throw refused('the installed engine service names no node or PATH');
      try {
        installService({
          home: options.engineHome,
          root,
          nodePath: node,
          pathEnv: servicePathEnv(pathEnv),
          agentsDir: agentsDir(launchd.homeDir),
          uid: launchd.uid,
          launchctl: world.launchctlSync,
          platform: world.platform,
          out: (line) => world.out(line),
          bootstrapTries: ENGINE_BOOTSTRAP_TRIES,
        });
      } catch (error) {
        if (error instanceof CloudError) throw error;
        throw new CloudError(`the engine service could not be started: ${errorText(error)}`);
      }
    },
    async restorePrevious({ plistPath, plistSha256 }) {
      if (!isWithin(options.stateDir, plistPath))
        throw refused('the saved engine service is outside the state directory');
      const saved = fs.readFileSync(plistPath);
      if (sha256(saved) !== plistSha256)
        throw refused('the saved engine service differs from its recorded hash');
      const file = plistFile(launchd.homeDir, SERVICE_LABEL);
      const stopped = await bootout(launchd, SERVICE_LABEL);
      if (stopped.status !== 0) throw new CloudError('the new engine service could not be unloaded');
      const temporary = `${file}.${randomBytes(4).toString('hex')}.tmp`;
      fs.writeFileSync(temporary, saved, { mode: 0o644 });
      fs.chmodSync(temporary, 0o644);
      fs.renameSync(temporary, file);
      const started = await bootstrap(launchd, SERVICE_LABEL);
      if (started.status !== 0) throw new CloudError(`launchctl bootstrap failed (${started.status})`);
    },
  };
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/[^\x20-\x7e]/g, ' ').slice(0, 200);

// ---- preparation, publishing, the heavy-run queue --------------------------------------------------

export function preparePort(
  world: HybridWorld,
  loaded: Pick<LoadedHybridConfig, 'config'>,
  signal: AbortSignal,
): PreparePort {
  return {
    inspect(outputDir) {
      const stat = fs.lstatSync(outputDir, { throwIfNoEntry: false });
      if (!stat) return 'absent';
      if (!stat.isDirectory() || stat.isSymbolicLink()) return 'partial';
      return fs.lstatSync(path.join(outputDir, RECEIPT_FILE), { throwIfNoEntry: false })
        ? 'receipt'
        : 'partial';
    },
    async prepare(input) {
      await prepareHybridRelease(
        world.context,
        {
          releaseId: input.releaseId,
          commit: input.commit,
          outputDir: input.outputDir,
          engineReleasesDir: loaded.config.engineReleasesDir,
        },
        { signal, engineHome: loaded.config.engineHome },
      );
    },
    async verify(input) {
      const verified = verifyPreparedRelease(input);
      await assertCleanAt(world.context, verified.engineRoot, input.commit, signal, 'the engine candidate');
      return verified;
    },
  };
}

export function heavyPort(signal: AbortSignal): HeavyLockPort {
  return {
    async acquire(label, waitMs) {
      try {
        const lock = await acquireHeavyLock({ dir: defaultHeavyLockDir(), label, signal, maxWaitMs: waitMs });
        return { release: () => lock.release() };
      } catch (error) {
        if (error instanceof HeavyLockError && error.code === 'heavy_lock_timeout') return null;
        throw new CloudError("the machine's heavy-run queue is unavailable");
      }
    },
  };
}

export interface PublishOptions {
  stateDir: string;
  engineReleasesDir: string;
}

/**
 * The tag and the GitHub release (decision 35, as the single-target watcher does it): an identical tag or release
 * is reused, a tag that points anywhere else is never moved. The commit is tagged from the release's own engine
 * candidate checkout, which holds exactly that commit and no credentials.
 */
export function publishPort(world: HybridWorld, options: PublishOptions): PublishPort {
  const { context } = world;
  return {
    async publish({ release, commit }) {
      const remote = context.config.repository.url;
      if (!GITHUB_REMOTE_PATTERN.test(remote))
        throw new CloudError('the configured repository is not a GitHub remote');
      const slug = githubSlug(remote);
      if (!slug) throw new CloudError('the configured repository is not a GitHub remote');
      const cwd = path.join(options.engineReleasesDir, `${release.id}-${commit}`);
      const git = (args: string[]) =>
        context.deps.run('git', ['-C', cwd, ...args], { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
      const listed = await git(['ls-remote', '--tags', remote]);
      if (listed.code !== 0) throw new CloudError(`git ls-remote exited with ${listed.code}`);
      const tags = new Map<string, string>();
      for (const line of listed.stdout.split('\n')) {
        const match = /^([0-9a-f]{40})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
        // The peeled line (`^{}`) is the commit of an annotated tag; it follows the tag object's own line.
        if (match && (match[3] || !tags.has(match[2]!))) tags.set(match[2]!, match[1]!);
      }
      let tag = [...tags].find(([name, target]) => RELEASE_TAG_PATTERN.test(name) && target === commit)?.[0];
      if (!tag) {
        tag = releaseTagName(release.liveAt ? new Date(release.liveAt) : context.deps.now(), [
          ...tags.keys(),
        ]);
        await git(['tag', '-d', tag]);
        const created = await git(['tag', '-a', tag, commit, '-m', tag]);
        if (created.code !== 0) throw new CloudError(`git tag exited with ${created.code}`);
        const pushed = await git(['push', remote, `refs/tags/${tag}`]);
        if (pushed.code !== 0) throw new CloudError(`git push of ${tag} exited with ${pushed.code}`);
      }
      const gh = (args: string[]) =>
        context.deps.run('gh', args, { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
      const viewed = await gh(['release', 'view', tag, '--repo', slug, '--json', 'url']);
      if (viewed.code === 0) {
        try {
          const url = (JSON.parse(viewed.stdout) as { url?: unknown }).url;
          if (typeof url === 'string' && url) return { tag, url };
        } catch {
          // Not JSON: treated as no release; creating one fails if it exists, and says why.
        }
      }
      const notes = path.join(options.stateDir, `notes-${release.id}.md`);
      fs.writeFileSync(
        notes,
        `${release.summary.trim()}\n\nCards: ${release.tasks.join(', ')}\nCommit: ${commit}\n`,
        { mode: 0o600 },
      );
      try {
        const made = await gh([
          'release',
          'create',
          tag,
          '--repo',
          slug,
          '--title',
          tag,
          '--notes-file',
          notes,
          '--verify-tag',
        ]);
        if (made.code !== 0) throw new CloudError(`gh release create exited with ${made.code}`);
        const url = made.stdout.trim().split('\n').pop()?.trim();
        if (!url) throw new CloudError('gh release create printed no URL');
        return { tag, url };
      } finally {
        fs.rmSync(notes, { force: true });
      }
    },
  };
}

// ---- the clock and the whole set --------------------------------------------------------------------

export const realClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new CloudError('interrupted'));
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new CloudError('interrupted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

export interface BuildPortsInput {
  world: HybridWorld;
  loaded: LoadedHybridConfig;
  journal: JournalPort;
  signal: AbortSignal;
  clock?: Clock;
  uuid?: () => string;
  log: (line: string) => void;
}

/** Every real port for one round; the coordinator is the same code the tests drive with the fake world. */
export function buildPorts(input: BuildPortsInput): CoordinatorPorts {
  const { world, loaded, signal } = input;
  const { config } = loaded;
  return {
    config: {
      controllerId: config.controllerId,
      engineId: config.engineId,
      targetHash: loaded.targetHash,
      configSha256: loaded.configSha256,
      stateDir: config.stateDir,
      engineReleasesDir: config.engineReleasesDir,
    },
    control: relayControl(world.context),
    machine: machinePort(world.context, {
      accountId: config.expectedAccountId,
      instanceId: config.expectedInstanceId,
    }),
    engine: enginePort(world, { engineHome: config.engineHome, stateDir: config.stateDir }),
    prepare: preparePort(world, loaded, signal),
    publisher: publishPort(world, { stateDir: config.stateDir, engineReleasesDir: config.engineReleasesDir }),
    heavy: heavyPort(signal),
    journal: input.journal,
    clock: input.clock ?? realClock,
    uuid: input.uuid ?? randomUUID,
    oldLiveJournal: () =>
      oldLiveJournalExists([
        ...new Set([path.join(world.launchd.homeDir, '.projectman'), config.engineHome]),
      ]),
    log: input.log,
    signal,
  };
}
