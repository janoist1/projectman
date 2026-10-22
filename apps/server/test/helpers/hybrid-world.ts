import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { MemberConfig } from '@projectman/shared';
import type {
  HybridDeployment,
  ProjectConfig,
  Release,
  ReleaseEngineStatus,
  ReleaseImageRef,
} from '@projectman/shared';
import { HybridCoordinator } from '../../../../scripts/release/coordinator';
import { JournalStore } from '../../../../scripts/release/journal';
import type { HybridReleaseJournal, JournalPort, JournalRead } from '../../../../scripts/release/journal';
import { ControlError } from '../../../../scripts/release/ports';
import type {
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
} from '../../../../scripts/release/ports';
import type { VerifiedPrepared } from '../../../../scripts/release/verify';
import type { BranchMerger, MergeBaseState } from '../../src/contracts';
import { createDomainHarness, snapshotDomainHarness } from './domain-harness';
import type { DomainHarness, HarnessSnapshot } from './domain-harness';

/**
 * A world for the hybrid coordinator's tests (PM-751): the real deployment service of the cloud (PM-752) behind a
 * fake control socket, a cloud machine, an engine, a preparation, a publisher and a clock that behave like the real
 * ones, with faults that can be injected at every call. No AWS, no launchd, no git, no real time.
 */

export const sha = (n: number) => n.toString(16).padStart(40, '0');
export const PREVIOUS = sha(1);
export const NEW = sha(2);
export const ENGINE_ID = 'eng_abcdefghijkl';
export const TARGET_HASH = 'a'.repeat(64);
const CONFIG_SHA = 'e'.repeat(64);
const RECEIPT_SHA = 'f'.repeat(64);
export const SCHEMA = 7;
const TARGET = { projectKey: 'AR', repo: 'web' };
const OWNER = { handle: 'owner', access: 'owner' as const };

export const imageOf = (commit: string): ReleaseImageRef => ({
  commit,
  imageId: `sha256:${commit.padStart(64, '0')}`,
  platform: 'linux/arm64',
});

/** A process stop that the journal wrapper raises: the state on disk is whatever was written before it. */
export class Crash extends Error {
  constructor() {
    super('simulated crash');
    this.name = 'Crash';
  }
}

/** The journal on disk with a crash that can be set to happen before or after its n-th write. */
class CrashingJournal implements JournalPort {
  readonly inner: JournalStore;
  writes = 0;
  private crash: { at: number; when: 'before' | 'after' } | null = null;

  constructor(stateDir: string) {
    this.inner = new JournalStore(stateDir);
  }

  crashAt(at: number, when: 'before' | 'after'): void {
    this.crash = { at, when };
  }

  clear(): void {
    this.crash = null;
  }

  private around(act: () => void): void {
    this.writes += 1;
    const hit = this.crash?.at === this.writes ? this.crash.when : null;
    if (hit === 'before') throw new Crash();
    act();
    if (hit === 'after') throw new Crash();
  }

  read(): JournalRead {
    return this.inner.read();
  }

  create(journal: HybridReleaseJournal): void {
    this.around(() => this.inner.create(journal));
  }

  write(journal: HybridReleaseJournal): void {
    this.around(() => this.inner.write(journal));
  }

  archive(journal: HybridReleaseJournal): void {
    this.around(() => this.inner.archive(journal));
  }
}

type Fault = { when: 'before' | 'after'; kind: 'uncertain' | 'unavailable' };

let seeded: Promise<HarnessSnapshot> | undefined;
/** The worlds not cleaned up yet: the journal's fsync stays off while there is one. */
let liveWorlds = 0;
let fsyncSpy: MockInstance<typeof fs.fsyncSync> | undefined;

export class HybridWorld {
  h!: DomainHarness;
  dir = '';
  stateDir = '';
  releasesDir = '';
  /** What the cloud's registry says about the engine. */
  registry: ReleaseEngineStatus = { id: ENGINE_ID, online: true, version: PREVIOUS, lastSeenAt: null };
  journal!: CrashingJournal;
  controllerId = randomUUID();
  log: string[] = [];
  now = Date.parse('2026-10-17T10:00:00.000Z');

