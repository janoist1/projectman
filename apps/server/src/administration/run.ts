import { loadSupervisorConfig } from './config';
import type { SupervisorConfig } from './schemas';
import { createServiceController } from './service-control';
import type { RunCommand } from './service-control';
import { startSocketServer } from './socket-server';
import { createDiagnosticsJournal, createOperationStore } from './store';
import { createSupervisor } from './supervisor';
import type { Supervisor } from './supervisor';
import type { AdministrationExecutors } from '../contracts';

/**
 * The supervisor process (PM-763): what `scripts/administration/supervisor.ts` runs on the hub host and on
 * the engine machine. It reads only its protected configuration file, builds the one controller that file
 * names, re-checks what a previous run left unfinished and then listens on the socket. It reads no
 * environment variable and takes no argument but the configuration path; the business executors (full test,
 * image build, deploy) are provided by the installation that has them (PM-764), none by default.
 */

export interface StartSupervisorOptions {
  configFile: string;
  platform?: NodeJS.Platform;
  /** The service manager runner; the real `execFile` one when omitted. */
  run?: RunCommand;
  executors?: AdministrationExecutors;
  version?: string | null;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  restartTimeoutMs?: number;
  pollMs?: number;
}

export interface RunningSupervisor {
  readonly config: SupervisorConfig;
  readonly supervisor: Supervisor;
  /** Stops listening, lets the running operation come to an end and closes. */
  close(): Promise<void>;
}

export async function startSupervisor(options: StartSupervisorOptions): Promise<RunningSupervisor> {
  const config = await loadSupervisorConfig(options.configFile);
  const now = options.now ?? (() => new Date());
  const controller = createServiceController(config, options.platform ?? process.platform, {
    run: options.run,
  });
  const store = await createOperationStore(config.stateDir);
  const journal = await createDiagnosticsJournal(config.stateDir, now);
  const supervisor = createSupervisor({
    config,
    controller,
    store,
    journal,
    executors: options.executors,
    version: options.version ?? null,
    now,
    sleep: options.sleep,
    restartTimeoutMs: options.restartTimeoutMs,
    pollMs: options.pollMs,
  });
  await journal.append('supervisor_started');
  if (!controller) await journal.append('service_probe_failed', { outcome: 'service_manager_mismatch' });
  await supervisor.recover();
  const server = await startSocketServer({ socketPath: config.socketPath, port: supervisor });
  return {
    config,
    supervisor,
    async close() {
      await server.close();
      await supervisor.close();
    },
  };
}
