// The engine's setup and start commands (PM-314; docs/MACHINE-DEPENDENT.md).
//
//   npm run engine -- init --cloud <https-url> --id <eng_…> [--name <name>] [--force]   (the key on standard input)
//   npm run engine -- project set <KEY> <path>
//   npm run engine -- repo add <KEY> <repo> <path> [--full-test "<command>"]
//   npm run engine -- repo remove <KEY> <repo>
//   npm run engine -- status [--json]   (PM-1087; --json is one line with the whole state, exit 0 in every state)
//   npm run engine -- logs [--lines N] [--json]   (PM-1087; the end of the service's output and error logs)
//   npm run engine -- keep-awake on|off   (PM-1086; the Mac stays awake while work runs; after the engine restarts)
//   npm run engine -- start
//   npm run engine -- app install|uninstall   (PM-1088; native macOS menu bar app)
//   npm run engine -- service install|uninstall|status|start|stop|restart   (macOS LaunchAgent, PM-318, PM-1087; deploy/mac/com.projectman.engine.plist)
//   npm run engine -- move-work-root <absolute path>   (PM-846; the engine is stopped; docs/DEPLOY.md "Separate work volume")
//   (all:[--home <dir>]; the home is PROJECTMAN_HOME or ~/.projectman)
//
// `start` runs the server in engine mode (PROJECTMAN_MODE=engine) in the foreground; stop it with Ctrl-C
// or SIGTERM, which pauses the running sessions first. In an engine package (PM-1104) it runs the built server
// under the package's own node (`start-command.ts`). Exit status: 0 done, 1 refused or not healthy, 2 wrong usage.
import { spawn, spawnSync } from 'node:child_process';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngineCli } from './commands';
import { engineStartCommand } from './start-command';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

runEngineCli(process.argv.slice(2), {
  menubar: {
    applicationsDir: path.join(homedir(), 'Applications'),
    supportDir: path.join(homedir(), 'Library/Application Support/projectman'),
    buildDir: path.join(homedir(), 'Library/Caches/projectman/menubar-build'),
    osRelease: release(),
    run: (command, args) => {
      const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return {
        status: result.status ?? 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.error?.message ?? '',
      };
    },
  },
  env: process.env,
  cwd: process.cwd(),
  readStdin,
  out: (text) => console.log(text),
  err: (text) => console.error(text),
  isRunning: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
  launchd: {
    root: root.replace(/\/$/, ''),
    nodePath: process.execPath,
    agentsDir: path.join(homedir(), 'Library', 'LaunchAgents'),
    uid: process.getuid?.() ?? 0,
    platform: process.platform,
    launchctl: (args) => {
      const result = spawnSync('launchctl', args, { encoding: 'utf8' });
      return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
  },
  startEngine: (_home, env) =>
    new Promise<number>((resolve) => {
      const { command, args } = engineStartCommand(root, process.execPath);
      const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
      // The engine pauses its sessions on SIGINT/SIGTERM; the signal is passed on, not handled here.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    }),
}).then((code) => process.exit(code));
