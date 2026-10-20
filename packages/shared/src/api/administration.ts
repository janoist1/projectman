import { z } from 'zod';
import { EngineId } from '../domain/engine';
import { TaskKey } from '../domain/task';

/**
 * The commands of the protected administration adapter (PM-763) that a super-mode handoff can carry
 * (PM-762). The server's adapter and the handoff share this one definition, so what the Operator asks for,
 * what the owner approves and what the supervisor accepts are one shape. Only `owner_command` carries a
 * shell command and path; it requires the owner's own approval for each operation (PM-887).
 */

export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type ImagePlatform = (typeof IMAGE_PLATFORMS)[number];

export const FULL_TEST_PROFILES = ['merge-test', 'full-test'] as const;
export type FullTestProfile = (typeof FULL_TEST_PROFILES)[number];

/** The named sets of processes a `process_cleanup` may stop; the supervisor owns what each one means (PM-886). */
export const PROCESS_CLEANUP_SELECTORS = ['orphan_test_workers'] as const;
export type ProcessCleanupSelector = (typeof PROCESS_CLEANUP_SELECTORS)[number];

/** The full 40-hex commit of a card's work; an abbreviation or a ref is never accepted. */
export type AdministrationCommit = string;

export type AdministrationTarget = { kind: 'hub' } | { kind: 'engine'; id: EngineId };

export type AdministrationCommand =
  /** `expectedBootId` is the `bootId` the caller saw in `status`: a restart of a machine that has booted since is refused. */
  | { kind: 'restart'; target: AdministrationTarget; expectedBootId: string }
  | { kind: 'full_test'; taskKey: TaskKey; commit: AdministrationCommit; profile: FullTestProfile }
  | { kind: 'image_build'; taskKey: TaskKey; commit: AdministrationCommit; platforms: ImagePlatform[] }
  /** Only the release a human approved, to the target PM-752 recorded for it; no new image, no `release_report`. */
  | { kind: 'deploy'; releaseId: string }
  /** Stops the named set of the supervisor user's processes on the target's own machine (PM-886). */
  | { kind: 'process_cleanup'; target: AdministrationTarget; selector: ProcessCleanupSelector }
  | {
      kind: 'owner_command';
      target: AdministrationTarget;
      command: string;
      cwd?: string;
      timeoutSeconds: number;
      reason: string;
    };

/** Per stream, including JSON escaping and the enclosing quotes (PM-887). */
export const OWNER_COMMAND_OUTPUT_BYTES = 64 * 1024;

const OwnerCommandOutput = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= OWNER_COMMAND_OUTPUT_BYTES,
  );
export const OwnerCommandResult = z.strictObject({
  kind: z.literal('owner_command'),
  exitCode: z.number().int().nullable(),
  signal: z.string().max(64).nullable(),
  stdout: OwnerCommandOutput,
  stderr: OwnerCommandOutput,
  truncated: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});
export type OwnerCommandResult = z.infer<typeof OwnerCommandResult>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const BOOT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export const AdministrationOperationId = z.string().regex(SAFE_ID);
export const AdministrationBootId = z.string().regex(BOOT_ID);
export const AdministrationCommitSchema = z.string().regex(COMMIT);

export const AdministrationTargetSchema: z.ZodType<AdministrationTarget> = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hub') }),
  z.strictObject({ kind: z.literal('engine'), id: EngineId }),
]);

export const AdministrationCommandSchema: z.ZodType<AdministrationCommand> = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('restart'),
    target: AdministrationTargetSchema,
    expectedBootId: AdministrationBootId,
  }),
  z.strictObject({
    kind: z.literal('full_test'),
    taskKey: TaskKey,
    commit: AdministrationCommitSchema,
    profile: z.enum(FULL_TEST_PROFILES),
  }),
  z.strictObject({
    kind: z.literal('image_build'),
    taskKey: TaskKey,
    commit: AdministrationCommitSchema,
    platforms: z
      .array(z.enum(IMAGE_PLATFORMS))
      .min(1)
      .max(2)
      .refine((platforms) => new Set(platforms).size === platforms.length, { message: 'Duplicate platform' }),
  }),
  z.strictObject({ kind: z.literal('deploy'), releaseId: AdministrationOperationId }),
  z.strictObject({
    kind: z.literal('process_cleanup'),
    target: AdministrationTargetSchema,
    selector: z.enum(PROCESS_CLEANUP_SELECTORS),
  }),
  z.strictObject({
    kind: z.literal('owner_command'),
    target: AdministrationTargetSchema,
    command: z
      .string()
      .min(1)
      .max(2000)
      .refine((value) => !value.includes('\0')),
    cwd: z
      .string()
      .min(1)
      .max(500)
      .startsWith('/')
      .refine((value) => !value.includes('\0'))
      .optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(120),
    reason: z.string().min(1).max(500),
  }),
]);