  // ---- the cloud machine
  cloud = {
    current: imageOf(PREVIOUS),
    healthy: true,
    images: new Map<string, { verified: boolean }>([[imageOf(PREVIOUS).imageId, { verified: true }]]),
    lockHeld: false,
    schema: SCHEMA as number | null,
    /** Whether the container of a commit becomes healthy after it started. */
    healthyAfterStart: (_commit: string) => true,
    /** What a start does to the database schema (a migration by the new program). */
    migrateOnStart: (_commit: string): number | null => null,
  };
  calls = {
    importImage: 0,
    start: [] as string[],
    stop: 0,
    engineStart: [] as string[],
    restore: 0,
    prepare: 0,
    publish: 0,
  };

  // ---- the engine on this Mac
  engineSim = {
    root: '/engine/previous',
    loaded: true,
    alive: true,
    pid: 4001,
    bootId: 'boot-1',
    connected: true,
    plistSha: '1'.repeat(64),
    /** The commit a started engine reports to the registry (null: the checkout's own). */
    reportsVersion: null as string | null,
    connectsAfterStart: true,
    stopLeavesAlive: false,
    stopThrows: false,
  };
  private nextPid = 5000;
  private counted = false;

  // ---- preparation and publishing
  prepared = new Map<string, 'partial' | 'receipt'>();
  receiptSha = RECEIPT_SHA;
  publisherFails = 0;
  published: { tag: string; commit: string }[] = [];
  heavyFree = true;
  heavyHeld = 0;
  oldJournal = false;

  private faults = new Map<string, Fault[]>();
  private throws = new Map<string, number>();

  /**
   * A world starts from the state a first one left (the project, the card and the merge record), once per test
   * process: building it takes the git commits of creating the project, which the loops over every journal write
   * would otherwise pay in each of their worlds.
   */
  static async create(): Promise<HybridWorld> {
    seeded ??= HybridWorld.seed();
    const world = new HybridWorld();
    await world.init(await seeded);
    return world;
  }

  private static async seed(): Promise<HarnessSnapshot> {
    const first = new HybridWorld();
    await first.init();
    const snapshot = await snapshotDomainHarness(first.h);
    fs.rmSync(first.dir, { recursive: true, force: true });
    first.uncount();
    return snapshot;
  }

  private async init(snapshot?: HarnessSnapshot): Promise<void> {
    // The journal makes every write durable with an fsync (a power loss, which these tests do not simulate: a crash is
    // an exception raised between two writes), and each one waits for the disk for as long as the machine is busy.
    if (liveWorlds === 0) fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation(() => undefined);
    liveWorlds += 1;
    this.counted = true;
    this.dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm751-'));
    this.stateDir = path.join(this.dir, 'state');
    this.releasesDir = path.join(this.dir, 'engine-releases');
    fs.mkdirSync(this.stateDir, { mode: 0o700 });
    fs.mkdirSync(this.releasesDir, { mode: 0o700 });
    this.journal = new CrashingJournal(this.stateDir);
    const base: MergeBaseState = {
      local: NEW,
      remote: null,
      relation: 'same',
      contains: { local: false, remote: null },
      checkout: null,
    };
    const merger = {
      prepare: vi.fn(async () => structuredClone(base)),
      isAncestor: vi.fn(
        async (_ref: unknown, { ancestor, commit }: { ancestor: string; commit: string }) =>
          ancestor <= commit,
      ),
    } as unknown as BranchMerger;
    this.h = await createDomainHarness({
      snapshot,
      merger,
      releaseTarget: TARGET,
      appVersion: PREVIOUS,
      releaseHybrid: {
        binding: { engineId: ENGINE_ID, targetHash: TARGET_HASH },
        engines: () => [this.registry],
      },
      adjust(config: ProjectConfig) {
        config.project.repos[0]!.docs = { roadmap: 'docs/ROADMAP.md' };
        config.team.members.push(
          MemberConfig.parse({
            kind: 'ai',
            handle: 'devops',
            displayName: 'Devops',
            role: 'devops',
            sponsor: 'owner',
          }),
        );
      },
    });
    if (snapshot) return;
    await this.h.domain.tasks.create(
      'AR',
      { title: 'Card one', repo: 'web' },
      { kind: 'human', handle: 'owner' },
    );
    this.h.repos.taskMerges.save({
      id: 'mrg_1',
      projectKey: 'AR',
      taskKey: 'AR-1',
      repo: 'web',
      base: 'main',
      commit: 'branch-AR-1',
      branch: 'pm/AR-1',
      fromStageId: 'code_review',
      toStageId: 'done',
      merger: 'dev-1',
      requestedAt: '2026-01-01T00:00:00.000Z',
      startedBy: 'dev-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      mergeCommit: NEW,
      landed: 'nowhere',
      state: 'merged',
      step: 'finishing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-02T00:00:00.000Z',
    });
  }

