import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import {
  EngineConfigError,
  engineFiles,
  writeSecretFile,
} from '../../apps/server/src/engine-link/engine-config';
import { readEnginePackage } from '../../apps/server/src/engine-link/engine-package';
import { readEngineStatus } from '../../apps/server/src/engine-link/engine-status';
import {
  bootstrapJob,
  installedServiceFor,
  installService,
  plistString,
  serviceInstallation,
  serviceState,
  stopService,
} from './service';
import type { ServiceOptions } from './service';
import { readSwitchState, switchPaths } from './switch-state';
import type { EngineSwitchState } from './switch-state';

interface SwitchOptions extends ServiceOptions {
  isRunning: (pid: number) => boolean;
  now?: () => number;
}

/** Public mutations are held while a switch owns the service, including after an interruption. */
export function assertNotSwitching(home: string): void {
  if (readSwitchState(home)?.phase === 'switching')
    throw new EngineConfigError('switch_in_progress', 'An engine switch is in progress.');
}

/** O_EXCL is the arbitration point. An unreadable/unfinished owner record is conservatively busy. */
function lockSwitch(options: SwitchOptions): () => void {
  const file = switchPaths(options.home).lock;
  mkdirSync(options.home, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return () => rmSync(file, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try {
        pid = Number(readFileSync(file, 'utf8'));
      } catch {
        continue;
      }
      if (!Number.isSafeInteger(pid) || pid <= 0 || options.isRunning(pid)) break;
      rmSync(file, { force: true });
    }
  }
  throw new EngineConfigError('switch_busy', 'Another engine switch owns the lock.');
}

function saveState(home: string, state: EngineSwitchState): void {
  writeSecretFile(switchPaths(home).state, `${JSON.stringify(state)}\n`);
}

/** Both the launchd pid and its status must refer to the new run; a stale status cannot pass. */
async function verify(
  options: SwitchOptions,
  version: string,
  connected: boolean,
  oldBootId?: string,
): Promise<void> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= 120_000; waited += 1000) {
    const service = serviceState(options);
    const status = readEngineStatus(engineFiles(options.home).status);
    if (
      service.running &&
      service.pid !== null &&
      options.isRunning(service.pid) &&
      status?.pid === service.pid &&
      status.bootId !== oldBootId &&
      status.version === version &&
      (!connected || status.connection === 'connected')
    )
      return;
    if (waited < 120_000) await sleep(1000);
  }
  throw new EngineConfigError(
    'switch_verify_timeout',
    'The engine did not report the required version and connection within 120 s.',
  );
}

async function rollback(options: SwitchOptions, state: EngineSwitchState): Promise<never> {
  const paths = switchPaths(options.home);
  let phase: 'rolled_back' | 'recovery_required' = 'recovery_required';
  try {
    if (!state.previous) throw new Error('The previous engine version is unknown.');
    // Read the backup before touching launchd: a missing backup cannot justify another destructive step.
    const previous = readFileSync(paths.previous);
    const oldBootId = readEngineStatus(engineFiles(options.home).status)?.bootId;
    await stopService(options);
    const plist = installedServiceFor(options.home, options.agentsDir);
    // A torn/missing current file is recoverable; an agent explicitly belonging to another home is not.
    const target = path.join(options.agentsDir, 'com.projectman.engine.plist');
    if (!plist && existsSync(target) && plistString(readFileSync(target, 'utf8'), 'PROJECTMAN_HOME') !== null)
      throw new Error('The installed service belongs to another home.');
    writeFileSync(`${target}.switch-tmp`, previous, { mode: 0o644 });
    renameSync(`${target}.switch-tmp`, target);
    await bootstrapJob(options, target);
    // Rollback verifies the previous version; cloud availability must not prevent local recovery.
    await verify(options, state.previous.version, false, oldBootId);
    phase = 'rolled_back';
  } catch {
    /* The durable phase below tells the app that manual recovery is required. */
  }
  const code = phase === 'rolled_back' ? 'switch_rolled_back' : 'switch_recovery_required';
  // Keep fixed, non-sensitive error text in the snapshot (filesystem errors may contain private paths).
  const message =
    phase === 'rolled_back'
      ? 'The switch failed; the previous engine was restored and verified.'
      : 'The previous engine could not be restored and verified; manual recovery is required.';
  saveState(options.home, {
    ...state,
    phase,
    updatedAt: new Date((options.now ?? Date.now)()).toISOString(),
    error: { code, message },
  });
  throw new EngineConfigError(code, message);
}

/** The CLI alone writes the switch state and the saved plist (PM-1124). */
export async function switchService(
  options: SwitchOptions,
  request: { to?: string; clear?: boolean } = {},
): Promise<void> {
  const unlock = lockSwitch(options);
  try {
    const paths = switchPaths(options.home);
    const interrupted = readSwitchState(options.home);
    if (request.clear) {
      if (interrupted?.phase === 'switching')
        throw new EngineConfigError(
          'switch_in_progress',
          'Recover the interrupted switch before clearing its state.',
        );
      rmSync(paths.state, { force: true });
      rmSync(paths.previous, { force: true });
      return;
    }
    if (interrupted?.phase === 'switching') await rollback(options, interrupted);
    const plist = installedServiceFor(options.home, options.agentsDir);
    const bytes = plist ? readFileSync(plist) : null;
    const installed = bytes ? serviceInstallation(bytes.toString('utf8')) : null;
    if (installed?.manager !== 'app')
      throw new EngineConfigError(
        'switch_checkout_engine',
        'Only an app-managed engine can switch packages.',
      );
    const root = path.resolve(request.to ?? options.root);
    const manifest = readEnginePackage(root);
    if (
      !manifest ||
      !['bin/node', 'apps/server/dist/index.js', 'deploy/mac/com.projectman.engine.plist'].every((file) =>
        statSync(path.join(root, file), { throwIfNoEntry: false })?.isFile(),
      )
    )
      throw new EngineConfigError('switch_target_invalid', 'The target is not a complete engine package.');
    const status = readEngineStatus(engineFiles(options.home).status);
    const connected = status !== null && options.isRunning(status.pid) && status.connection === 'connected';
    const at = new Date((options.now ?? Date.now)()).toISOString();
    const state: EngineSwitchState = {
      schemaVersion: 1,
      phase: 'switching',
      target: { version: manifest.version, tag: manifest.tag },
      previous: installed.package ? { version: installed.package.version, tag: installed.package.tag } : null,
      startedAt: at,
      updatedAt: at,
      error: null,
    };
    // A previous failed attempt's backup must never be paired with this attempt's state.
    rmSync(paths.previous, { force: true });
    saveState(options.home, state);
    try {
      writeFileSync(`${paths.previous}.tmp`, bytes!, { mode: 0o600 });
      renameSync(`${paths.previous}.tmp`, paths.previous);
      await stopService(options);
      await installService({
        ...options,
        root,
        pathEnv: plistString(bytes!.toString('utf8'), 'PATH') ?? '',
        preservePathEnv: true,
      });
      await verify(options, manifest.version, connected, status?.bootId);
    } catch {
      await rollback(options, state);
    }
    rmSync(paths.state, { force: true });
    rmSync(paths.previous, { force: true });
    options.out('engine package switched and verified');
  } finally {
    unlock();
  }
}
