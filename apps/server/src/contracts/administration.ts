import type {
  AdministrationCommand,
  AdministrationCommit,
  AdministrationTarget,
  ErrorCode,
  ImagePlatform,
} from '@projectman/shared';

/**
 * The protected administration adapter (PM-763, "Super mode" 7/10): the typed, audited way to look at, restart
 * and run the fixed operations of the hub and of the supported engine, with no SSM, no browser, no host shell
 * and no Docker socket. A separate supervisor process on each machine owns the one projectman service it was
 * installed for; the hub (or the engine, for its own machine) reaches it over a local Unix socket, never
 * with a program, path, argument, SQL, service name or container name of the caller. The wire schemas live
 * in `administration/schemas.ts`; this file is the contract the rest of the server codes against.
 */

// The command, its target and its closed value lists are shared with the super-mode handoff (PM-762).
export { FULL_TEST_PROFILES, IMAGE_PLATFORMS } from '@projectman/shared';
export type {
  AdministrationCommand,
  AdministrationCommit,
  AdministrationTarget,
  FullTestProfile,
  ImagePlatform,
} from '@projectman/shared';

export const ADMINISTRATION_CAPABILITIES = [
  'status',
  'logs',
  'restart',
  'full_test',
  'image_build',
  'deploy',
] as const;
export type AdministrationCapability = (typeof ADMINISTRATION_CAPABILITIES)[number];

export interface AdministrationStatus {
  target: AdministrationTarget;
  online: boolean;
  version: string | null;
  /** Changes whenever the managed service starts anew; `restart` is checked against it. */
  bootId: string | null;
  capabilities: AdministrationCapability[];
  activeOperationId: string | null;
}

export type DiagnosticLevel = 'info' | 'warn' | 'error';

/** One line of the supervisor's diagnostics: a known code and allowed scalar fields only, never raw text. */
export interface DiagnosticLogEntry {
  at: string;
  level: DiagnosticLevel;
  code: string;
  message: string;
}

export const MAX_DIAGNOSTIC_ENTRIES = 200;
export const MAX_DIAGNOSTIC_MESSAGE = 1000;

export interface ImageArtifact {
  /** Opaque, never a file path. */
  artifactId: string;
  platform: ImagePlatform;
  commit: AdministrationCommit;
  /** `sha256:<64 hex>`. */
  imageDigest: string;
  /** 64 hex. */
  archiveSha256: string;
  bytes: number;
}

export type AdministrationResult =
  | { kind: 'restart'; bootId: string; version: string | null }
  | {
      kind: 'full_test';
      outcome: 'passed' | 'failed' | 'error';
      exitCode: number | null;
      durationMs: number;
      failedFiles: string[];
    }
  | { kind: 'image_build'; artifacts: ImageArtifact[] }
  | { kind: 'deploy'; releaseId: string };

export type AdministrationJobState = 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';

export interface AdministrationJob {
  operationId: string;
  state: AdministrationJobState;
  result: AdministrationResult | null;
  errorCode: ErrorCode | null;
  updatedAt: string;
}

export interface AdministrationSubmit {
  /** The caller's stable id of the operation; a duplicate submit with the same command answers the same. */
  operationId: string;
  /** Names the request in the audit trail (the caller's request id). */
  requestId: string;
  command: AdministrationCommand;
}

export interface AdministrationPort {
  status(target: AdministrationTarget): Promise<AdministrationStatus>;
  logs(target: AdministrationTarget, options: { limit: number }): Promise<{ entries: DiagnosticLogEntry[] }>;
  submit(input: AdministrationSubmit): Promise<{ accepted: boolean }>;
  inspect(operationId: string): Promise<AdministrationJob>;
}

type ResultOf<K extends AdministrationResult['kind']> = Extract<AdministrationResult, { kind: K }>;

/**
 * What a supervisor's installation provides for the business operations. The business orchestration of a
 * full test, an image build and a deploy is built elsewhere (PM-764); this adapter only forwards a validated
 * command to it. An executor that is not installed is not advertised as a capability and its command is
 * refused as unavailable.
 */
export interface AdministrationExecutors {
  full_test?(
    command: Extract<AdministrationCommand, { kind: 'full_test' }>,
    signal: AbortSignal,
  ): Promise<ResultOf<'full_test'>>;
  image_build?(
    command: Extract<AdministrationCommand, { kind: 'image_build' }>,
    signal: AbortSignal,
  ): Promise<ResultOf<'image_build'>>;
  deploy?(
    command: Extract<AdministrationCommand, { kind: 'deploy' }>,
    signal: AbortSignal,
  ): Promise<ResultOf<'deploy'>>;
}

/**
 * The hub's release fence (PM-752): while a deployment holds the instance, or a pause the deployment owns is
 * open, a restart conflicts with it (`release_pause_conflict`). `null`: no fence is up.
 */
export type AdministrationFence = () => { releaseId: string } | null;

export const ADMINISTRATION_SOCKET_METHODS = ['status', 'logs', 'submit', 'inspect'] as const;
export type AdministrationSocketMethod = (typeof ADMINISTRATION_SOCKET_METHODS)[number];

/** The sizes of the socket protocol: one JSON line each way. */
export const ADMINISTRATION_LIMITS = {
  requestBytes: 16 * 1024,
  responseBytes: 256 * 1024,
  ioTimeoutMs: 30_000,
} as const;