  async cleanup(): Promise<void> {
    await this.h?.cleanup();
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.uncount();
  }

  private uncount(): void {
    if (!this.counted) return;
    this.counted = false;
    liveWorlds -= 1;
    if (liveWorlds === 0) fsyncSpy?.mockRestore();
  }

  /** An approved release, as the owner's decision leaves it. */
  async approve(): Promise<Release> {
    const { release } = await this.h.domain.releases.propose('AR', 'devops', {
      title: 'Release',
      summary: '- AR-1',
    });
    const item = this.h.domain.inbox.list('AR', { kind: 'release', state: 'open' })[0]!;
    await this.h.domain.inbox.resolve('AR', item.id, { optionId: 'approve' }, OWNER);
    return release;
  }

  release(id: string): Release {
    return this.h.domain.releases.get(id);
  }

  deployment(id: string): HybridDeployment | null {
    return this.h.repos.releaseDeployments.get(id);
  }

  /** Work the server cannot prove finished: the drain stays not ready until this is cleared. */
  holdWork(): void {
    this.h.repos.taskMerges.save({
      ...this.h.repos.taskMerges.list('merged')[0]!,
      id: 'mrg_run',
      taskKey: 'AR-9',
      state: 'running',
      step: 'merging',
      finishedAt: undefined,
    });
  }

  // ---- faults ------------------------------------------------------------------------------------

  /** The next call of a control operation loses its answer (`after`: it was applied) or never arrives. */
  loseControl(op: string, fault: Fault, times = 1): void {
    this.faults.set(op, Array(times).fill(fault));
  }

  /** The next `times` calls of a port method throw. */
  failOn(name: string, times = 1): void {
    this.throws.set(name, times);
  }

  private maybeThrow(name: string): void {
    const left = this.throws.get(name) ?? 0;
    if (left <= 0) return;
    this.throws.set(name, left - 1);
    throw new Error(`injected failure of ${name}`);
  }

  // ---- the ports ---------------------------------------------------------------------------------

