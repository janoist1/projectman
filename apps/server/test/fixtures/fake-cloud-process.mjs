import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An SSH -> AWS -> Session Manager plugin tree, or a tar peer; no real cloud/SSH executable.
const [role, directory] = process.argv.slice(2);
fs.writeFileSync(path.join(directory, `${role.startsWith('ssh') ? 'ssh' : role}.pid`), String(process.pid));
if (role.startsWith('ssh') || role === 'aws') {
  spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), role.startsWith('ssh') ? 'aws' : 'plugin', directory],
    {
      stdio: 'inherit',
    },
  );
}
if (role === 'ssh-success')
  setInterval(() => {
    if (fs.existsSync(path.join(directory, 'plugin.pid'))) process.exit(0);
  }, 10);
if (role === 'plugin') process.on('SIGTERM', () => undefined);
process.stdin.resume();
setInterval(() => undefined, 1000);
