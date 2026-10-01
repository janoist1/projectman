import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clearInstanceMarker,
  instanceRole,
  readInstanceMarker,
  writeInstanceMarker,
} from '../../apps/server/src/instance';
import { databaseInUse } from './database';
import { MigrationRefused } from './package';

/**
 * Who may work (PM-143): the person's commands that change the role marker of a home. Only one copy
 * of an installation is ever active. A home is made `retired` after it was moved away, and a copy is
 * made `active` only when the person says the other one is retired (and, on one machine, shows it).
 * All of these refuse while a server has the home's database open.
 */

function assertStopped(home: string): void {
  if (databaseInUse(home))
    throw new MigrationRefused(`a server has ${join(home, 'db.sqlite')} open: stop it first`);
}

export function instanceStatus(home: string): string {
  const marker = readInstanceMarker(resolve(home));
  return marker ? `${marker.role} since ${marker.setAt} (${marker.reason})` : 'active (no marker)';
}

/** The home was moved away: no server starts on it again until a person activates it. */
export function retireHome(home: string, reason: string, now?: Date): void {
  const dir = resolve(home);
  if (!existsSync(join(dir, 'db.sqlite'))) throw new MigrationRefused(`${dir} has no database`);
  assertStopped(dir);
  writeInstanceMarker(dir, 'retired', reason, now);
}

/** A copy that may show its data but never work. */
export function standbyHome(home: string, reason: string, now?: Date): void {
  const dir = resolve(home);
  assertStopped(dir);
  writeInstanceMarker(dir, 'standby', reason, now);
}

export interface ActivateOptions {
  home: string;
  /** Another home on this machine that must be retired (its marker is read). */
  otherHome?: string;
  /** The person's statement that the other installation, on another machine, is retired and stopped. */
  confirmSourceRetired?: boolean;
}

/** Makes the copy the active instance. Refuses without proof or statement that the other one is retired. */
export function activateHome(options: ActivateOptions): void {
  const home = resolve(options.home);
  assertStopped(home);
  if (options.otherHome) {
    const other = resolve(options.otherHome);
    if (other === home) throw new MigrationRefused('the other home is this home');
    if (existsSync(join(other, 'db.sqlite')) && instanceRole(other) !== 'retired')
      throw new MigrationRefused(
        `${other} is not retired (it is ${instanceRole(other)}): retire it first, only one copy may be active`,
      );
  } else if (!options.confirmSourceRetired) {
    throw new MigrationRefused(
      'name the other installation: --other-home PATH (its marker must be retired) or --confirm-source-retired (it is stopped and retired on another machine)',
    );
  }
  clearInstanceMarker(home);
}
