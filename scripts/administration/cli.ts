// The administration adapter's installer preparation (PM-763; docs/SECURITY.md "Administration adapter").
//
//   npm run administration -- prepare --target hub|engine:<engine id> --service <launchd label | systemd unit> \
//       --state-dir <dir> --socket-dir <dir> --out <dir> [--user <name> [--group <name>]]
//
// It writes the supervisor's protected configuration (`supervisor.json`, 0600) and the service file for this
// machine's service manager (launchd on macOS, systemd on Linux) into `--out`. It installs, loads, starts or
// enables nothing and never calls launchctl or systemctl: placing the files and starting the supervisor on a
// live machine is a separate rollout the owner approves. Exit status: 0 done, 1 refused, 2 wrong usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdministrationSetupError } from '../../apps/server/src/administration';
import { PrepareError, prepareFiles, writePrepared } from './prepare';

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const FLAGS = ['target', 'service', 'state-dir', 'socket-dir', 'out', 'user', 'group'] as const;

function parseFlags(args: string[]): Partial<Record<(typeof FLAGS)[number], string>> | null {
  const out: Partial<Record<(typeof FLAGS)[number], string>> = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]?.replace(/^--/, '');
    const value = args[index + 1];
    if (!args[index]?.startsWith('--') || !FLAGS.includes(name as never) || value === undefined) return null;
    out[name as (typeof FLAGS)[number]] = value;
  }
  return out;
}

const [command, ...rest] = process.argv.slice(2);
const flags = command === 'prepare' ? parseFlags(rest) : null;
if (!flags || !flags.target || !flags.service || !flags['state-dir'] || !flags['socket-dir'] || !flags.out) {
  console.error(
    'usage: npm run administration -- prepare --target hub|engine:<engine id> --service <label|unit> ' +
      '--state-dir <dir> --socket-dir <dir> --out <dir> [--user <name> [--group <name>]]',
  );
  process.exit(2);
}

try {
  const outDir = path.resolve(flags.out);
  const files = prepareFiles({
    target: flags.target,
    service: flags.service,
    stateDir: path.resolve(flags['state-dir']),
    socketDir: path.resolve(flags['socket-dir']),
    outDir,
    root,
    nodePath: process.execPath,
    platform: process.platform,
    user: flags.user,
    group: flags.group,
  });
  for (const file of await writePrepared(outDir, files)) console.log(`wrote ${file}`);
  console.log(
    'Nothing was installed or started. The owner-approved rollout creates the state and socket directories (0700, ' +
      'owned by the service user), places the service file and starts the supervisor.',
  );
} catch (error) {
  if (error instanceof PrepareError) console.error(`refused: ${error.message}`);
  else if (error instanceof AdministrationSetupError) console.error(`refused: ${error.reason}`);
  else console.error('failed');
  process.exit(1);
}
