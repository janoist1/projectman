// The administration supervisor process (PM-763; docs/SECURITY.md "Administration adapter").
//
//   node --import tsx scripts/administration/supervisor.ts <absolute path of the supervisor config file>
//
// It takes nothing from the environment and nothing else from the command line: the target, the service it may
// restart, its state directory and its socket are all in the protected configuration file that
// `npm run administration -- prepare` wrote. Stop it with SIGTERM or Ctrl-C. Exit status: 0 stopped, 1 refused
// to start (the reason is printed without any path content of the file), 2 wrong usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdministrationSetupError, startSupervisor } from '../../apps/server/src/administration';
import { resolveAppVersion } from '../../apps/server/src/engine-link/version';

const installDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const [configFile, ...rest] = process.argv.slice(2);
if (!configFile || rest.length > 0 || !path.isAbsolute(configFile)) {
  console.error('usage: supervisor.ts <absolute path of the supervisor config file>');
  process.exit(2);
}

try {
  // The commit this checkout runs from, like the hub and the engine report; no environment override is read.
  const running = await startSupervisor({ configFile, version: await resolveAppVersion(installDir) });
  console.log(`administration supervisor for ${running.config.target.kind} listening`);
  const stop = () => {
    void running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (error) {
  if (error instanceof AdministrationSetupError)
    console.error(`administration supervisor refused to start: ${error.reason}`);
  else console.error('administration supervisor failed to start');
  process.exit(1);
}
