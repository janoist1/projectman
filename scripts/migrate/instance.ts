import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  clearInstanceMarker,
  instanceRole,
  readInstanceMarker,
  writeInstanceMarker,
} from '../../apps/server/src/instance';
import {
  ENGINE_CONFIG_FILE,
  ENGINE_KEY_FILE,
  ENGINE_STATUS_FILE,
} from '../../apps/server/src/engine-link/engine-config';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import { installedServiceFor } from '../engine/service';
import { ACTIVATED_FILE, APPLY_REPORT_FILE, MIGRATED_DIR } from './apply';
import { databaseInUse, snapshotDatabase } from './database';
import { MigrationRefused } from './package';

/**
 * Who may work (PM-143): the person's commands that change the role marker of a home. Only one copy
 * of an installation is ever active. A home is made `retired` after it was moved away, and a copy is
 * made `active` only when the person says the other one is retired (and, on one machine, shows it).
 * All of these refuse while a server has the home's database open.
 */

/** Whether a process with this pid exists (signal 0; a process of another user counts as alive). */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

/**
 * A LaunchAgent for this home restarts the engine after every exit, so a stopped engine is not enough:
 * the service has to be uninstalled before the home is turned back (PM-318).
 */
export function assertNoEngineService(home: string, agentsDir?: string): void {
  const plist = installedServiceFor(home, agentsDir);
  if (plist)
    throw new MigrationRefused(
      `the engine service is still installed (${plist}): it would restart the engine; run "npm run engine -- service uninstall" first`,
    );
}

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

/**
 * The home becomes a hybrid engine home (PM-318): only the engine (`npm run engine -- start`) starts on
 * it, no server. `hybrid package` has written `engine.json` and `engine.key`; both are needed.
 */
export function engineHome(home: string, reason: string, now?: Date): void {
  const dir = resolve(home);
  for (const file of [ENGINE_CONFIG_FILE, ENGINE_KEY_FILE])
    if (!existsSync(join(dir, file)))
      throw new MigrationRefused(`${dir} has no ${file}: run "hybrid package" for this home first`);
  if (instanceRole(dir) === 'retired')
    throw new MigrationRefused(`${dir} is retired: activate it first, or use another home`);
  assertStopped(dir);
  writeInstanceMarker(dir, 'engine', reason, now);
}

/** Whether the home's database has an engine registry with an engine in it (the cloud's data has). */
function databaseHasEngines(home: string): boolean {
  if (!existsSync(join(home, 'db.sqlite'))) return false;
  const snapshot = snapshotDatabase(home);
  try {
    if (!snapshot.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'engines'").get()) return false;
    return Number((snapshot.db.prepare('SELECT count(*) AS n FROM engines').get() as { n: number }).n) > 0;
  } finally {
    snapshot.dispose();
  }
}

export interface ActivateOptions {
  home: string;
  /** Another home on this machine that must be retired (its marker is read). */
  otherHome?: string;
  /** The person's statement that the other installation, on another machine, is retired and stopped. */
  confirmSourceRetired?: boolean;
  /** From the `engine` role: go on although the home's database is not the cloud's (its changes are lost). */
  discardCloudData?: boolean;
  /** For tests: whether a process is alive (default: signal 0). */
  isRunning?: (pid: number) => boolean;
  /** For tests: where the engine's LaunchAgent would be (default: `~/Library/LaunchAgents`). */
  agentsDir?: string;
}

/** Makes the copy the active instance. Refuses without proof or statement that the other one is retired. */
export function activateHome(options: ActivateOptions): void {
  const home = resolve(options.home);
  assertStopped(home);
  if (instanceRole(home) === 'engine') {
    // The way back from the hybrid mode: the "other installation" is the cloud, which a person stops.
    if (!options.confirmSourceRetired)
      throw new MigrationRefused(
        'this is a hybrid engine home: say that the cloud is stopped and retired: --confirm-source-retired',
      );
    const status = readEngineStatus(join(home, ENGINE_STATUS_FILE));
    if (status && (options.isRunning ?? processAlive)(status.pid))
      throw new MigrationRefused(`the engine is running (pid ${status.pid}): stop it first`);
    assertNoEngineService(home, options.agentsDir);
    if (!options.discardCloudData && !databaseHasEngines(home))
      throw new MigrationRefused(
        'this home\'s database is not the cloud\'s data (it has no engine): run "hybrid back" first, or add --discard-cloud-data to leave the work done in the cloud behind',
      );
  } else if (options.otherHome) {
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
  const migrated = join(home, MIGRATED_DIR);
  if (existsSync(migrated)) {
    // A copy whose apply did not finish is incomplete data: it is never released.
    if (!existsSync(join(migrated, APPLY_REPORT_FILE)))
      throw new MigrationRefused(
        `${home} is a migrated copy whose apply did not finish (no ${join(MIGRATED_DIR, APPLY_REPORT_FILE)}): apply the package again into a new home`,
      );
    writeFileSync(
      join(migrated, ACTIVATED_FILE),
      `${JSON.stringify({ version: 1, activatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }
  clearInstanceMarker(home);
}
