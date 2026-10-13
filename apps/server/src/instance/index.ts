import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_MARKER_FILE, InstanceMarker, instanceRoleOf } from '@projectman/shared';
import type { InstanceRole } from '@projectman/shared';
import type { RunMode } from '../app';

/**
 * The role marker of a home directory (PM-143): whether this copy of an installation may work. The
 * rule is in `packages/shared` (`instance-role.ts`); this file reads and writes the one file.
 */

export class InstanceMarkerError extends Error {}

function markerPath(home: string): string {
  return join(home, INSTANCE_MARKER_FILE);
}

/** The marker of a home, or null when there is none (the home is the active instance). */
export function readInstanceMarker(home: string): InstanceMarker | null {
  const path = markerPath(home);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new InstanceMarkerError(
      `${path} is not valid JSON: the instance role is unknown, so nothing starts`,
    );
  }
  const parsed = InstanceMarker.safeParse(raw);
  if (!parsed.success)
    throw new InstanceMarkerError(
      `${path} is not an instance marker: the instance role is unknown, so nothing starts`,
    );
  return parsed.data;
}

export function instanceRole(home: string): InstanceRole {
  return instanceRoleOf(readInstanceMarker(home));
}

/** Writes a `standby`, `retired` or `engine` marker (atomically; mode 0600). */
export function writeInstanceMarker(
  home: string,
  role: Exclude<InstanceRole, 'active'>,
  reason: string,
  now: Date = new Date(),
): InstanceMarker {
  const marker = InstanceMarker.parse({ version: 1, role, reason, setAt: now.toISOString() });
  const temporary = join(home, `.${INSTANCE_MARKER_FILE}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(marker, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, markerPath(home));
  return marker;
}

/** Makes the home the active instance again: removes the marker. */
export function clearInstanceMarker(home: string): void {
  rmSync(markerPath(home), { force: true });
}

/**
 * Stops a process before it touches a home it must not work in. A standby home passes (it works as a
 * read-only copy, see `buildApp`); a retired one never starts. A hybrid engine home (PM-318) starts only
 * the engine: the single-machine and the cloud server refuse it, and the engine refuses a home that still
 * is a live single-machine one (a database and no `engine` marker), because it would work in the same
 * worktrees as that server.
 */
export function assertHomeMayStart(home: string, mode: RunMode = 'single'): InstanceRole {
  const marker = readInstanceMarker(home);
  if (marker?.role === 'retired')
    throw new InstanceMarkerError(
      `This home was retired (${marker.reason}) at ${marker.setAt}: another installation took over. ` +
        `A person must move it back with "scripts/migrate/cli.ts instance activate" after the other one stopped.`,
    );
  if (mode === 'engine') {
    if (marker?.role !== 'engine' && databaseExists(home))
      throw new InstanceMarkerError(
        `${home} holds a projectman database and is not marked as a hybrid engine home: the engine would work in ` +
          `the same worktrees as a live installation. Give the engine its own home, or mark this one with ` +
          `"npm run migrate -- instance engine --home ${home}" after the move to the cloud.`,
      );
  } else if (marker?.role === 'engine') {
    throw new InstanceMarkerError(
      'this home is a hybrid engine home; start it with `npm run engine -- start`',
    );
  }
  return instanceRoleOf(marker);
}

function databaseExists(home: string): boolean {
  try {
    return readdirSync(home).some((name) => name.startsWith('db.sqlite'));
  } catch {
    return false; // no such directory yet: a new engine home
  }
}
