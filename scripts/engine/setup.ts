import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentProvider } from '@projectman/shared';
import {
  assertHomeNotInUse,
  EngineConfig,
  EngineConfigError,
  engineFiles,
  loadEngineConfig,
  saveEngineConfig,
  writeSecretFile,
} from '../../apps/server/src/engine-link/engine-config';

/**
 * What `init` and `pair wait` (PM-1449) both write: the engine's configuration and its machine key. Kept apart from
 * `commands.ts` so that the pairing writes exactly what `init` writes.
 */

export class UsageError extends Error {}

/** PM-1187: the providers a new engine starts sessions for; Gemini's commands run without an OS sandbox. */
const DEFAULT_ALLOWED_PROVIDERS: AgentProvider[] = ['claude', 'codex', 'nanogpt'];

/** The real path of an existing regular file, resolved against `cwd`; its content is never read here. */
export const absoluteFile = (value: string, cwd: string, what: string): string => {
  const resolved = path.resolve(cwd, value);
  let real: string;
  try {
    real = realpathSync(resolved);
  } catch {
    throw new EngineConfigError('path_missing', `${what} does not exist: ${resolved}`);
  }
  if (!statSync(real).isFile())
    throw new EngineConfigError('path_not_file', `${what} is not a regular file: ${real}`);
  return real;
};

/**
 * The configuration a new setup replaces, or null when there is none. Refused while a server uses the home
 * (`home_in_use`), and when a configuration exists and `force` is not given (`config_exists`).
 */
export function previousEngineConfig(home: string, force: boolean): EngineConfig | null {
  assertHomeNotInUse(home);
  const file = engineFiles(home).config;
  const previous = existsSync(file) ? loadEngineConfig(home) : null;
  if (previous && !force)
    throw new EngineConfigError(
      'config_exists',
      `${file} exists. Use --force to set a new key or cloud address (the projects and repos stay).`,
    );
  return previous;
}

export interface EngineSetup {
  cloud: string;
  id: string;
  name?: string;
  /** Already resolved; without it the previous configuration's file stays. */
  linkHeadersFile?: string;
}

/** The configuration a setup writes; a re-run keeps the projects, repos, key files and settings that were there. */
export function buildEngineConfig(previous: EngineConfig | null, setup: EngineSetup): EngineConfig {
  const linkHeadersFile = setup.linkHeadersFile ?? previous?.linkHeadersFile;
  const allowedProviders = previous ? previous.allowedProviders : DEFAULT_ALLOWED_PROVIDERS;
  return EngineConfig.parse({
    schemaVersion: 1,
    cloudUrl: setup.cloud,
    engineId: setup.id,
    ...(setup.name ? { name: setup.name } : {}),
    ...(previous?.keyFile ? { keyFile: previous.keyFile } : {}),
    ...(linkHeadersFile ? { linkHeadersFile } : {}),
    ...(previous?.nanogptKeyFile ? { nanogptKeyFile: previous.nanogptKeyFile } : {}),
    projects: previous?.projects ?? [],
    repos: previous?.repos ?? [],
    maxPermissionMode: previous?.maxPermissionMode ?? 'auto',
    allowRemoteTerminalInput: previous?.allowRemoteTerminalInput ?? true,
    // PM-1187: a new engine leaves Gemini out; a re-run keeps what was there, a missing list too.
    ...(allowedProviders ? { allowedProviders } : {}),
  });
}

/** Writes the machine key (mode 0600) and the configuration; returns the key file. */
export function writeEngineSetup(home: string, config: EngineConfig, key: string): string {
  const keyFile = config.keyFile ?? engineFiles(home).key;
  writeSecretFile(keyFile, `${key}\n`);
  saveEngineConfig(home, config);
  return keyFile;
}
