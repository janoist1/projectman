import { z } from 'zod';
import { AdministrationCommandSchema, AdministrationTargetSchema, ERROR_CODES } from '@projectman/shared';
import {
  ADMINISTRATION_CAPABILITIES,
  ADMINISTRATION_LIMITS,
  ADMINISTRATION_SOCKET_METHODS,
  IMAGE_PLATFORMS,
  MAX_DIAGNOSTIC_ENTRIES,
  MAX_DIAGNOSTIC_MESSAGE,
} from '../contracts';
import type {
  AdministrationJob,
  AdministrationResult,
  AdministrationStatus,
  AdministrationSubmit,
  DiagnosticLogEntry,
  ImageArtifact,
} from '../contracts';

/**
 * The strict wire schemas of the administration adapter (PM-763): the socket protocol and the engine RPCs
 * share them, so what the hub sends, what the engine forwards and what the supervisor accepts are one shape.
 * An unknown key is a refusal; nothing a caller sends can name a program, a path, an argument, a service or
 * a container.
 */

const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOOT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

export const OperationId = z.string().regex(SAFE_ID);
export const AdministrationRequestId = z.string().regex(SAFE_ID);
export const BootId = z.string().regex(BOOT_ID);
const Version = z.string().regex(VERSION);
const Commit = z.string().regex(COMMIT);
const Capability = z.enum(ADMINISTRATION_CAPABILITIES);
const Platform = z.enum(IMAGE_PLATFORMS);
const ErrorCodeSchema = z.enum(ERROR_CODES);
const nonNegative = z.number().int().nonnegative();
const iso = z
  .string()
  .max(40)
  .regex(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);

// The command and target schemas are shared with the super-mode handoff (PM-762).
export { AdministrationCommandSchema, AdministrationTargetSchema };

export const AdministrationStatusSchema: z.ZodType<AdministrationStatus> = z.strictObject({
  target: AdministrationTargetSchema,
  online: z.boolean(),
  version: Version.nullable(),
  bootId: BootId.nullable(),
  capabilities: z
    .array(Capability)
    .max(ADMINISTRATION_CAPABILITIES.length)
    .refine((capabilities) => new Set(capabilities).size === capabilities.length),
  activeOperationId: OperationId.nullable(),
});

export const DiagnosticLogEntrySchema: z.ZodType<DiagnosticLogEntry> = z.strictObject({
  at: iso,
  level: z.enum(['info', 'warn', 'error']),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string().max(MAX_DIAGNOSTIC_MESSAGE),
});

export const DiagnosticLogsSchema = z.strictObject({
  entries: z.array(DiagnosticLogEntrySchema).max(MAX_DIAGNOSTIC_ENTRIES),
});

export const LogsLimit = z.number().int().min(1).max(MAX_DIAGNOSTIC_ENTRIES);

const ImageArtifactSchema: z.ZodType<ImageArtifact> = z.strictObject({
  artifactId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  platform: Platform,
  commit: Commit,
  imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  archiveSha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: nonNegative,
});

export const AdministrationResultSchema: z.ZodType<AdministrationResult> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('restart'), bootId: BootId, version: Version.nullable() }),
  z.strictObject({
    kind: z.literal('full_test'),
    outcome: z.enum(['passed', 'failed', 'error']),
    exitCode: z.number().int().nullable(),
    durationMs: nonNegative,
    failedFiles: z.array(z.string().max(300)).max(20),
  }),
  z.strictObject({ kind: z.literal('image_build'), artifacts: z.array(ImageArtifactSchema).max(2) }),
  z.strictObject({ kind: z.literal('deploy'), releaseId: OperationId }),
]);

export const AdministrationJobSchema: z.ZodType<AdministrationJob> = z.strictObject({
  operationId: OperationId,
  state: z.enum(['accepted', 'running', 'succeeded', 'failed', 'unknown']),
  result: AdministrationResultSchema.nullable(),
  errorCode: ErrorCodeSchema.nullable(),
  updatedAt: iso,
});

export const AdministrationSubmitSchema: z.ZodType<AdministrationSubmit> = z.strictObject({
  operationId: OperationId,
  requestId: AdministrationRequestId,
  command: AdministrationCommandSchema,
});

export const AdministrationAccepted = z.strictObject({ accepted: z.boolean() });

/** The parameters of each socket method (the port's parameters, as one object). */
export const SocketParams = {
  status: z.strictObject({ target: AdministrationTargetSchema }),
  logs: z.strictObject({ target: AdministrationTargetSchema, limit: LogsLimit }),
  submit: AdministrationSubmitSchema,
  inspect: z.strictObject({ operationId: OperationId }),
} as const;

/** The value of each socket method. */
export const SocketValues = {
  status: AdministrationStatusSchema,
  logs: DiagnosticLogsSchema,
  submit: AdministrationAccepted,
  inspect: AdministrationJobSchema,
} as const;

/** One JSON line asking the supervisor. No bearer, cookie or Access header: the socket's rights are the authority. */
export const SocketRequest = z.strictObject({
  version: z.literal(1),
  method: z.enum(ADMINISTRATION_SOCKET_METHODS),
  requestId: AdministrationRequestId,
  params: z.unknown(),
});
export type SocketRequest = z.infer<typeof SocketRequest>;

export const SocketResponse = z.discriminatedUnion('ok', [
  z.strictObject({
    version: z.literal(1),
    requestId: AdministrationRequestId,
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.strictObject({
    version: z.literal(1),
    requestId: AdministrationRequestId,
    ok: z.literal(false),
    error: z.strictObject({ code: ErrorCodeSchema }),
  }),
]);
export type SocketResponse = z.infer<typeof SocketResponse>;

export const SOCKET_REQUEST_MAX_BYTES = ADMINISTRATION_LIMITS.requestBytes;
export const SOCKET_RESPONSE_MAX_BYTES = ADMINISTRATION_LIMITS.responseBytes;

/** The longest path a Unix socket address holds on the supported systems. */
export const SOCKET_PATH_MAX = 103;

/** The service of one installation, in the supervisor's own protected file. */
export const SupervisorConfig = z.strictObject({
  version: z.literal(1),
  target: AdministrationTargetSchema,
  stateDir: z.string().min(1).max(1024),
  socketPath: z.string().min(1).max(SOCKET_PATH_MAX),
  service: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('launchd'),
      label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    }),
    z.strictObject({
      kind: z.literal('systemd'),
      unit: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,127}\.service$/),
    }),
  ]),
  builder: z
    .strictObject({ repo: z.string().min(1).max(1024), root: z.string().min(1).max(1024) })
    .optional(),
});
export type SupervisorConfig = z.infer<typeof SupervisorConfig>;