  private async wire<T>(op: string, run: () => Promise<T> | T): Promise<T> {
    const fault = this.faults.get(op)?.shift();
    if (fault?.when === 'before') throw new ControlError(fault.kind, 'control_lost', 'the answer was lost');
    let result: T;
    try {
      result = await run();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      throw new ControlError(
        'refused',
        typeof code === 'string' ? code : 'internal_error',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (fault?.when === 'after') throw new ControlError(fault.kind, 'control_lost', 'the answer was lost');
    return result;
  }

  private view(view: DeployView): DeployView {
    return view;
  }

  control(): CloudControl {
    const { deploy } = { deploy: () => this.h.domain.releaseDeployments };
    return {
      releaseNext: () => this.wire('releaseNext', () => this.h.domain.releases.next()),
      deployGet: (id) => this.wire('deployGet', () => this.view(deploy().get(id))),
      begin: (body) => this.wire('begin', async () => this.view(await deploy().begin(body))),
      change: (body) =>
        this.wire(`change:${body.change.kind}`, async () => this.view(await deploy().change(body))),
      engines: () =>
        this.wire('engines', () => ({
          appVersion: this.h.domain.releases.appVersion(),
          engines: [structuredClone(this.registry)],
        })),
    };
  }

  private probe(image: ReleaseImageRef): CloudImageProbe {
    const known = this.cloud.images.get(image.imageId);
    return {
      current: this.cloud.current,
      healthy: this.cloud.healthy,
      imagePresent: known !== undefined,
      imageVerified: known?.verified === true,
      lockHeld: this.cloud.lockHeld,
      schemaVersion: this.cloud.schema,
    };
  }

  machine(): CloudMachine {
    return {
      verifyTarget: async () => this.maybeThrow('machine.verifyTarget'),
      current: async () => this.cloud.current,
      probe: async (image) => {
        this.maybeThrow('machine.probe');
        return this.probe(image);
      },
      importImage: async (image) => {
        this.calls.importImage += 1;
        this.maybeThrow('machine.importImage');
        this.cloud.images.set(image.imageId, { verified: true });
      },
      start: async (image) => {
        this.calls.start.push(image.commit);
        this.maybeThrow('machine.start');
        if (!this.cloud.images.has(image.imageId)) throw new Error('image is not on the machine');
        this.cloud.current = imageOf(image.commit);
        this.cloud.healthy = this.cloud.healthyAfterStart(image.commit);
        this.cloud.schema = this.cloud.migrateOnStart(image.commit) ?? this.cloud.schema;
        this.h.setAppVersion(image.commit);
      },
      waitHealthy: async (image) => {
        this.maybeThrow('machine.waitHealthy');
        return this.cloud.current.imageId === image.imageId && this.cloud.healthy;
      },
    };
  }

  /** The commit a checkout stands for: its directory name carries it, the first one is the previous commit. */
  private commitOfRoot(root: string): string | null {
    if (root === '/engine/previous') return PREVIOUS;
    return /-([0-9a-f]{40})$/.exec(root)?.[1] ?? null;
  }

  private setEngineRegistry(online: boolean, version: string | null): void {
    this.registry = { ...this.registry, online, version };
  }

  engine(): EngineControl {
    const sim = this.engineSim;
    return {
      state: async (): Promise<EngineState> => {
        this.maybeThrow('engine.state');
        return {
          loaded: sim.loaded,
          root: sim.root,
          plistSha256: sim.plistSha,
          pid: sim.loaded ? sim.pid : null,
          pidAlive: sim.alive,
          status: { pid: sim.pid, bootId: sim.bootId, connected: sim.connected },
        };
      },
      pidAlive: async (pid) => sim.alive && pid === sim.pid,
      rootCommit: async (root) => this.commitOfRoot(root),
      snapshotPlist: async (attemptId) => ({
        path: path.join(this.dir, `plist-${attemptId}.plist`),
        sha256: sim.plistSha,
      }),
      stop: async (pid) => {
        this.calls.stop += 1;
        this.maybeThrow('engine.stop');
        if (sim.stopThrows) throw new Error('bootout failed');
        sim.loaded = false;
        sim.connected = false;
        this.setEngineRegistry(false, this.registry.version);
        if (sim.stopLeavesAlive) return false;
        sim.alive = false;
        return pid === sim.pid;
      },
      start: async (root) => {
        this.calls.engineStart.push(root);
        this.maybeThrow('engine.start');
        sim.root = root;
        sim.loaded = true;
        sim.alive = true;
        sim.pid = this.nextPid++;
        sim.bootId = `boot-${sim.pid}`;
        sim.connected = sim.connectsAfterStart;
        this.setEngineRegistry(sim.connected, sim.reportsVersion ?? this.commitOfRoot(root));
      },
      restorePrevious: async () => {
        this.calls.restore += 1;
        this.maybeThrow('engine.restore');
        sim.root = '/engine/previous';
        sim.loaded = true;
        sim.alive = true;
        sim.pid = this.nextPid++;
        sim.bootId = `boot-${sim.pid}`;
        sim.connected = true;
        this.setEngineRegistry(true, PREVIOUS);
      },
    };
  }

  preparation(): PreparePort {
    return {
      inspect: (dir) => this.prepared.get(dir) ?? 'absent',
      prepare: async ({ outputDir }) => {
        this.calls.prepare += 1;
        this.prepared.set(outputDir, 'partial');
        this.maybeThrow('prepare.prepare');
        this.prepared.set(outputDir, 'receipt');
      },
      verify: async (input): Promise<VerifiedPrepared> => {
        this.maybeThrow('prepare.verify');
        if (input.expectedReceiptSha256 !== null && input.expectedReceiptSha256 !== this.receiptSha)
          throw new Error('the preparation receipt changed since it was bound');
        const image = imageOf(input.commit);
        return {
          receiptPath: path.join(input.outputDir, 'preparation.json'),
          receiptSha256: this.receiptSha,
          artifact: {
            ...image,
            manifestSha256: 'b'.repeat(64),
            archiveSha256: 'c'.repeat(64),
            archiveBytes: 1024,
          },
          selected: {
            platform: 'linux/arm64',
            archive: 'linux-arm64.tar',
            archiveSha256: 'c'.repeat(64),
            archiveBytes: 1024,
            imageId: image.imageId,
            file: path.join(input.outputDir, 'images', 'linux-arm64.tar'),
            sourceSha: input.commit,
          },
          engineRoot: path.join(input.engineReleasesDir, `${input.releaseId}-${input.commit}`),
        };
      },
    };
  }

  publisher(): PublishPort {
    return {
      publish: async ({ release, commit }) => {
        this.calls.publish += 1;
        if (this.publisherFails > 0) {
          this.publisherFails -= 1;
          throw new Error('github said no');
        }
        // Like the real publisher: a tag that exists for this commit is reused, never made twice.
        const tag =
          this.published.find((entry) => entry.commit === commit)?.tag ??
          `v2026.10.${17 + this.published.length}`;
        if (!this.published.some((entry) => entry.commit === commit)) this.published.push({ tag, commit });
        return { tag, url: `https://example.test/${release.id}/${tag}` };
      },
    };
  }

  heavy(): HeavyLockPort {
    return {
      acquire: async () => {
        if (!this.heavyFree) return null;
        this.heavyHeld += 1;
        return {
          release: async () => {
            this.heavyHeld -= 1;
          },
        };
      },
    };
  }

  ports(overrides: Partial<CoordinatorPorts> = {}): CoordinatorPorts {
    return {
      config: {
        controllerId: this.controllerId,
        engineId: ENGINE_ID,
        targetHash: TARGET_HASH,
        configSha256: CONFIG_SHA,
        stateDir: this.stateDir,
        engineReleasesDir: this.releasesDir,
      },
      control: this.control(),
      machine: this.machine(),
      engine: this.engine(),
      prepare: this.preparation(),
      publisher: this.publisher(),
      heavy: this.heavy(),
      journal: this.journal,
      clock: {
        now: () => new Date(this.now),
        sleep: async (ms, signal) => {
          if (signal.aborted) throw new Error('aborted');
          this.now += ms;
        },
      },
      uuid: () => randomUUID(),
      oldLiveJournal: () => this.oldJournal,
      log: (line) => this.log.push(line),
      signal: new AbortController().signal,
      ...overrides,
    };
  }

  coordinator(overrides: Partial<CoordinatorPorts> = {}): HybridCoordinator {
    return new HybridCoordinator(this.ports(overrides));
  }
}
