import path from 'node:path';

/** The single-mode recovery server's LaunchAgent. */
export const SERVER_LABEL = 'com.projectman.live';

/**
 * The launcher the plists start instead of `node` (PM-514): macOS names a background item after the
 * first element of `ProgramArguments`. They are files of the checkout, so they come with every release.
 */
export const SERVER_LAUNCHER = 'projectman-live';
export const launcherFile = (root: string, name: string) => path.join(root, 'scripts', 'live', 'bin', name);

/** The port and the shutdown pause the install falls back to. */
export const DEFAULT_PORT = 4800;
export const DEFAULT_SHUTDOWN_PAUSE_MS = 60_000;

/** An error that ends a live command with a message and an exit status (2: refused, 1: failed). */
export class LiveError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export const SHA40 = /^[0-9a-f]{40}$/;

export const serverLog = (home: string) => path.join(home, 'logs', 'live-server.log');

export const agentsDir = (homeDir: string) => path.join(homeDir, 'Library', 'LaunchAgents');
export const plistFile = (homeDir: string, label: string) => path.join(agentsDir(homeDir), `${label}.plist`);

export const domainTarget = (uid: number, label: string) => `gui/${uid}/${label}`;
