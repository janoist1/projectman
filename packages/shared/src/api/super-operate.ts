import { z } from 'zod';
import { OwnerCommandResult } from './administration';
import { NewSuperCommand, SuperCommand, SuperOperation } from './super-handoff';
import { TaskKey } from '../domain/task';

/**
 * The super mode's direct operations, administration reads and filtered diagnostics (PM-764). The integrator
 * starts a command without a handoff (`POST .../operator-super/operations`), reads the status and the
 * diagnostics of the hub or of an engine linked to the project, and queries a closed catalogue of the project's
 * own records by name. Nothing here takes SQL, a path, a program or a free-text filter.
 */

const SUPER_LIST_LIMIT_DEFAULT = 50;
const SUPER_LIST_LIMIT_MAX = 200;

const Limit = z.coerce.number().int().min(1).max(SUPER_LIST_LIMIT_MAX);

/** `POST /api/projects/:key/operator-super/operations`: the same commands as a handoff carries, started at once. */
export const SuperOperateRequest = z.strictObject({
  requestId: z.uuid(),
  taskKey: TaskKey.optional(),
  command: NewSuperCommand,
});
export type SuperOperateRequest = z.infer<typeof SuperOperateRequest>;

export const SuperOperateResponse = z.strictObject({ operation: SuperOperation });
export type SuperOperateResponse = z.infer<typeof SuperOperateResponse>;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What a finished administration operation produced, as the adapter recorded it. A restart's boot id, a full
 * test's verdict and failed file names, an image's digest and checksum (never a path, never the image), a
 * deploy's release id, or bounded redacted output from an owner-approved command. No raw error.
 */
export const SuperAdministrationResult = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('restart'), bootId: z.string(), version: z.string().nullable() }),
  z.strictObject({
    kind: z.literal('full_test'),
    outcome: z.enum(['passed', 'failed', 'error']),
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().min(0),
    failedFiles: z.array(z.string()),
  }),
  z.strictObject({
    kind: z.literal('image_build'),
    artifacts: z.array(
      z.strictObject({
        artifactId: z.string(),
        platform: z.enum(['linux/amd64', 'linux/arm64']),
        commit: z.string(),
        imageDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
        archiveSha256: Sha256Hex,
        bytes: z.number().int().min(0),
      }),
    ),
  }),
  z.strictObject({ kind: z.literal('deploy'), releaseId: z.string() }),
  // Numbers only: no process name, command line or id of the processes that were stopped (PM-886).
  z.strictObject({
    kind: z.literal('process_cleanup'),
    found: z.number().int().min(0),
    stopped: z.number().int().min(0),
    remaining: z.number().int().min(0),
  }),
  OwnerCommandResult,
]);
export type SuperAdministrationResult = z.infer<typeof SuperAdministrationResult>;

/** `GET .../operations/:id`: the operation and, once the adapter recorded it, its result. */
export const SuperOperationDetail = z.strictObject({
  operation: SuperOperation,
  result: SuperAdministrationResult.nullable(),
});
export type SuperOperationDetail = z.infer<typeof SuperOperationDetail>;

/** The closed catalogue of the filtered diagnostics, by name. */
export const SUPER_DIAGNOSTIC_QUERIES = ['tasks', 'sessions', 'merges', 'operations'] as const;
export type SuperDiagnosticQuery = (typeof SUPER_DIAGNOSTIC_QUERIES)[number];

/**
 * The columns each query may show, and no others: no user, key, secret, inbox text or other personal data is
 * in any of them. The response lists them in this order.
 */
export const SUPER_DIAGNOSTIC_COLUMNS = {
  tasks: ['key', 'stage', 'status', 'assignee', 'updatedAt'],
  sessions: ['id', 'taskKey', 'member', 'state', 'engineId'],
  merges: ['taskKey', 'repo', 'state', 'commit'],
  operations: ['id', 'taskKey', 'state', 'operation', 'createdAt', 'updatedAt'],
} as const satisfies Record<SuperDiagnosticQuery, readonly string[]>;

export const SuperDiagnosticsRequest = z.strictObject({
  query: z.enum(SUPER_DIAGNOSTIC_QUERIES),
  taskKey: TaskKey.optional(),
  limit: Limit.default(SUPER_LIST_LIMIT_DEFAULT),
});
export type SuperDiagnosticsRequest = z.infer<typeof SuperDiagnosticsRequest>;

export const SuperDiagnosticValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SuperDiagnosticValue = z.infer<typeof SuperDiagnosticValue>;

export const SuperDiagnosticsResponse = z.strictObject({
  columns: z.array(z.string()),
  rows: z.array(z.array(SuperDiagnosticValue)),
  truncated: z.boolean(),
});
export type SuperDiagnosticsResponse = z.infer<typeof SuperDiagnosticsResponse>;

/** What an operation is called in the operations catalogue: the command kind, with the operation or request kind. */
export function superOperationName(command: SuperCommand): string {
  switch (command.kind) {
    case 'operate':
      return `operate:${command.operation.op}`;
    case 'administration':
      return 'administration';
    default:
      return command.kind;
  }
}

/**
 * The argument shapes of the MCP tools that will return these answers (the output binding is a later card):
 * the same fields as the routes, in the tools' snake_case. No tool is registered by this card.
 */
const ProjectKeyArg = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/);
/** The id of the queue item a connected Claude's step works on. */
const QueueItemIdArg = z.string().min(1).max(100);

export const SuperOperateArgs = z.strictObject({
  project_key: ProjectKeyArg,
  request_id: z.uuid(),
  task_key: TaskKey.optional(),
  command: NewSuperCommand,
  /** The open queue item this command works on: the step is then recorded under the item issuer's name (decision 66). */
  queue_item_id: QueueItemIdArg.optional(),
});
export const GetSuperOperationArgs = z.strictObject({
  project_key: ProjectKeyArg,
  operation_id: z.string().min(1).max(100),
});
export const QuerySuperDiagnosticsArgs = z.strictObject({
  project_key: ProjectKeyArg,
  query: z.enum(SUPER_DIAGNOSTIC_QUERIES),
  task_key: TaskKey.optional(),
  limit: Limit.optional(),
});
