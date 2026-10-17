import { z } from 'zod';
import { EngineId } from '../domain/engine';
import { TaskKey } from '../domain/task';

/**
 * The commands of the protected administration adapter (PM-763) that a super-mode handoff can carry
 * (PM-762). The server's adapter and the handoff share this one definition, so what the Operator asks for,
 * what the owner approves and what the supervisor accepts are one shape. Nothing here names a program, a
 * path, an argument, a service or a container.
 */

export const IMAGE_PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type ImagePlatform = (typeof IMAGE_PLATFORMS)[number];

export const FULL_TEST_PROFILES = ['merge-test', 'full-test'] as const;
export type FullTestProfile = (typeof FULL_TEST_PROFILES)[number];

/** The full 40-hex commit of a card's work; an abbreviation or a ref is never accepted. */
export type AdministrationCommit = string;

export type AdministrationTarget = { kind: 'hub' } | { kind: 'engine'; id: EngineId };

export type AdministrationCommand =
  /** `expectedBootId` is the `bootId` the caller saw in `status`: a restart of a machine that has booted since is refused. */
  | { kind: 'restart'; target: AdministrationTarget; expectedBootId: string }
  | { kind: 'full_test'; taskKey: TaskKey; commit: AdministrationCommit; profile: FullTestProfile }
  | { kind: 'image_build'; taskKey: TaskKey; commit: AdministrationCommit; platforms: ImagePlatform[] }
  /** Only the release a human approved, to the target PM-752 recorded for it; no new image, no `release_report`. */
  | { kind: 'deploy'; releaseId: string };

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
]);
