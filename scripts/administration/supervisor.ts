// The administration supervisor process (PM-763; docs/SECURITY.md "Administration adapter").
//
//   node --import tsx scripts/administration/supervisor.ts <absolute path of the supervisor config file>
//
// The target, the service it may restart, the app home, the state directory and the socket all come from the
// protected configuration file written by `npm run administration -- prepare`. Stop it with SIGTERM or Ctrl-C.
// Exit status: 0 stopped, 1 refused to start (the reason is printed without path content), 2 wrong usage.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AdministrationSetupError,
  loadSupervisorConfig,
  startSupervisor,
} from '../../apps/server/src/administration';
import { resolveAppVersion } from '../../apps/server/src/engine-link/version';
import { builderExecutors } from './builder';

const installDir = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const [configFile, ...rest] = process.argv.slice(2);
if (!configFile || rest.length > 0 || !path.isAbsolute(configFile)) {
  console.error('usage: supervisor.ts <absolute path of the supervisor config file>');
  process.exit(2);
}

try {
  // The commit this checkout runs from, like the hub and the engine report; no environment override is read.
  // The full test and the image build exist only where the configuration names a builder (PM-764); a deploy is
  // never installed here: the release watcher of the admin host carries out an approved release.
  const config = await loadSupervisorConfig(configFile);
  const executors = builderExecutors(
    config.builder ? { ...config.builder, appHome: config.appHome! } : undefined,
  );
  const running = await startSupervisor({
    configFile,
    version: await resolveAppVersion(installDir),
    ...(executors ? { executors } : {}),
  });
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
