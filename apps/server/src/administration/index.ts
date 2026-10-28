/**
 * The protected administration adapter (PM-763). `createAdministrationService` is what the hub uses; the
 * supervisor parts (`createSupervisor`, the socket server, the store, the service controllers and the config
 * loader) run in the separate supervisor process (`scripts/administration`); the socket client is what the hub
 * and an engine use to reach the supervisor of their own machine.
 */
export { loadSupervisorConfig, expectedServiceKind } from './config';
export { administrationRefusal, isErrorCode } from './errors';
export { SOCKET_PATH_MAX, SocketParams, SocketValues, SupervisorConfig } from './schemas';
export { createBuilderExecutors } from './executors';
export type { BuilderToolbox } from './executors';
export { startSupervisor } from './run';
export { AdministrationSetupError, ensurePrivateDir, writeFileAtomic } from './secure-fs';
export { createAdministrationService } from './service';
export type { EngineAdministration } from './service';
export { createSocketClient } from './socket-client';
