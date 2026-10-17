import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CloudConfig } from '../../../../scripts/cloud/config';
import type { LoadedHybridConfig } from '../../../../scripts/release/config';
import type { WatcherDeps } from '../../../../scripts/release/service';

/**
 * A launchd that behaves like the real one for the watcher's three commands (print, bootout, bootstrap), a home
 * directory with `Library/LaunchAgents`, and a stable admin checkout the watcher may be installed from.
 */
export class FakeLaunchd {
  readonly dir = fs.realpathSync(fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pm751-launchd-')));
  readonly homeDir = path.join(this.dir, 'home');
  readonly root = path.join(this.dir, 'projectman-admin');
  readonly stateDir = path.join(this.homeDir, '.config', 'projectman', 'cloud', 'release-state');
  readonly configFile = path.join(this.homeDir, '.config', 'projectman', 'cloud', 'release.json');
  loaded = new Set<string>();
  /** The pid `launchctl print` names for a loaded job. */
  pids = new Map<string, number>();
  /** Every launchctl call as `verb label`. */
  calls: string[] = [];
  /** The state `launchctl print` shows for a loaded job. */
  jobState: 'waiting' | 'running' = 'waiting';
  bootoutStatus = 0;
  bootstrapStatus = 0;
  time = Date.parse('2026-10-17T10:00:00.000Z');
  output: string[] = [];
  platform: NodeJS.Platform = 'darwin';
  env: NodeJS.ProcessEnv = { PATH: '/opt/homebrew/bin:/usr/bin' };

  constructor() {
    fs.mkdirSync(path.join(this.homeDir, 'Library', 'LaunchAgents'), { recursive: true });
    fs.mkdirSync(path.join(this.homeDir, '.config', 'projectman', 'cloud'), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(this.homeDir, '.config', 'projectman', 'cloud'), 0o700);
    fs.mkdirSync(path.join(this.root, 'scripts', 'release', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(this.root, 'scripts', 'release', 'cli.ts'), '');
    fs.writeFileSync(
      path.join(this.root, 'scripts', 'release', 'bin', 'projectman-hybrid-release-watcher'),
      '#!/bin/sh\nexec "$@"\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(this.configFile, '{}\n', { mode: 0o600 });
  }

  /** A configuration as the loader returns it, for the commands that only need its paths. */
  loadedConfig(): LoadedHybridConfig {
    return {
      config: { stateDir: this.stateDir },
      configFile: this.configFile,
      configSha256: 'e'.repeat(64),
      cloud: {} as CloudConfig,
      targetHash: 'a'.repeat(64),
      secretsRoot: path.join(this.homeDir, '.config', 'projectman', 'cloud'),
    } as unknown as LoadedHybridConfig;
  }

  plist(label: string): string {
    return path.join(this.homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  }

  deps(overrides: Partial<WatcherDeps> = {}): WatcherDeps {
    return {
      run: async (command, args) => {
        if (command !== 'launchctl') return { status: 127, stdout: '', stderr: 'not found' };
        const verb = args[0]!;
        const label =
          verb === 'bootstrap'
            ? path.basename(args[2]!, '.plist')
            : args[1]!.slice(args[1]!.lastIndexOf('/') + 1);
        this.calls.push(`${verb} ${label}`);
        if (verb === 'print')
          return this.loaded.has(label)
            ? {
                status: 0,
                stdout: `state = ${this.jobState}\n${this.pids.has(label) ? `\tpid = ${this.pids.get(label)}\n` : ''}`,
                stderr: '',
              }
            : { status: 113, stdout: '', stderr: 'not found' };
        if (verb === 'bootout') {
          if (this.bootoutStatus === 0) this.loaded.delete(label);
          return { status: this.bootoutStatus, stdout: '', stderr: '' };
        }
        if (verb === 'bootstrap') {
          if (this.bootstrapStatus === 0) this.loaded.add(label);
          return { status: this.bootstrapStatus, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unknown verb' };
      },
      uid: 501,
      now: () => new Date(this.time),
      sleep: async (ms) => {
        this.time += ms;
      },
      homeDir: this.homeDir,
      platform: this.platform,
      nodePath: process.execPath,
      env: this.env,
      out: (text) => this.output.push(text),
      ...overrides,
    };
  }

  cleanup(): void {
    fs.rmSync(this.dir, { recursive: true, force: true });
  }
}
