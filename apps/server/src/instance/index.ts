import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INSTANCE_MARKER_FILE, InstanceMarker, instanceRoleOf } from '@projectman/shared';
import type { InstanceRole } from '@projectman/shared';

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
    throw new InstanceMarkerError(`${path} is not valid JSON: the instance role is unknown, so nothing starts`);
  }
  const parsed = InstanceMarker.safeParse(raw);
  if (!parsed.success)
    throw new InstanceMarkerError(`${path} is not an instance marker: the instance role is unknown, so nothing starts`);
  return parsed.data;
}

export function instanceRole(home: string): InstanceRole {
  return instanceRoleOf(readInstanceMarker(home));
}

/** Writes a `standby` or `retired` marker (atomically; mode 0600). */
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
 * Stops the server before it touches a retired home. A standby home passes (it works as a read-only
 * copy, see `buildApp`); a retired one never starts.
 */
export function assertHomeMayStart(home: string): InstanceRole {
  const marker = readInstanceMarker(home);
  if (marker?.role === 'retired')
    throw new InstanceMarkerError(
      `This home was retired (${marker.reason}) at ${marker.setAt}: another installation took over. ` +
        `A person must move it back with "scripts/migrate/cli.ts instance activate" after the other one stopped.`,
    );
  return instanceRoleOf(marker);
}
