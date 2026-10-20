/**
 * The protected administration adapter (PM-763). `createAdministrationService` is what the hub uses; the
 * supervisor parts (`createSupervisor`, the socket server, the store, the service controllers and the config
 * loader) run in the separate supervisor process (`scripts/administration`); the socket client is what the hub
 * and an engine use to reach the supervisor of their own machine.
 */
export { loadSupervisorConfig, expectedServiceKind } from './config';
export { administrationRefusal, isErrorCode } from './errors';
export {
  AdministrationAccepted,
  AdministrationCommandSchema,
  AdministrationJobSchema,
  AdministrationMachineSnapshotSchema,
  AdministrationRequestId,
  AdministrationResultSchema,
  AdministrationStatusSchema,
  AdministrationSubmitSchema,
  AdministrationTargetSchema,
  DiagnosticLogsSchema,
  LogsLimit,
  OperationId,
  SOCKET_PATH_MAX,
  SocketParams,
  SocketValues,
  SupervisorConfig,
} from './schemas';
export { createBuilderExecutors, FULL_TEST_COMMANDS } from './executors';
export type { BuilderImage, BuilderTestRun, BuilderToolbox } from './executors';
export { startSupervisor } from './run';
export type { RunningSupervisor, StartSupervisorOptions } from './run';
export { AdministrationSetupError, ensurePrivateDir, writeFileAtomic } from './secure-fs';
export { createAdministrationService } from './service';
export type { AdministrationService, AdministrationServiceOptions, EngineAdministration } from './service';
export { createServiceController, runCommand } from './service-control';
export type { RunCommand, RunResult, ServiceController, ServiceProbe } from './service-control';
export { createSocketClient } from './socket-client';
export { startSocketServer } from './socket-server';
export type { SocketServer } from './socket-server';
export { createSupervisor } from './supervisor';
export type { Supervisor, SupervisorDeps } from './supervisor';
export { createDiagnosticsJournal, createOperationStore } from './store';
export type { DiagnosticsJournal, OperationStore } from './store';
