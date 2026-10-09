// The engine's setup and start commands (PM-314; docs/ARCHITECTURE.md "Machine-dependent parts").
//
//   npm run engine -- init --cloud <https-url> --id <eng_…> [--name <name>] [--force]   (the key on standard input)
//   npm run engine -- project set <KEY> <path>
//   npm run engine -- repo add <KEY> <repo> <path> [--full-test "<command>"]
//   npm run engine -- repo remove <KEY> <repo>
//   npm run engine -- status
//   npm run engine -- start
//   npm run engine -- service install|uninstall|status   (macOS LaunchAgent, PM-318; deploy/mac/com.projectman.engine.plist)
//   (all:[--home <dir>]; the home is PROJECTMAN_HOME or ~/.projectman)
//
// `start` runs the server in engine mode (PROJECTMAN_MODE=engine) in the foreground; stop it with Ctrl-C
// or SIGTERM, which pauses the running sessions first. Exit status: 0 done, 1 refused or not healthy, 2 wrong usage.
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEngineCli } from './commands';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

runEngineCli(process.argv.slice(2), {
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
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', path.join(root, 'apps/server/src/index.ts')],
        {
          cwd: root,
          env,
          stdio: 'inherit',
        },
      );
      // The engine pauses its sessions on SIGINT/SIGTERM; the signal is passed on, not handled here.
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
      child.on('exit', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    }),
}).then((code) => process.exit(code));
