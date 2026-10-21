import path from 'node:path';
import { SupervisorConfig } from './schemas';
import { AdministrationSetupError, assertPrivateDir, readPrivateFile } from './secure-fs';

/**
 * The supervisor's protected configuration file (PM-763): written once by the installer (0600, owned by the
 * service user), read at start-up, never changed by a request. It names the one service the supervisor may
 * restart; nothing a caller sends can replace any part of it.
 */

export const MAX_CONFIG_BYTES = 8 * 1024;

export async function loadSupervisorConfig(file: string): Promise<SupervisorConfig> {
  if (!path.isAbsolute(file))
    throw new AdministrationSetupError('unsupported', 'the config path must be absolute');
  const text = await readPrivateFile(file, MAX_CONFIG_BYTES);
  if (text === null)
    throw new AdministrationSetupError('missing', 'the supervisor config file does not exist');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AdministrationSetupError('unsupported', 'the supervisor config is not valid JSON');
  }
  const parsed = SupervisorConfig.safeParse(json);
  if (!parsed.success)
    throw new AdministrationSetupError('unsupported', 'the supervisor config has an unsupported shape');
  const config = parsed.data;
  if (!path.isAbsolute(config.stateDir) || !path.isAbsolute(config.socketPath))
    throw new AdministrationSetupError(
      'unsupported',
      'the state directory and the socket path must be absolute',
    );
  if (config.builder && (!path.isAbsolute(config.builder.repo) || !path.isAbsolute(config.builder.root)))
    throw new AdministrationSetupError('unsupported', 'the builder paths must be absolute');
  if (config.service.kind === 'launchd' && config.service.logFile && !path.isAbsolute(config.service.logFile))
    throw new AdministrationSetupError('unsupported', 'the service log file path must be absolute');
  await assertPrivateDir(config.stateDir);
  await assertPrivateDir(path.dirname(config.socketPath));
  return config;
}

/** The service manager the host is expected to run: launchd on macOS, systemd elsewhere. */
export function expectedServiceKind(platform: NodeJS.Platform): 'launchd' | 'systemd' | null {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  return null;
}
