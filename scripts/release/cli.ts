// The hybrid release coordinator (PM-751): one approved release goes to the cloud and to the Mac engine, or back.
//
//   npm run release -- plan|watch|install|status|uninstall --config <file>
//
// Exit status: 0 done or nothing to do, 1 failed (also a verified rollback), 2 refused, 64 bad usage.
// Documentation: docs/DEPLOY.md, "The hybrid release watcher".
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realDeps as realCloudDeps } from '../cloud/deps';
import { Report } from '../cloud/report';
import { ENV_FILE_NAME } from '../cloud/secrets';
import { realDeps as realLiveDeps } from '../live/deps';
import { buildPorts } from './adapters';
import type { HybridWorld } from './adapters';
import { runRelease } from './commands';
import type { ReleaseDeps } from './commands';

const home = os.homedir();
const live = realLiveDeps(home);
const out = (text: string) => process.stdout.write(text);

const watcher = {
  run: live.run,
  uid: live.uid,
  now: live.now,
  sleep: live.sleep,
  homeDir: home,
  platform: live.platform,
  nodePath: live.nodePath,
  env: live.env,
  out,
};

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

const deps: ReleaseDeps = {
  watcher,
  root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
  err: (text) => process.stderr.write(text),
  ports: ({ loaded, journal, signal, log }) => {
    const world: HybridWorld = {
      context: {
        deps: realCloudDeps(),
        config: loaded.cloud,
        report: new Report((line) => log(line)),
        secretsDir: loaded.secretsRoot,
        envFile: path.join(loaded.secretsRoot, ENV_FILE_NAME),
      },
      launchd: watcher,
      launchctlSync: (args) => {
        const result = spawnSync('launchctl', args, { encoding: 'utf8', timeout: 60_000 });
        return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
      },
      isPidAlive,
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'),
      nodePath: live.nodePath,
      platform: live.platform,
      out: (text) => log(text.trimEnd()),
    };
    return buildPorts({ world, loaded, journal, signal, log });
  },
  onInterrupt: (handler) => {
    process.once('SIGINT', handler);
    process.once('SIGTERM', handler);
    return () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    };
  },
};

runRelease(process.argv.slice(2), deps).then((code) => process.exit(code));
