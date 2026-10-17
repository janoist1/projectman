import type {
  HybridDeployment,
  Release,
  ReleaseArtifact,
  ReleaseDeployBegin,
  ReleaseDeployChange,
  ReleaseDrainStatus,
  ReleaseEngineStatus,
  ReleaseImageRef,
  ReleaseStep,
} from '@projectman/shared';
import type { SelectedImage } from '../cloud/images';
import type { JournalFailureCode } from './journal';
import type { JournalPort } from './journal';
import type { VerifiedPrepared, VerifyPreparedInput } from './verify';

/**
 * The seams of the hybrid coordinator (PM-751). The coordinator is a state machine over these ports: the real
 * ones (`commands.ts`) talk to AWS, the board's control socket, launchd and git; the tests' fakes are a
 * deployment service, a cloud host and an engine that behave like them. Nothing in the coordinator reads a file,
 * the clock or the environment except through a port.
 */

/** The fixed v1 limits. */
export const LIMITS = {
  /** How often a state is polled while it is waited for. */
  pollMs: 5_000,
  /** Each of the cloud's and the engine's health waits. */
  healthMs: 180_000,
  /** The work of the instance must have drained, and the heavy-run lock been taken, within this. */
  drainMs: 360_000,
  /** A cloud image operation that may still run: how long its lock is waited for. */
  imageLockMs: 180_000,
  /** A failed publish is tried again at most this often. */
  publishRetryMs: 3_600_000,
  /** One control request is sent this many times in a round before the round stops (the same id and body). */
  sendAttempts: 3,
  sendRetryMs: 5_000,
  /** The heavy-run lock of a re-entered round, in a phase that needs it. */
  heavyReentryMs: 30_000,
} as const;

// ---- the cloud's control socket -----------------------------------------------------------------

/**
 * `refused`: the board answered `ok: false`, the request was not applied. `uncertain`: it may have been applied (the
 * answer was lost, or is not a response). `unavailable`: it provably never reached the board.
 */
export class ControlError extends Error {
  readonly kind: 'refused' | 'uncertain' | 'unavailable';
  readonly code: string;

  constructor(kind: ControlError['kind'], code: string, message: string) {
    super(message);
    this.name = 'ControlError';
    this.kind = kind;
    this.code = code;
  }
}

/** What `release_deploy_*` answers: the deployment, the release, the drain state and the database's schema. */
export interface DeployView {
  release: Release;
  deployment: HybridDeployment | null;
  drain: ReleaseDrainStatus;
  databaseSchemaVersion: number;
}

export interface CloudControl {
  releaseNext(): Promise<Release | null>;
  deployGet(releaseId: string): Promise<DeployView>;
  begin(body: ReleaseDeployBegin): Promise<DeployView>;
  change(body: ReleaseDeployChange): Promise<DeployView>;
  /** The registry's view of the engines, and the commit the answering server runs. */
  engines(): Promise<{ appVersion: string | null; engines: ReleaseEngineStatus[] }>;
}

// ---- the cloud machine --------------------------------------------------------------------------

/** One read-only look at an image on the machine: what is deployed, whether it is healthy, the lock, the schema. */
export interface CloudImageProbe {
  /** The image the machine's deploy record says is current. */
  current: ReleaseImageRef | null;
  /** The container of `current` reports healthy. */
  healthy: boolean;
  imagePresent: boolean;
  imageVerified: boolean;
  /** A write operation (import, start) holds the machine's image lock. */
  lockHeld: boolean;
  /** Null: not known. */
  schemaVersion: number | null;
}

export interface CloudMachine {
  /** The AWS account and the instance are the configured ones, and the instance runs (nothing else is trusted). */
  verifyTarget(): Promise<void>;
  /** The image the machine runs now; null when it cannot be told. */
  current(): Promise<ReleaseImageRef | null>;
  probe(image: ReleaseImageRef): Promise<CloudImageProbe>;
  /** Streams the verified ARM archive to the machine; the machine hashes it again. */
  importImage(image: SelectedImage): Promise<void>;
  /** Starts exactly this image by its immutable id: no provisioning, no bootstrap, no secret or configuration write. */
  start(image: ReleaseImageRef): Promise<void>;
  /** Waits (at most the health limit) for the container of the image to be healthy. */
  waitHealthy(image: ReleaseImageRef): Promise<boolean>;
}

