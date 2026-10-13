import { z } from 'zod';

/**
 * Which copy of an installation may work (PM-143, part of PM-135).
 *
 * Moving projectman to another machine, or restoring a backup next to the original, makes copies of
 * one home directory. Only one of them may run the scheduler and start AI sessions: two would answer
 * the same inbox, move the same tasks and spend the same subscription at once. The rule is a marker
 * file in the home directory, `instance.json`:
 *
 * - no file: the home is the **active** instance (every installation made before this rule);
 * - `standby`: a rehearsal or a not yet released copy. The server starts and shows its data, but runs
 *   no scheduler, no GitHub polling and no automatic starts, and refuses every AI session start;
 * - `retired`: the home was moved away. The server refuses to start on it at all.
 * - `engine` (PM-318): the home of a hybrid engine. The board moved to the cloud, this home keeps the
 *   machine's work (worktrees, CLI homes, transcripts) and is started as the engine only; the old
 *   single-machine database in it is a leftover that no server of any mode starts on.
 *
 * A malformed marker is not read as "active": the server stops, so a damaged file never lets a copy
 * work. Only a person changes a role (`scripts/migrate/cli.ts instance`); nothing in the server does.
 */
export const INSTANCE_MARKER_FILE = 'instance.json';

export const INSTANCE_ROLES = ['active', 'standby', 'retired', 'engine'] as const;
export type InstanceRole = (typeof INSTANCE_ROLES)[number];

export const InstanceMarker = z.strictObject({
  version: z.literal(1),
  role: z.enum(['standby', 'retired', 'engine']),
  /** Why the home has this role, in a person's words (shown in the refusal). */
  reason: z.string().min(1).max(500),
  /** When the role was set (ISO 8601). */
  setAt: z.iso.datetime(),
});
export type InstanceMarker = z.infer<typeof InstanceMarker>;

/** The role a marker (or its absence) gives a home. */
export function instanceRoleOf(marker: InstanceMarker | null): InstanceRole {
  return marker ? marker.role : 'active';
}

/** What may a home in this role do? One answer, used by the server start and by the move tool. */
export function instanceMayWork(role: InstanceRole): boolean {
  return role === 'active';
}