// ---- the engine on this Mac ---------------------------------------------------------------------

/** What can be proven about the engine's launchd job and process right now. */
export interface EngineState {
  /** The job is known to launchd. */
  loaded: boolean;
  /** The checkout the installed job runs from; null when no plist of this home is installed. */
  root: string | null;
  plistSha256: string | null;
  /** The pid launchd names for the job. */
  pid: number | null;
  /** A process with `pid` exists. */
  pidAlive: boolean;
  /** `engine-status.json` of the engine home. */
  status: { pid: number; bootId: string; connected: boolean } | null;
}

export interface EngineControl {
  state(): Promise<EngineState>;
  /** HEAD of a checkout, when it is clean; null otherwise. */
  rootCommit(root: string): Promise<string | null>;
  /** Copies the installed plist aside for the rollback; returns where it is and its hash. */
  snapshotPlist(attemptId: string): Promise<{ path: string; sha256: string }>;
  /** Boots the job out and proves the job and process `pid` are gone; false when that cannot be proven. Never kills. */
  stop(pid: number): Promise<boolean>;
  /** Installs and loads the service of the candidate checkout, on the same home and with a stable node and PATH. */
  start(root: string): Promise<void>;
  /** Puts the saved plist back and loads it. */
  restorePrevious(input: { plistPath: string; plistSha256: string }): Promise<void>;
}

// ---- preparation, publishing, the machine's heavy-run queue ------------------------------------

export interface PreparePort {
  /** `absent`: nothing there; `partial`: the directory exists without a receipt; `receipt`: a finished preparation. */
  inspect(outputDir: string): 'absent' | 'partial' | 'receipt';
  /** Builds and verifies everything (PM-750); the receipt is written last, into `outputDir`. */
  prepare(input: { releaseId: string; commit: string; outputDir: string }): Promise<void>;
  /** Verifies the receipt, the artifacts and the candidate once more, and that the candidate checkout is clean. */
  verify(input: VerifyPreparedInput): Promise<VerifiedPrepared>;
}

export interface PublishPort {
  /** Tags the commit and creates the GitHub release; reuses an identical tag and release, never another tag's target. */
  publish(input: { release: Release; commit: string }): Promise<{ tag: string; url: string }>;
}

export interface HeldHeavyLock {
  release(): Promise<void>;
}

export interface HeavyLockPort {
  /** The machine's heavy-run lock, waited for at most `waitMs`; null when it was not free in time. */
  acquire(label: string, waitMs: number): Promise<HeldHeavyLock | null>;
}

export interface Clock {
  now(): Date;
  /** Resolves after `ms`, or rejects when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The facts of the configuration the coordinator needs; everything else stays in the loader. */
export interface CoordinatorConfig {
  controllerId: string;
  engineId: string;
  targetHash: string;
  configSha256: string;
  stateDir: string;
  engineReleasesDir: string;
}

export interface CoordinatorPorts {
  config: CoordinatorConfig;
  control: CloudControl;
  machine: CloudMachine;
  engine: EngineControl;
  prepare: PreparePort;
  publisher: PublishPort;
  heavy: HeavyLockPort;
  journal: JournalPort;
  clock: Clock;
  /** A fresh UUID. */
  uuid(): string;
  /** The homes that may hold the old single-target watcher's journal. */
  oldLiveJournal(): boolean;
  log(line: string): void;
  signal: AbortSignal;
}

// ---- the result of a round ----------------------------------------------------------------------

export type RoundResult =
  | { status: 'idle' }
  /** The release went live and is published (or the publish is retried later: `publishPending`). */
  | { status: 'live'; releaseId: string; publishPending: boolean }
  /** The release failed and the previous program runs again (verified). */
  | { status: 'rolled_back'; releaseId: string; code: JournalFailureCode }
  /** The attempt ended before it touched anything beyond the pause. */
  | { status: 'failed'; releaseId: string; code: JournalFailureCode }
  | { status: 'recovery_required'; releaseId: string; code: JournalFailureCode };

/** The round stops, the journal stays: the next round (or a person) carries on. Exit status 1. */
export class RoundStopped extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RoundStopped';
    this.code = code;
  }
}

/** What the approvers and the journal read: a fixed text and the step the failure belongs to, never a raw error. */
export interface FixedFailure {
  step: ReleaseStep;
  message: string;
}

export type { ReleaseArtifact };
